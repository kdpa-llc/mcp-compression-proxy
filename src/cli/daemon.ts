#!/usr/bin/env node

import net from 'net';
import fs from 'fs';
import path from 'path';
import pino from 'pino';
import { fileURLToPath } from 'url';
import { CompressionCache } from '../services/compression-cache.js';
import { createConfigLoader } from '../config/loader.js';
import { PayloadStore } from './payload-interceptor.js';
import type { IPCRequest, IPCResponse } from '../types/index.js';
import { getDaemonRuntimePaths } from './runtime-paths.js';
import { BackendPool } from '../mcp/backend-pool.js';
import { ModelRegistry } from '../models/model-registry.js';
import type { ProxyServices } from '../proxy/view.js';
import { SessionHost } from '../daemon/session-host.js';
import { CliRequests, CliViews, cliViewFactory } from '../daemon/cli-requests.js';
import { claimPidFile } from '../daemon/launcher.js';
import { isAttachRequest, readLine, stringEnv } from '../daemon/protocol.js';
import { VERSION } from '../version.js';

const RUNTIME_PATHS = getDaemonRuntimePaths();
const {
  baseDir: BASE_DIR,
  socketPath: SOCKET_PATH,
  pidFile: PID_FILE,
  readyFile: READY_FILE,
  logFile: LOG_FILE,
  payloadDir: PAYLOAD_DIR,
  releaseId: RELEASE_ID,
} = RUNTIME_PATHS;

export function getSocketPath(): string {
  return SOCKET_PATH;
}

export function getPidFilePath(): string {
  return PID_FILE;
}

/**
 * Start the daemon.
 *
 * One process serves every client: mcp-cli commands, answered from the
 * configuration of the shell each came from, and MCP sessions attached by
 * proxies running with backendMode "daemon". All of them share one pool of
 * backend connections, one compression cache and one set of local models.
 */
