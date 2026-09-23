import { describe, it, expect, jest } from '@jest/globals';
import type { Logger } from 'pino';
import { ClientView } from '../../src/proxy/client-view.js';
import type { BackendPool } from '../../src/mcp/backend-pool.js';
import type { ModelRegistry } from '../../src/models/model-registry.js';

describe('ClientView', () => {
  it('settles when its backends cannot be applied, logs why, and still watches the config', async () => {
    const logger = { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() } as unknown as Logger;
    const watch = jest.fn();
    const release = jest.fn();
    let confirmer: (() => unknown) | undefined;
    const pool = {
      client: (_context: unknown, options: { authConfirmer: () => unknown }) => {
        confirmer = options.authConfirmer;
        return {
          apply: async () => Promise.reject(new Error('reconcile failed')),
          watch,
          release,
          getExcludePatterns: () => [],
          getConfiguredServerNames: () => [],
        };
      },
    } as unknown as BackendPool;
    const authConfirmer = jest.fn((_config: unknown) => undefined);
    const models = { authConfirmer } as unknown as ModelRegistry;
    const config = { servers: [], excludePatterns: [], noCompressPatterns: [], model: { provider: 'needle' as const } };

    const view = new ClientView(pool, models, logger, { id: 'x', cwd: '/p', env: {} }, { loadConfig: () => config });
    await view.ready;

    expect(logger.error).toHaveBeenCalledWith(expect.anything(), 'Error during backend server initialization');
    expect(watch).toHaveBeenCalled();
    expect(view.cwd).toBe('/p');
    confirmer?.();
    expect(authConfirmer).toHaveBeenCalledWith({ provider: 'needle' });
    view.close();
    expect(release).toHaveBeenCalled();
  });
});
