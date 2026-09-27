import { describe, it, expect, jest } from '@jest/globals';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { Logger } from 'pino';
import type { ConfigResult } from '../../src/config/loader.js';
import { BackendPool } from '../../src/mcp/backend-pool.js';
import type { MCPClientManager, ManagedClientContext } from '../../src/mcp/client-manager.js';
import { ToolCatalog } from '../../src/mcp/tool-catalog.js';
import type { MCPServerConfig } from '../../src/types/index.js';

const logger = {
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
} as unknown as Logger;
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function tool(version: string, readOnlyHint = true): Tool {
  return {
    name: 'read',
    title: version,
    description: `description ${version}`,
    inputSchema: { type: 'object', properties: { [version]: { type: 'string' } } },
    annotations: { readOnlyHint },
  };
}
const server = (version: string, name = 'docs'): MCPServerConfig => ({
  name,
  url: `https://${version}.invalid/mcp`,
});
function config(
  servers: MCPServerConfig[],
  excludePatterns: string[] = []
): NonNullable<ConfigResult> {
  return { servers, excludePatterns, noCompressPatterns: [] };
}
function fixture() {
  let current: MCPServerConfig[] = [];
  let reconcileWait: Promise<void> | undefined;
  const lists = new Map<string, jest.Mock<() => Promise<{ tools: Tool[] }>>>();
  for (const version of ['old', 'new', 'extra'])
    lists.set(
      version,
      jest
        .fn<() => Promise<{ tools: Tool[] }>>()
        .mockResolvedValue({ tools: [tool(version, version !== 'new')] })
    );
  const manager = {
    reconcile: jest.fn(async (servers: MCPServerConfig[]) => {
      await reconcileWait;
      current = servers;
    }),
    withClient: jest.fn(
      async (name: string, operation: (context: ManagedClientContext) => Promise<unknown>) => {
        const entry = current.find((s) => s.name === name);
        if (!entry) throw new Error(`Unconfigured ${name}`);
        const version = new URL(entry.url!).hostname.split('.')[0];
        return operation({
          client: { listTools: lists.get(version) } as unknown as Client,
          generation: 1,
          markFailure: () => undefined,
          invalidate: () => undefined,
        });
      }
    ),
    disconnectAll: jest.fn(async () => undefined),
  };
  const pool = new BackendPool(logger, { manager: manager as unknown as MCPClientManager });
  const make = (id: string) => {
    const access = pool.client({ id, cwd: '/catalog-fixture', env: {} });
    return { access, catalog: new ToolCatalog(access, logger, 60_000) };
  };
  return {
    pool,
    make,
    lists,
    manager,
    waitForReconcile: (wait: Promise<void> | undefined) => {
      reconcileWait = wait;
    },
  };
}

