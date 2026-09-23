#!/usr/bin/env node

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { fileURLToPath } from 'url';
import { join } from 'path';
import pino from 'pino';
import { BackendPool } from './mcp/backend-pool.js';
import { CompressionCache } from './services/compression-cache.js';
import { loadJSONServersCached } from './config/loader.js';
import { PayloadStore } from './cli/payload-interceptor.js';
import { getDaemonRuntimePaths } from './cli/runtime-paths.js';
import { isManagedRouterConfigured } from './cli/runtime-mode.js';
import { ModelRegistry } from './models/model-registry.js';
import { ProxySession } from './proxy/session.js';
import { ClientView } from './proxy/client-view.js';
import { lastGoodConfig } from './proxy/view.js';
import { connectToDaemon } from './daemon/connect.js';
import { launchDaemon } from './daemon/launcher.js';
import { stringEnv } from './daemon/protocol.js';
import { VERSION } from './version.js';

/**
 * MCP Server that aggregates tools from multiple MCP servers
 * with LLM-based description compression.
 *
 * Runs its backends itself ("local"), or attaches to the shared daemon
 * ("daemon") and relays stdio to the session the daemon runs for it. Either
 * way the session is src/proxy/session.ts.
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

/** A daemon the proxy starts itself exits after this long with no client. */
const DEFAULT_DAEMON_IDLE_SECONDS = '1800';

const runtimePaths = getDaemonRuntimePaths();
const config = lastGoodConfig(loadJSONServersCached, logger);

/**
 * Attach to the shared daemon, starting it if needed, and relay stdio to the
 * session it runs for this client. Resolves false when that is not possible,
 * with nothing read from stdin, so the local proxy can take over.
 */
async function runViaDaemon(): Promise<boolean> {
  const managed = isManagedRouterConfigured(runtimePaths.baseDir);
  const result = await connectToDaemon({
    socketPath: runtimePaths.socketPath,
    version: VERSION,
    cwd: process.cwd(),
    env: stringEnv(process.env),
    input: process.stdin,
    output: process.stdout,
    // The managed router owns the socket there; never start a daemon over it.
    launch: managed
      ? undefined
      : () =>
          launchDaemon({
            // dist/index.js -> dist/cli/daemon.js
            daemonScript: fileURLToPath(new URL('./cli/daemon.js', import.meta.url)),
            socketPath: runtimePaths.socketPath,
            env: {
              ...process.env,
              MCP_DAEMON_IDLE_TIMEOUT:
                process.env.MCP_DAEMON_IDLE_TIMEOUT ?? DEFAULT_DAEMON_IDLE_SECONDS,
            },
          }),
  });

  if (!result.attached) {
    logger.warn(
      { reason: result.reason, code: result.code },
      'Could not use the shared daemon; running backend servers in this process'
    );
    return false;
  }

  logger.info({ session: result.session }, 'Attached to the shared daemon');
  void result.closed.then(() => {
    logger.info('Daemon connection closed');
    process.exit(0);
  });
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => process.exit(0));
  }
  return true;
}

/** Run the backends in this process and serve one session over stdio. */
async function runLocal(): Promise<void> {
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
  if (!initial) {
    logger.warn(
      'No valid configuration found. Server will start with no backend MCP servers. Please create a servers.json file to add MCP servers.'
    );
  } else {
    const enabled = initial.servers.filter((server) => server.enabled !== false);
    logger.info(
      { total: initial.servers.length, enabled: enabled.length, servers: enabled.map((server) => server.name) },
      'Initializing backend MCP servers with timeout protection'
    );
  }

  // Connect backend servers BEFORE connecting to the client, so all tools are
  // available when it first asks. The view keeps following servers.json
  // afterwards - also when there was none yet at startup.
  const view = new ClientView(
    pool,
    models,
    logger,
    { id: 'local', cwd: process.cwd(), env: process.env },
    { catalogTtlMs: TOOL_CACHE_TTL_MS, loadConfig: loadJSONServersCached }
  );
  await view.ready;
  logger.info('Backend MCP servers initialization complete');

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
  session.warmSearch();

  /**
   * Shut down backend servers and exit.
   *
   * Without this the proxy leaves every spawned backend MCP server running
   * when its own client goes away, leaking a process tree per client restart.
   */
  let shuttingDown = false;
  const shutdown = async (reason: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ reason }, 'Shutting down');

    view.close();
    try {
      await pool.close();
    } catch (error) {
      logger.error({ error }, 'Error while disconnecting backend servers');
    }
    await session.close();
    payloadStore.destroy();
    await models.closeAll();
    process.exit(0);
  };

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

async function main() {
  logger.info('Starting MCP Compression Proxy Server');
  const mode = process.env.MCP_PROXY_BACKEND_MODE ?? config()?.backendMode ?? 'local';
  if (mode === 'daemon' && !process.argv.includes('--clear-cache') && (await runViaDaemon())) {
    return;
  }
  await runLocal();
}

main().catch((error) => {
  logger.error({ error }, 'Server failed to start');
  process.exit(1);
});
