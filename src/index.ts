#!/usr/bin/env node

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { fileURLToPath } from 'url';
import { join } from 'path';
import pino from 'pino';
import { BackendPool } from './mcp/backend-pool.js';
import { ToolCatalog } from './mcp/tool-catalog.js';
import { CompressionCache } from './services/compression-cache.js';
import { loadJSONServersCached } from './config/loader.js';
import { PayloadStore } from './cli/payload-interceptor.js';
import { getDaemonRuntimePaths } from './cli/runtime-paths.js';
import { ModelRegistry } from './models/model-registry.js';
import { ProxySession } from './proxy/session.js';
import { lastGoodConfig, type ProxyView } from './proxy/view.js';

/**
 * MCP Server that aggregates tools from multiple MCP servers
 * with LLM-based description compression.
 *
 * This entry point wires one session to stdio; everything a session does lives
 * in src/proxy/session.ts.
 */

const logger = pino({
  name: 'mcp-compression-proxy',
  level: process.env.LOG_LEVEL || 'info',
  transport: {
    target: 'pino-pretty',
    options: {
      colorize: false,
      translateTime: 'HH:MM:ss Z',
      ignore: 'pid,hostname',
      destination: 2, // Forces output to stderr (FD 2) to keep stdout clean for MCP JSON-RPC
    },
  },
});

/**
 * How long a backend tool snapshot stays reusable.
 *
 * `tools/list` runs on every client refresh and the compression tools each
 * trigger their own fan-out, so without this a single agent turn can issue
 * several `listTools` round-trips per backend. Short enough that a genuinely
 * changed backend surfaces almost immediately.
 */
const TOOL_CACHE_TTL_MS = 3000;

const runtimePaths = getDaemonRuntimePaths();
// One client, so nothing to share and no reason to keep a dropped server up.
const pool = new BackendPool(logger, { releaseGraceMs: 0 });
const payloadStore = new PayloadStore({
  directory: runtimePaths.payloadDir,
  removeDirectoryOnDestroy: false,
});
const compressionCache = new CompressionCache(logger);
const models = new ModelRegistry({
  // dist/index.js -> <package>/python/needle_bridge.py
  bridgeScript: fileURLToPath(new URL('../python/needle_bridge.py', import.meta.url)),
  stateDir: runtimePaths.baseDir,
  logger,
});
const config = lastGoodConfig(loadJSONServersCached, logger);
const backends = pool.client(
  { id: 'local', cwd: process.cwd(), env: process.env },
  { authConfirmer: () => models.authConfirmer(config()?.model) }
);
const view: ProxyView = {
  config,
  backends,
  catalog: new ToolCatalog(backends, logger, TOOL_CACHE_TTL_MS),
  cwd: process.cwd(),
};
const session = new ProxySession(
  view,
  {
    logger,
    payloadStore,
    compressionCache,
    models,
    usageLogFile: join(runtimePaths.baseDir, 'search-usage.jsonl'),
  },
  { toolsPageSize: Number.parseInt(process.env.MCP_TOOLS_PAGE_SIZE ?? '', 10) }
);

/**
 * Shut down backend servers and exit.
 *
 * Without this the proxy leaves every spawned backend MCP server running when
 * its own client goes away, leaking a process tree per client restart.
 */
let shuttingDown = false;
async function shutdown(reason: string, exitCode = 0): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;

  logger.info({ reason }, 'Shutting down');

  backends.release();
  try {
    await pool.close();
  } catch (error) {
    logger.error({ error }, 'Error while disconnecting backend servers');
  }

  await session.close();
  payloadStore.destroy();
  await models.closeAll();

  process.exit(exitCode);
}

async function main() {
  logger.info('Starting MCP Compression Proxy Server');

  if (process.argv.slice(2).includes('--clear-cache')) {
    logger.info('Clearing compression cache...');
    await compressionCache.clearAll();
    logger.info('Cache cleared successfully');
    process.exit(0);
  }

  try {
    await compressionCache.loadFromDisk();
  } catch (error) {
    logger.warn({ error }, 'Failed to load cache, continuing with empty cache');
  }

  const initial = config();

  // Connect backend MCP servers BEFORE connecting to the client, so all tools
  // are available when it first asks.
  if (!initial) {
    logger.warn(
      'No valid configuration found. Server will start with no backend MCP servers. Please create a servers.json file to add MCP servers.'
    );
  } else {
    const enabledServers = initial.servers.filter((server) => server.enabled !== false);
    logger.info(
      {
        total: initial.servers.length,
        enabled: enabledServers.length,
        servers: enabledServers.map((server) => server.name),
      },
      'Initializing backend MCP servers with timeout protection'
    );
  }
  try {
    await backends.apply(initial);
    logger.info('Backend MCP servers initialization complete');
  } catch (error) {
    logger.error({ error }, 'Error during backend server initialization');
  }
  session.warmSearch();

  // Also when there was no config yet: a user who writes their first
  // servers.json after starting the proxy gets their servers without
  // restarting the MCP client.
  backends.watch(config);

  // When the client disconnects, take the backend servers down with us.
  session.server.onclose = () => {
    void shutdown('client disconnected');
  };

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      void shutdown(signal);
    });
  }

  await session.connect(new StdioServerTransport());
  logger.info('MCP Compression Proxy Server ready and connected to stdio');
}

main().catch((error) => {
  logger.error({ error }, 'Server failed to start');
  process.exit(1);
});