describe('catalog freshness across backend configuration changes', () => {
  it('refreshes same-name schema, title, description and readOnlyHint while another client keeps its snapshot', async () => {
    const f = fixture();
    const a = f.make('a');
    const b = f.make('b');
    await a.access.apply(config([server('old')]));
    await b.access.apply(config([server('old')]));
    const original = await a.catalog.list();
    const other = await b.catalog.list();
    await a.access.apply(config([server('new')]));
    expect(await a.catalog.find('docs', 'read')).toEqual({
      serverName: 'docs',
      toolName: 'read',
      title: 'new',
      description: 'description new',
      inputSchema: tool('new').inputSchema,
      annotations: { readOnlyHint: false },
    });
    expect(await b.catalog.list()).toBe(other);
    expect(original[0].title).toBe('old');
    await f.pool.close();
  });

  it('reuses cached and in-flight work after an identical configuration is reapplied', async () => {
    const f = fixture();
    const a = f.make('a');
    await a.access.apply(config([server('old')]));
    const delayed = deferred<{ tools: Tool[] }>();
    f.lists.get('old')!.mockReturnValueOnce(delayed.promise);
    const first = a.catalog.list();
    await a.access.apply(config([server('old')]));
    const second = a.catalog.list();
    delayed.resolve({ tools: [tool('old')] });
    const [one, two] = await Promise.all([first, second]);
    expect(one).toBe(two);
    await a.access.apply(config([server('old')]));
    expect(await a.catalog.list()).toBe(one);
    expect(f.lists.get('old')).toHaveBeenCalledTimes(1);
    await f.pool.close();
  });

  it('drops removed backends and includes newly added backends immediately', async () => {
    const f = fixture();
    const a = f.make('a');
    await a.access.apply(config([server('old')]));
    await a.catalog.list();
    await a.access.apply(config([server('extra', 'other')]));
    expect((await a.catalog.list()).map((t) => [t.serverName, t.title])).toEqual([
      ['other', 'extra'],
    ]);
    expect(await a.catalog.find('docs', 'read')).toBeUndefined();
    await f.pool.close();
  });

  it('does not return or cache an old in-flight completion after the replacement listing finishes', async () => {
    const f = fixture();
    const a = f.make('a');
    await a.access.apply(config([server('old')]));
    const started = deferred<void>();
    const delayed = deferred<{ tools: Tool[] }>();
    f.lists.get('old')!.mockImplementationOnce(() => {
      started.resolve();
      return delayed.promise;
    });
    const first = a.catalog.list();
    await started.promise;
    await a.access.apply(config([server('new')]));
    const current = await a.catalog.list();
    delayed.resolve({ tools: [tool('old')] });
    expect((await first)[0].title).toBe('new');
    expect(await a.catalog.list()).toBe(current);
    expect(f.lists.get('new')).toHaveBeenCalledTimes(1);
    await f.pool.close();
  });

  it('rejects an old A snapshot after an A to B to A configuration sequence', async () => {
    const f = fixture();
    const a = f.make('a');
    await a.access.apply(config([server('old')]));
    const started = deferred<void>();
    const delayed = deferred<{ tools: Tool[] }>();
    f.lists
      .get('old')!
      .mockImplementationOnce(() => {
        started.resolve();
        return delayed.promise;
      })
      .mockResolvedValue({ tools: [tool('refreshed A')] });
    const first = a.catalog.list();
    await started.promise;
    await a.access.apply(config([server('new')]));
    await a.access.apply(config([server('old')]));
    delayed.resolve({ tools: [tool('stale A')] });
    expect((await first)[0].title).toBe('refreshed A');
    expect((await a.catalog.list())[0].title).toBe('refreshed A');
    await f.pool.close();
  });

  it('honors explicit invalidation while a list is in flight', async () => {
    const f = fixture();
    const a = f.make('a');
    await a.access.apply(config([server('old')]));
    const started = deferred<void>();
    const delayed = deferred<{ tools: Tool[] }>();
    f.lists
      .get('old')!
      .mockImplementationOnce(() => {
        started.resolve();
        return delayed.promise;
      })
      .mockResolvedValue({ tools: [tool('fresh')] });
    const first = a.catalog.list();
    await started.promise;
    a.catalog.invalidate();
    delayed.resolve({ tools: [tool('stale')] });
    expect((await first)[0].title).toBe('fresh');
    expect((await a.catalog.list())[0].title).toBe('fresh');
    await f.pool.close();
  });

  it('retries a direct listing against the replacement backend', async () => {
    const f = fixture();
    const a = f.make('a');
    await a.access.apply(config([server('old')]));
    const started = deferred<void>();
    const delayed = deferred<{ tools: Tool[] }>();
    f.lists.get('old')!.mockImplementationOnce(() => {
      started.resolve();
      return delayed.promise;
    });
    const first = a.catalog.listServer('docs');
    await started.promise;
    await a.access.apply(config([server('new')]));
    delayed.resolve({ tools: [tool('old')] });
    expect((await first)[0].title).toBe('new');
    await f.pool.close();
  });

  it('waits for pool reconciliation instead of caching a transient missing backend', async () => {
    const f = fixture();
    const a = f.make('a');
    await a.access.apply(config([server('old')]));
    await a.catalog.list();
    const delayed = deferred<void>();
    f.waitForReconcile(delayed.promise);
    const applying = a.access.apply(config([server('new')]));
    const pending = a.catalog.list();
    delayed.resolve();
    await applying;
    expect((await pending)[0].title).toBe('new');
    expect((await a.catalog.list())[0].title).toBe('new');
    await f.pool.close();
  });

  it('surfaces a rejected apply without caching it, then recovers on identical retry', async () => {
    const f = fixture();
    const a = f.make('a');
    await a.access.apply(config([server('old')]));
    await a.catalog.list();
    f.manager.reconcile.mockRejectedValueOnce(new Error('apply failed'));
    // Replacement also queues retirement reconciliation; reject all work in this apply.
    f.manager.reconcile.mockRejectedValueOnce(new Error('apply failed'));
    await expect(a.access.apply(config([server('new')]))).rejects.toThrow('apply failed');
    await expect(a.catalog.list()).rejects.toThrow('apply failed');
    await a.access.apply(config([server('new')]));
    expect((await a.catalog.list())[0].title).toBe('new');
    await f.pool.close();
  });

  it('keeps newer in-flight work shared when an older response finishes first', async () => {
    const f = fixture();
    const a = f.make('a');
    await a.access.apply(config([server('old')]));
    const oldStarted = deferred<void>();
    const old = deferred<{ tools: Tool[] }>();
    const newStarted = deferred<void>();
    const next = deferred<{ tools: Tool[] }>();
    f.lists.get('old')!.mockImplementationOnce(() => {
      oldStarted.resolve();
      return old.promise;
    });
    f.lists.get('new')!.mockImplementationOnce(() => {
      newStarted.resolve();
      return next.promise;
    });
    const first = a.catalog.list();
    await oldStarted.promise;
    await a.access.apply(config([server('new')]));
    const second = a.catalog.list();
    await newStarted.promise;
    old.resolve({ tools: [tool('old')] });
    const third = a.catalog.list();
    next.resolve({ tools: [tool('new')] });
    const results = await Promise.all([first, second, third]);
    expect(results.map((tools) => tools[0].title)).toEqual(['new', 'new', 'new']);
    expect(results[0]).toBe(results[1]);
    expect(results[1]).toBe(results[2]);
    expect(f.lists.get('new')).toHaveBeenCalledTimes(1);
    await f.pool.close();
  });

  it('re-lists after an exclusion A to B to A edit while preserving another client policy', async () => {
    const f = fixture();
    const a = f.make('a');
    const b = f.make('b');
    await a.access.apply(config([server('old')]));
    await b.access.apply(config([server('old')], ['docs__read']));
    const started = deferred<void>();
    const old = deferred<{ tools: Tool[] }>();
    f.lists
      .get('old')!
      .mockImplementationOnce(() => {
        started.resolve();
        return old.promise;
      })
      .mockResolvedValue({ tools: [tool('fresh')] });
    const first = a.catalog.list();
    await started.promise;
    await a.access.apply(config([server('old')], ['docs__read']));
    await a.access.apply(config([server('old')]));
    old.resolve({ tools: [tool('stale')] });
    expect((await first)[0].title).toBe('fresh');
    expect(await b.catalog.list()).toEqual([]);
    await f.pool.close();
  });

  it('retries direct lookup after the replaced backend closes with an error', async () => {
    const f = fixture();
    const a = f.make('a');
    await a.access.apply(config([server('old')]));
    f.lists.get('old')!.mockResolvedValueOnce({ tools: [] });
    await a.catalog.list();
    const started = deferred<void>();
    const old = deferred<{ tools: Tool[] }>();
    f.lists.get('old')!.mockImplementationOnce(() => {
      started.resolve();
      return old.promise;
    });
    const first = a.catalog.find('docs', 'read');
    await started.promise;
    await a.access.apply(config([server('new')]));
    old.reject(new Error('old connection closed'));
    expect((await first)?.title).toBe('new');
    await f.pool.close();
  });

  it('surfaces a real current backend failure instead of retrying forever', async () => {
    const f = fixture();
    const a = f.make('a');
    await a.access.apply(config([server('old')]));
    f.lists.get('old')!.mockRejectedValue(new Error('backend failed'));
    expect(await a.catalog.list()).toEqual([]);
    await expect(a.catalog.listServer('docs')).rejects.toThrow('backend failed');
    expect(f.lists.get('old')).toHaveBeenCalledTimes(2);
    await f.pool.close();
  });

  it('follows a newer apply when readiness is superseded, even if the older apply fails', async () => {
    const f = fixture();
    const a = f.make('a');
    await a.access.apply(config([server('old')]));
    const started = deferred<void>();
    const delayed = deferred<void>();
    f.manager.reconcile.mockImplementationOnce(async () => {
      started.resolve();
      return delayed.promise;
    });
    const firstApply = a.access.apply(config([server('old')]));
    const caught = firstApply.catch(() => undefined);
    await started.promise;
    const read = a.catalog.list();
    const latestApply = a.access.apply(config([server('new')]));
    delayed.reject(new Error('superseded apply'));
    await caught;
    await latestApply;
    expect((await read)[0].title).toBe('new');
    await f.pool.close();
  });

  it('rechecks a cached find when configuration changes before its async continuation', async () => {
    const f = fixture();
    const a = f.make('a');
    await a.access.apply(config([server('old')]));
    await a.catalog.list();
    const finding = a.catalog.find('docs', 'read');
    const applying = a.access.apply(config([server('new')]));
    expect((await finding)?.title).toBe('new');
    await applying;
    await f.pool.close();
  });

  it('lists the latest backend once when configuration changes while waiting for readiness', async () => {
    const f = fixture();
    const a = f.make('a');
    await a.access.apply(config([server('old')]));
    const delayed = deferred<void>();
    f.waitForReconcile(delayed.promise);
    const middleApply = a.access.apply(config([server('new')]));
    const first = a.catalog.list();
    const latestApply = a.access.apply(config([server('extra')]));
    const second = a.catalog.list();
    expect(f.lists.get('new')).not.toHaveBeenCalled();
    expect(f.lists.get('extra')).not.toHaveBeenCalled();
    delayed.resolve();
    await Promise.all([middleApply, latestApply]);
    const [one, two] = await Promise.all([first, second]);
    expect(one[0].title).toBe('extra');
    expect(one).toBe(two);
    expect(await a.catalog.list()).toBe(one);
    expect(f.lists.get('new')).not.toHaveBeenCalled();
    expect(f.lists.get('extra')).toHaveBeenCalledTimes(1);
    await f.pool.close();
  });
});
