#!/usr/bin/env node

import net from 'net';
import fs from 'fs';
import path from 'path';
import { homedir } from 'os';
import pino from 'pino';
import { MCPClientManager } from '../mcp/client-manager.js';
import { CompressionCache } from '../services/compression-cache.js';
import { SessionManager } from '../services/session-manager.js';
import { StatsService } from '../services/stats-service.js';
import { loadJSONServers, matchesIgnorePattern } from '../config/loader.js';
import { interceptPayload } from './payload-interceptor.js';
import type { IPCRequest, IPCResponse, CLIConfig } from '../types/index.js';

const BASE_DIR = path.join(homedir(), '.mcp-compression-proxy');
const SOCKET_PATH = path.join(BASE_DIR, 'daemon.sock');
const PID_FILE = path.join(BASE_DIR, 'daemon.pid');
const LOG_FILE = path.join(BASE_DIR, 'daemon.log');

export function getSocketPath(): string {
  return SOCKET_PATH;
}

export function getPidFilePath(): string {
  return PID_FILE;
}

/**
 * Start the MCP CLI daemon process.
 * Maintains warm connections to all backend MCP servers
 * and handles IPC requests from the CLI client.
 */
async function startDaemon(): Promise<void> {
  // Ensure base directory exists. 0700 rather than the umask default: the
  // control socket in here accepts commands that run downstream MCP tools,
  // so it should not be reachable by other local users.
  fs.mkdirSync(BASE_DIR, { recursive: true, mode: 0o700 });
  // mkdirSync ignores `mode` when the directory already exists, so an
  // upgrade from a previous version still gets tightened.
  fs.chmodSync(BASE_DIR, 0o700);

  const logger = pino({
    name: 'mcp-cli-daemon',
    level: process.env.LOG_LEVEL || 'info',
    transport: {
      target: 'pino-pretty',
      options: {
        colorize: false,
        translateTime: 'HH:MM:ss Z',
        ignore: 'pid,hostname',
        destination: LOG_FILE,
        mkdir: true,
      },
    },
  });

  const startTime = Date.now();

  logger.info({ pid: process.pid }, 'Daemon starting');

  // Write PID file
  fs.writeFileSync(PID_FILE, String(process.pid), 'utf-8');

  // Initialize services (reusing existing components)
  const clientManager = new MCPClientManager(logger);
  const compressionCache = new CompressionCache(logger);
  const sessionManager = new SessionManager(logger);
  const statsService = new StatsService(
    logger,
    clientManager,
    compressionCache,
    sessionManager
  );

  // Load compression cache from disk
  try {
    await compressionCache.loadFromDisk();
  } catch (error) {
    logger.warn({ error }, 'Failed to load compression cache, continuing with empty cache');
  }

  // Load config and initialize backend MCP servers
  const config = loadJSONServers();
  let cliConfig: CLIConfig = {};

  if (config) {
    compressionCache.setNoCompressPatterns(config.noCompressPatterns);

    // Parse CLI config if present (cast to access extra fields)
    const rawConfig = config as Record<string, unknown>;
    if (rawConfig.cli && typeof rawConfig.cli === 'object') {
      cliConfig = rawConfig.cli as CLIConfig;
    }

    const enabledServers = config.servers.filter(s => s.enabled !== false);
    logger.info(
      { total: config.servers.length, enabled: enabledServers.length },
      'Initializing backend MCP servers'
    );

    try {
      await clientManager.initializeServers(enabledServers, config.defaultTimeout);
      logger.info('Backend MCP servers initialization complete');
    } catch (error) {
      logger.error({ error }, 'Error during backend server initialization');
    }
  } else {
    logger.warn('No configuration found. Daemon started with no backend servers.');
  }

  // Clean up stale socket file if it exists
  if (fs.existsSync(SOCKET_PATH)) {
    fs.unlinkSync(SOCKET_PATH);
  }

  // Handle IPC request
  async function handleRequest(request: IPCRequest): Promise<IPCResponse> {
    const { id, method, params } = request;
    const excludePatterns = config?.excludePatterns || [];

    try {
      switch (method) {
        case 'tools': {
          const clients = clientManager.getConnectedClients();
          const toolEntries: Array<{ server: string; tool: string; description: string }> = [];

          for (const { name, client } of clients) {
            try {
              const result = await client.listTools();
              for (const tool of result.tools) {
                const fullName = `${name}__${tool.name}`;
                if (matchesIgnorePattern(fullName, excludePatterns)) continue;

                const desc = compressionCache.getCompressedDescription(name, tool.name)
                  || tool.description
                  || '';
                // Truncate to ~60 chars for compact listing
                const shortDesc = desc.length > 60 ? desc.slice(0, 57) + '...' : desc;
                toolEntries.push({ server: name, tool: tool.name, description: shortDesc });
              }
            } catch (error) {
              logger.error({ server: name, error }, 'Failed to list tools');
            }
          }

          return { id, result: { tools: toolEntries, count: toolEntries.length } };
        }

        case 'search': {
          const query = String(params?.query || '').toLowerCase();
          const clients = clientManager.getConnectedClients();
          const matches: Array<{ server: string; tool: string; description: string }> = [];

          for (const { name, client } of clients) {
            try {
              const result = await client.listTools();
              for (const tool of result.tools) {
                const fullName = `${name}__${tool.name}`;
                if (matchesIgnorePattern(fullName, excludePatterns)) continue;

                const desc = compressionCache.getCompressedDescription(name, tool.name)
                  || tool.description
                  || '';
                const searchText = `${name}/${tool.name} ${desc}`.toLowerCase();

                if (searchText.includes(query)) {
                  const shortDesc = desc.length > 60 ? desc.slice(0, 57) + '...' : desc;
                  matches.push({ server: name, tool: tool.name, description: shortDesc });
                }
              }
            } catch (error) {
              logger.error({ server: name, error }, 'Failed to list tools for search');
            }
          }

          return { id, result: { tools: matches, count: matches.length } };
        }

        case 'info': {
          const serverName = String(params?.server || '');
          const toolName = String(params?.tool || '');

          const client = clientManager.getClient(serverName);
          if (!client) {
            return { id, error: { code: -1, message: `Server '${serverName}' not found or not connected` } };
          }

          try {
            const result = await client.listTools();
            const tool = result.tools.find(t => t.name === toolName);
            if (!tool) {
              return { id, error: { code: -1, message: `Tool '${toolName}' not found on server '${serverName}'` } };
            }

            return {
              id,
              result: {
                name: tool.name,
                server: serverName,
                description: tool.description || '',
                inputSchema: tool.inputSchema,
              },
            };
          } catch (error) {
            const msg = error instanceof Error ? error.message : 'Unknown error';
            return { id, error: { code: -1, message: msg } };
          }
        }

        case 'call': {
          const serverName = String(params?.server || '');
          const toolName = String(params?.tool || '');
          const args = (params?.arguments || {}) as Record<string, unknown>;
          const threshold = cliConfig.payloadThreshold ?? 500;

          const client = clientManager.getClient(serverName);
          if (!client) {
            return { id, error: { code: -1, message: `Server '${serverName}' not found or not connected` } };
          }

          try {
            const result = await client.callTool({ name: toolName, arguments: args });
            const content = result.content as Array<{ type: string; text?: string }>;

            // Extract text content
            const textParts = content
              .filter(c => c.type === 'text' && c.text)
              .map(c => c.text!);
            const fullOutput = textParts.join('\n');

            // Apply payload interception
            const output = interceptPayload(fullOutput, threshold);

            return { id, result: { output, isError: result.isError } };
          } catch (error) {
            const msg = error instanceof Error ? error.message : 'Unknown error';
            return { id, error: { code: -1, message: msg } };
          }
        }

        case 'stats': {
          const stats = await statsService.getStats({
            serverName: params?.serverName as string | undefined,
            detailLevel: (params?.detailLevel as 'summary' | 'full') || 'summary',
          });
          return { id, result: stats };
        }

        case 'daemon-status': {
          const statuses = clientManager.getServerStatuses();
          const connectedCount = statuses.filter(s => s.connected).length;
          const cacheMetrics = compressionCache.getCacheMetrics();

          return {
            id,
            result: {
              running: true,
              pid: process.pid,
              uptime: Math.floor((Date.now() - startTime) / 1000),
              servers: statuses,
              toolCount: cacheMetrics.totalCached,
              compressedCount: cacheMetrics.totalCached,
              connectedServers: connectedCount,
              totalServers: statuses.length,
              socketPath: SOCKET_PATH,
            },
          };
        }

        default:
          return { id, error: { code: -1, message: `Unknown method: ${method}` } };
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Unknown error';
      logger.error({ method, error: msg }, 'Request handler error');
      return { id, error: { code: -1, message: msg } };
    }
  }

  // Create Unix domain socket server
  const server = net.createServer((socket) => {
    let buffer = '';

    socket.on('data', (data) => {
      buffer += data.toString();

      // Process newline-delimited JSON
      let newlineIndex: number;
      while ((newlineIndex = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newlineIndex);
        buffer = buffer.slice(newlineIndex + 1);

        if (!line.trim()) continue;

        try {
          const request: IPCRequest = JSON.parse(line);
          handleRequest(request)
            .then((response) => {
              socket.write(JSON.stringify(response) + '\n');
            })
            .catch((error) => {
              const errResponse: IPCResponse = {
                id: request.id,
                error: { code: -1, message: error instanceof Error ? error.message : 'Unknown error' },
              };
              socket.write(JSON.stringify(errResponse) + '\n');
            });
        } catch {
          logger.error({ line }, 'Failed to parse IPC request');
        }
      }
    });

    socket.on('error', (error) => {
      logger.debug({ error: error.message }, 'Socket error');
    });
  });

  // Without this, a failed listen emits an unhandled 'error' event and kills
  // the daemon. Because it is forked with stdio: 'ignore', the crash goes
  // nowhere: the log simply stops mid-startup and the CLI reports only
  // "Failed to start daemon." Log the cause and leave no stale PID behind.
  server.on('error', (error: NodeJS.ErrnoException) => {
    let hint = '';
    if (error.code === 'EADDRINUSE') {
      hint = ' Another daemon may already be running; try "mcp-cli daemon stop".';
    } else if (error.code === 'EACCES') {
      hint = ` Check permissions on ${BASE_DIR}.`;
    } else if (SOCKET_PATH.length > 100) {
      // Unix domain socket paths are capped near 107 bytes on Linux/macOS.
      hint = ` The socket path is ${SOCKET_PATH.length} characters, which likely exceeds the ~107 byte limit for Unix sockets.`;
    }

    logger.error(
      { socketPath: SOCKET_PATH, code: error.code, error: error.message },
      `Failed to listen on the daemon socket.${hint}`
    );

    try { fs.unlinkSync(PID_FILE); } catch { /* ignore */ }
    process.exit(1);
  });

  server.listen(SOCKET_PATH, () => {
    logger.info({ socketPath: SOCKET_PATH, pid: process.pid }, 'Daemon listening');

    // Signal readiness by writing a ready marker
    const readyFile = path.join(BASE_DIR, 'daemon.ready');
    fs.writeFileSync(readyFile, String(Date.now()), 'utf-8');
  });

  // Graceful shutdown
  function shutdown() {
    logger.info('Daemon shutting down');

    server.close();
    clientManager.disconnectAll().then(() => {
      sessionManager.destroy();

      // Clean up files
      try { fs.unlinkSync(SOCKET_PATH); } catch { /* ignore */ }
      try { fs.unlinkSync(PID_FILE); } catch { /* ignore */ }
      try { fs.unlinkSync(path.join(BASE_DIR, 'daemon.ready')); } catch { /* ignore */ }

      logger.info('Daemon stopped');
      process.exit(0);
    }).catch(() => {
      process.exit(1);
    });
  }

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

// Entry point when run directly
startDaemon().catch((error) => {
  console.error('Failed to start daemon:', error);
  process.exit(1);
});