async function startDaemon(): Promise<void> {
  // Ensure base directory exists. 0700 rather than the umask default: the
  // control socket in here accepts commands that run downstream MCP tools,
  // and attached clients send their environment, so it must not be reachable
  // by other local users.
  fs.mkdirSync(BASE_DIR, { recursive: true, mode: 0o700 });
  // mkdirSync ignores `mode` when the directory already exists, so an
  // upgrade from a previous version still gets tightened.
  fs.chmodSync(BASE_DIR, 0o700);
  for (const runtimePath of [SOCKET_PATH, PID_FILE, READY_FILE, LOG_FILE]) {
    fs.mkdirSync(path.dirname(runtimePath), { recursive: true, mode: 0o700 });
  }

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

  // Two clients may start a daemon at the same moment; the PID file decides
  // which one runs. The other would otherwise take over the socket and strand
  // the first.
  if (!claimPidFile(PID_FILE)) {
    logger.info('Another daemon is already running; exiting');
    process.exit(0);
  }

  const startTime = Date.now();
  logger.info({ pid: process.pid, releaseId: RELEASE_ID, version: VERSION }, 'Daemon starting');

  const payloadStore = new PayloadStore({ directory: PAYLOAD_DIR, removeDirectoryOnDestroy: false });
  const compressionCache = new CompressionCache(logger);
  try {
    await compressionCache.loadFromDisk();
  } catch (error) {
    logger.warn({ error }, 'Failed to load compression cache, continuing with empty cache');
  }
  const models = new ModelRegistry({
    // dist/cli/daemon.js -> <package>/python/needle_bridge.py
    bridgeScript: fileURLToPath(new URL('../../python/needle_bridge.py', import.meta.url)),
    stateDir: BASE_DIR,
    logger,
  });
  // Backends outlive a client by a minute, so one that reconnects - an MCP
  // client restarting, a CLI view expiring and coming back - finds them warm.
  const pool = new BackendPool(logger, { releaseGraceMs: 60_000 });
  const services: ProxyServices = {
    logger,
    payloadStore,
    compressionCache,
    models,
    usageLogFile: path.join(BASE_DIR, 'search-usage.jsonl'),
  };

  let lastActivity = Date.now();
  const touch = () => {
    lastActivity = Date.now();
  };
  let shuttingDown = false;
  const host = new SessionHost({
    version: VERSION,
    pool,
    models,
    services,
    onActivity: touch,
    onRetire: () => void shutdown('making way for another version'),
  });
  const views = new CliViews(cliViewFactory(pool, services, models));
  const cli = new CliRequests({
    views,
    services,
    fallbackContext: { cwd: process.cwd(), env: stringEnv(process.env) },
    status: () => {
      const servers = pool.statuses();
      return {
        running: true,
        pid: process.pid,
        releaseId: RELEASE_ID,
        version: VERSION,
        uptime: Math.floor((Date.now() - startTime) / 1000),
        servers,
        backends: servers,
        cachedToolCount: compressionCache.getCacheMetrics().totalCached,
        connectedServers: servers.filter((server) => server.connected).length,
        totalServers: servers.length,
        socketPath: SOCKET_PATH,
        sessions: host.status(),
        cliViews: views.size,
      };
    },
  });

  // We hold the PID file, so any socket left here belongs to a dead daemon.
  if (fs.existsSync(SOCKET_PATH)) {
    fs.unlinkSync(SOCKET_PATH);
  }

  /** Serve mcp-cli's newline-delimited requests, starting with one already read. */
  function serveRequests(socket: net.Socket, firstLine: string, rest: Buffer): void {
    let buffer = rest.toString('utf-8');
    const handleLine = (line: string) => {
      if (!line.trim()) return;
      let request: IPCRequest;
      try {
        request = JSON.parse(line) as IPCRequest;
      } catch {
        logger.error({ line: line.slice(0, 200) }, 'Failed to parse IPC request');
        return;
      }
      touch();
      cli
        .handle(request)
        .catch(
          (error): IPCResponse => ({
            id: request.id,
            error: { code: -1, message: error instanceof Error ? error.message : 'Unknown error' },
          })
        )
        .then((response) => {
          touch();
          if (!socket.destroyed) socket.write(JSON.stringify(response) + '\n');
        });
    };

    handleLine(firstLine);
    socket.on('data', (data) => {
      buffer += data.toString();
      let newline: number;
      while ((newline = buffer.indexOf('\n')) !== -1) {
        handleLine(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
      }
    });
    socket.resume();
  }

  const server = net.createServer((socket) => {
    socket.on('error', (error) => logger.debug({ error: error.message }, 'Socket error'));
    readLine(socket)
      .then(({ line, rest }) => {
        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch {
          parsed = undefined;
        }
        if (isAttachRequest(parsed)) {
          return host.attach(socket, parsed, rest);
        }
        serveRequests(socket, line, rest);
        return undefined;
      })
      .catch((error) => {
        logger.debug({ error: error instanceof Error ? error.message : error }, 'Connection ended early');
        socket.destroy();
      });
  });

  // Without this, a failed listen emits an unhandled 'error' event and kills
  // the daemon. Because it is spawned with stdio: 'ignore', the crash goes
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
    try {
      fs.unlinkSync(PID_FILE);
    } catch {
      /* ignore */
    }
    process.exit(1);
  });

  // Exit after a quiet period when asked to: a daemon the proxy started on its
  // own should not outlive its clients forever. Read once, at startup.
  const idleSeconds = Number(
    process.env.MCP_DAEMON_IDLE_TIMEOUT ?? createConfigLoader({})()?.cli?.daemonIdleTimeout ?? 0
  );
  if (Number.isFinite(idleSeconds) && idleSeconds > 0) {
    const idleMs = idleSeconds * 1000;
    const idleTimer = setInterval(() => {
      if (host.size === 0 && Date.now() - lastActivity >= idleMs) {
        void shutdown(`idle for ${idleSeconds}s`);
      }
    }, Math.min(60_000, Math.max(1000, idleMs / 4)));
    // Housekeeping must never be what keeps the process alive.
    idleTimer.unref();
  }

  server.listen(SOCKET_PATH, () => {
    logger.info({ socketPath: SOCKET_PATH, pid: process.pid }, 'Daemon listening');
    // Signal readiness by writing a ready marker
    fs.writeFileSync(READY_FILE, String(Date.now()), 'utf-8');
  });

  async function shutdown(reason: string): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ reason }, 'Daemon shutting down');

    server.close();
    try {
      await host.closeAll();
      views.closeAll();
      await pool.close();
      await models.closeAll();
      payloadStore.destroy();
    } catch (error) {
      logger.error({ error }, 'Error while shutting down');
    }
    for (const file of [SOCKET_PATH, PID_FILE, READY_FILE]) {
      try {
        fs.unlinkSync(file);
      } catch {
        /* ignore */
      }
    }
    logger.info('Daemon stopped');
    process.exit(0);
  }

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

// Entry point when run directly
startDaemon().catch((error) => {
  console.error('Failed to start daemon:', error);
  process.exit(1);
});
