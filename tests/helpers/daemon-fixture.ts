import { jest } from '@jest/globals';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { Logger } from 'pino';
import { PayloadStore } from '../../src/cli/payload-interceptor.js';
import { configHomeDirectory } from '../../src/config/home-directory.js';
import { BackendPool } from '../../src/mcp/backend-pool.js';
import type { LocalModel } from '../../src/models/local-model.js';
import { ModelRegistry } from '../../src/models/model-registry.js';
import type { ProxyServices } from '../../src/proxy/view.js';
import { CompressionCache } from '../../src/services/compression-cache.js';
import type { CompressionPersistence } from '../../src/services/compression-persistence.js';

export const MOCK_SERVER = join(process.cwd(), 'tests/__mocks__/multi-tool-server.js');

export function makeLogger(): Logger {
  return { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() } as unknown as Logger;
}

/**
 * A home and a project directory of their own, a servers.json in the project
 * naming the mock server, and daemon services over a real backend pool.
 * The loader's home lookup points at the temporary home while it lives, so a
 * developer's own ~/.mcp-compression-proxy is never read.
 */
export function daemonFixture(
  config: Record<string, unknown> = {
    mcpServers: [
      { name: 'mock', command: process.execPath, args: [MOCK_SERVER], env: { MOCK_TOOL_COUNT: '3' } },
    ],
  },
  options: { model?: LocalModel } = {}
) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'mcpd-')));
  const home = join(root, 'home');
  const project = join(root, 'project');
  mkdirSync(join(home, '.mcp-compression-proxy'), { recursive: true });
  mkdirSync(project, { recursive: true });
  writeFileSync(join(project, 'servers.json'), JSON.stringify(config));

  const previousHome = configHomeDirectory.get;
  configHomeDirectory.get = () => home;

  const logger = makeLogger();
  const persistence = {
    load: jest.fn(async () => new Map()),
    save: jest.fn(async () => undefined),
    clear: jest.fn(async () => undefined),
    getCacheFilePath: () => join(root, 'cache.json'),
  } as unknown as CompressionPersistence;
  const payloadStore = new PayloadStore({ directory: join(root, 'payloads') });
  const compressionCache = new CompressionCache(logger, persistence);
  const models = new ModelRegistry({
    bridgeScript: 'unused.py',
    stateDir: root,
    logger,
    create: () => options.model,
  });
  const pool = new BackendPool(logger, { releaseGraceMs: 0 });
  const services: ProxyServices = {
    logger,
    payloadStore,
    compressionCache,
    models,
    usageLogFile: join(root, 'usage.jsonl'),
  };
  const env = { PATH: process.env.PATH ?? '', HOME: home };

  return {
    root,
    home,
    project,
    logger,
    persistence,
    payloadStore,
    compressionCache,
    models,
    pool,
    services,
    env,
    /** A socket path short enough for sun_path on every platform. */
    socketPath: join(root, 'd.sock'),
    writeConfig(next: Record<string, unknown>) {
      writeFileSync(join(project, 'servers.json'), JSON.stringify(next));
    },
    async cleanup() {
      await pool.close();
      payloadStore.destroy();
      configHomeDirectory.get = previousHome;
      rmSync(root, { recursive: true, force: true });
    },
  };
}
