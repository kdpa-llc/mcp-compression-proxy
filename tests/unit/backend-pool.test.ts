import { describe, it, expect, jest, afterEach } from '@jest/globals';
import { mkdtempSync, realpathSync, rmSync } from 'fs';
import { homedir, tmpdir } from 'os';
import { join } from 'path';
import type { Logger } from 'pino';
import type { ConfigResult } from '../../src/config/loader.js';
import { BackendPool, backendSpec, VOLATILE_ENV, type ClientContext } from '../../src/mcp/backend-pool.js';
import type { MCPClientManager, ManagedClientContext } from '../../src/mcp/client-manager.js';
import type { MCPServerConfig } from '../../src/types/index.js';

function makeLogger(): Logger {
  return { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() } as unknown as Logger;
}

function configOf(
  servers: MCPServerConfig[],
  extra: Partial<NonNullable<ConfigResult>> = {}
): NonNullable<ConfigResult> {
  return { servers, excludePatterns: [], noCompressPatterns: [], ...extra };
}

const env = { PATH: '/usr/bin', HOME: '/home/me', TOKEN: 'abc', PWD: '/work/a', SHLVL: '2' };
const client = (overrides: Partial<ClientContext> = {}): ClientContext => ({
  id: 'one',
  cwd: '/work/a',
  env,
  ...overrides,
});
const git: MCPServerConfig = { name: 'git', command: 'git-mcp', args: ['--stdio'] };

describe('backendSpec', () => {
  it('runs a spawned server in the client directory with the client environment', () => {
    const { id, config } = backendSpec(git, configOf([git]), client());
    expect(id).toMatch(/^[0-9a-f]{12}$/);
    expect(config).toMatchObject({
      name: `git#${id}`,
      command: 'git-mcp',
      cwd: '/work/a',
      inheritEnv: false,
      env: { TOKEN: 'abc', PATH: '/usr/bin' },
      softMaxConnectionAgeSeconds: 3600,
    });
  });

  it('shares between clients that differ only in name, key order or shell bookkeeping', () => {
    const base = backendSpec(git, configOf([git]), client()).id;
    expect(backendSpec({ args: ['--stdio'], command: 'git-mcp', name: 'git' }, configOf([]), client({ id: 'two' })).id).toBe(
      base
    );
    const noisy = { ...env, PWD: '/elsewhere', SHLVL: '5', _: '/bin/node', TERM_SESSION_ID: 'x', CLAUDE_SESSION_ID: 'y' };
    expect(backendSpec(git, configOf([git]), client({ id: 'two', env: noisy })).id).toBe(base);
    expect(VOLATILE_ENV).toContain('*_SESSION_ID');

    // The name is only a label: another name for the same server is the same backend.
    expect(backendSpec({ ...git, name: 'vcs' }, configOf([]), client()).id).toBe(base);
  });

  it('keeps clients with different credentials, directories or settings apart', () => {
    const base = backendSpec(git, configOf([git]), client()).id;
    expect(backendSpec(git, configOf([git]), client({ env: { ...env, TOKEN: 'other' } })).id).not.toBe(base);
    expect(backendSpec(git, configOf([git]), client({ cwd: '/work/b' })).id).not.toBe(base);
    expect(backendSpec({ ...git, args: [] }, configOf([git]), client()).id).not.toBe(base);
    expect(backendSpec(git, configOf([git], { authErrorPatterns: ['401'] }), client()).id).not.toBe(base);
  });

  it('ignores the variables a config lists in shareIgnoreEnv', () => {
    const config = configOf([git], { shareIgnoreEnv: ['TOK*'] });
    expect(backendSpec(git, config, client()).id).toBe(
      backendSpec(git, config, client({ env: { ...env, TOKEN: 'other' } })).id
    );
  });

  it('scopes sharing with share: session, project or global', () => {
    const session = { ...git, share: 'session' as const };
    expect(backendSpec(session, configOf([]), client()).id).not.toBe(
      backendSpec(session, configOf([]), client({ id: 'two' })).id
    );

    const global = { ...git, share: 'global' as const };
    const inA = backendSpec(global, configOf([]), client());
    const inB = backendSpec(global, configOf([]), client({ cwd: '/work/b', env: { ...env, PWD: '/work/b' } }));
    expect(inA.id).toBe(inB.id);
    expect(inA.config.cwd).toBe('/home/me');

    const withCwd = backendSpec({ ...global, cwd: 'tools' }, configOf([]), client());
    expect(withCwd.config.cwd).toBe('/work/a/tools');
  });

  it("takes safe defaults from the client, not the process, when nothing is inherited", () => {
    const { config } = backendSpec(
      { ...git, inheritEnv: false, env: { MODE: 'x' } },
      configOf([]),
      client({ env: { ...env, TERM: 'xterm', HOME: '() { :; }' } })
    );
    expect(config.env).toEqual({ PATH: '/usr/bin', TERM: 'xterm', MODE: 'x' });

    const listed = backendSpec({ ...git, inheritEnv: ['TOKEN'] }, configOf([]), client());
    expect(listed.config.env).toEqual({ TOKEN: 'abc' });

    const bare = backendSpec({ ...git, inheritEnv: false }, configOf([]), client());
    expect(bare.config.env).toEqual({ PATH: '/usr/bin', HOME: '/home/me' });
  });

  it('shares a remote server by URL and headers, wherever its clients run', () => {
    const remote: MCPServerConfig = { name: 'docs', url: 'https://mcp.example/mcp', headers: { A: '1' } };
    const inA = backendSpec(remote, configOf([]), client());
    expect(backendSpec(remote, configOf([]), client({ cwd: '/work/b', env: {} })).id).toBe(inA.id);
    expect(inA.config.env).toBeUndefined();
    expect(inA.config.cwd).toBeUndefined();
    expect(backendSpec({ ...remote, headers: { A: '2' } }, configOf([]), client()).id).not.toBe(inA.id);
  });

  it('falls back to the home directory of the process for a global server', () => {
    const { config } = backendSpec({ ...git, share: 'global' }, configOf([]), client({ env: {} }));
    expect(config.cwd).toBe(homedir());
  });
});

type Reconcile = (servers: MCPServerConfig[]) => Promise<void>;

function fakeManager() {
  let current: MCPServerConfig[] = [];
  const manager = {
    reconcile: jest.fn<Reconcile>(async (servers) => {
      current = servers;
    }),
    withClient: jest.fn(async (name: string, operation: (context: ManagedClientContext) => Promise<unknown>) =>
      operation({ client: { name } as never, generation: 1, markFailure: () => undefined, invalidate: () => undefined })
    ),
    getAuthRecoveryPolicy: (name: string) => ({ authErrorPatterns: [name], authRetryTools: [] }),
    getServerStatuses: () => current.map((server) => ({ name: server.name, connected: true })),
    disconnectAll: jest.fn(async () => undefined),
  };
  const running = () => current.map((server) => server.name.split('#')[0]).sort();
  return { manager, running, typed: manager as unknown as MCPClientManager };
}

describe('BackendPool', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('runs one backend for two clients that describe it alike, and stops it after both leave', async () => {
    jest.useFakeTimers();
    const { manager, running, typed } = fakeManager();
    const pool = new BackendPool(makeLogger(), { manager: typed, releaseGraceMs: 1000 });
    const a = pool.client(client());
    const b = pool.client(client({ id: 'two' }));

    await a.apply(configOf([git]));
    await b.apply(configOf([{ ...git, name: 'vcs' }]));
    expect(running()).toEqual(['git']);
    expect(pool.statuses()).toEqual([expect.objectContaining({ holders: 2 })]);
    expect(b.getConfiguredServerNames()).toEqual(['vcs']);
    expect(b.getServerStatuses()).toEqual([{ name: 'vcs', connected: true }]);

    a.release();
    b.release();
    expect(running()).toEqual(['git']);
    await jest.advanceTimersByTimeAsync(1000);
    expect(running()).toEqual([]);
    expect(manager.reconcile).toHaveBeenLastCalledWith([]);
  });

  it('keeps a backend for a client that comes back within the grace period', async () => {
    jest.useFakeTimers();
    const { manager, running, typed } = fakeManager();
    const pool = new BackendPool(makeLogger(), { manager: typed, releaseGraceMs: 1000 });

    const first = pool.client(client());
    await first.apply(configOf([git]));
    first.release();
    await jest.advanceTimersByTimeAsync(500);
    await pool.client(client({ id: 'again' })).apply(configOf([git]));
    await jest.advanceTimersByTimeAsync(1000);
    expect(running()).toEqual(['git']);
    expect(manager.reconcile).toHaveBeenCalledTimes(2);
  });

  it("stops a backend at once when its only client's config drops it", async () => {
    const { running, typed } = fakeManager();
    const pool = new BackendPool(makeLogger(), { manager: typed });
    const one = pool.client(client());
    await one.apply(configOf([git, { name: 'fs', command: 'fs-mcp' }]));
    expect(running()).toEqual(['fs', 'git']);

    await one.apply(configOf([{ name: 'fs', command: 'fs-mcp' }]));
    expect(running()).toEqual(['fs']);
    await one.apply(null);
    expect(running()).toEqual([]);
  });

  it("keeps a backend another client still holds when one client's config drops it", async () => {
    const { running, typed } = fakeManager();
    const pool = new BackendPool(makeLogger(), { manager: typed, releaseGraceMs: 0 });
    const a = pool.client(client());
    const b = pool.client(client({ id: 'two' }));
    await a.apply(configOf([git]));
    await b.apply(configOf([git]));
    await a.apply(configOf([]));
    expect(running()).toEqual(['git']);
    b.release();
    await new Promise((resolve) => setImmediate(resolve));
    expect(running()).toEqual([]);
  });

  it('logs a backend that fails to stop', async () => {
    const { manager, typed } = fakeManager();
    const logger = makeLogger();
    const pool = new BackendPool(logger, { manager: typed, releaseGraceMs: 0 });
    const one = pool.client(client());
    await one.apply(configOf([git]));
    manager.reconcile.mockRejectedValueOnce(new Error('stuck'));
    one.release();
    await new Promise((resolve) => setImmediate(resolve));
    expect(logger.error).toHaveBeenCalledWith(expect.anything(), 'Failed to stop an unused backend');
  });

  it('maps names, exclusions, auth policy and the confirmer for each client', async () => {
    const { manager, typed } = fakeManager();
    const confirmer = jest.fn(async () => true);
    const pool = new BackendPool(makeLogger(), { manager: typed });
    const one = pool.client(client(), { authConfirmer: () => confirmer });
    await one.apply(
      configOf([git, { ...git, name: 'git', args: ['--later-wins'] }, { name: 'off', command: 'x', enabled: false }], {
        excludePatterns: ['git__push'],
      })
    );

    expect(one.getConfiguredServerNames()).toEqual(['git']);
    const slot = manager.reconcile.mock.calls[0][0][0].name;
    expect(slot).toMatch(/^git#/);
    expect(manager.reconcile.mock.calls[0][0][0].args).toEqual(['--later-wins']);
    expect(await one.withClient('git', async (context) => (context.client as unknown as { name: string }).name)).toBe(slot);
    await expect(one.withClient('nope', async () => 1)).rejects.toThrow("Server 'nope' is not configured");
    expect(one.isToolExcluded('git', 'push')).toBe(true);
    expect(one.getExcludePatterns()).toEqual(['git__push']);
    expect(one.getAuthRecoveryPolicy('git').authErrorPatterns).toEqual([slot]);
    expect(one.getAuthRecoveryPolicy('nope')).toEqual({ authErrorPatterns: [], authRetryTools: [] });
    expect(one.getAuthFailureConfirmer()).toBe(confirmer);
    expect(pool.client(client()).getAuthFailureConfirmer()).toBeUndefined();
  });

  it('follows config changes while watched, and stops after release', async () => {
    jest.useFakeTimers();
    const { running, typed } = fakeManager();
    const logger = makeLogger();
    const pool = new BackendPool(logger, { manager: typed });
    const one = pool.client(client());
    let config: ConfigResult = configOf([git]);
    await one.apply(config);
    one.watch(() => config, 100);
    one.watch(() => config, 100); // a second watch is ignored

    config = configOf([{ name: 'fs', command: 'fs-mcp' }]);
    await jest.advanceTimersByTimeAsync(100);
    expect(running()).toEqual(['fs']);
    await jest.advanceTimersByTimeAsync(100);
    expect(running()).toEqual(['fs']);

    one.release();
    config = configOf([git]);
    await jest.advanceTimersByTimeAsync(200);
    expect(await one.apply(config)).toBeUndefined();
    one.watch(() => config, 100);
    await jest.advanceTimersByTimeAsync(200);
    expect(one.getConfiguredServerNames()).toEqual(['fs']);
  });

  it('logs a config change it could not apply', async () => {
    jest.useFakeTimers();
    const { manager, typed } = fakeManager();
    const logger = makeLogger();
    const one = new BackendPool(logger, { manager: typed }).client(client());
    let config: ConfigResult = configOf([]);
    one.watch(() => config, 100);
    manager.reconcile.mockRejectedValueOnce(new Error('bad'));
    config = configOf([git]);
    await jest.advanceTimersByTimeAsync(100);
    expect(logger.error).toHaveBeenCalledWith(expect.anything(), 'Failed to apply backend server configuration');
  });

  it('closes everything, pending releases included', async () => {
    jest.useFakeTimers();
    const { manager, typed } = fakeManager();
    const pool = new BackendPool(makeLogger(), { manager: typed, releaseGraceMs: 1000 });
    const one = pool.client(client());
    await one.apply(configOf([git]));
    one.release();
    await pool.close();
    expect(manager.disconnectAll).toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(1000);
    expect(manager.reconcile).toHaveBeenCalledTimes(1);
    await pool.client(client()).apply(configOf([git]));
    expect(manager.reconcile).toHaveBeenCalledTimes(1);
  });

  it('builds its own manager by default', async () => {
    const pool = new BackendPool(makeLogger());
    expect(pool.manager).toBeDefined();
    await pool.close();
  });

  it("shows each client only its own backends, and none once they are gone", async () => {
    const { typed } = fakeManager();
    const pool = new BackendPool(makeLogger(), { manager: typed, releaseGraceMs: 0 });
    const a = pool.client(client());
    const b = pool.client(client({ id: 'two' }));
    await a.apply(configOf([git]));
    await b.apply(configOf([{ name: 'fs', command: 'fs-mcp' }]));
    expect(a.getServerStatuses().map((status) => status.name)).toEqual(['git']);

    pool.client(client({ id: 'never' })).release();
    a.release();
    await new Promise((resolve) => setImmediate(resolve));
    expect(a.getServerStatuses()).toEqual([]);
    await expect(a.withClient('git', async () => 1)).rejects.toThrow('not configured');
  });

  it('closes backends still held, and reports them unheld while they stop', async () => {
    const { manager, typed } = fakeManager();
    const pool = new BackendPool(makeLogger(), { manager: typed });
    const one = pool.client(client());
    await one.apply(configOf([git]));
    one.watch(() => null);
    await pool.close();
    expect(manager.disconnectAll).toHaveBeenCalled();
    expect(pool.statuses()).toEqual([expect.objectContaining({ holders: 0 })]);
    one.release();
  });
});

describe('BackendPool with real servers', () => {
  const server = join(process.cwd(), 'tests/__mocks__/multi-tool-server.js');

  it("starts one process for two clients, in the client's directory with its environment", async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'pool-real-')));
    const pool = new BackendPool(makeLogger(), { releaseGraceMs: 0 });
    const context = { cwd: dir, env: { ...process.env, POOL_TOKEN: 'secret' } };
    const a = pool.client({ id: 'a', ...context });
    const b = pool.client({ id: 'b', ...context });
    const config = configOf([{ name: 'mock', command: process.execPath, args: [server] }]);
    const ask = (backends: typeof a, input: string) =>
      backends.withClient('mock', async ({ client: mcp }) => {
        const result = (await mcp.callTool({ name: 'tool_000', arguments: { input } })) as {
          content: Array<{ text: string }>;
        };
        return result.content[0].text;
      });

    try {
      await a.apply(config);
      await b.apply(config);
      expect(await ask(a, '@pid')).toBe(await ask(b, '@pid'));
      expect(await ask(a, '@cwd')).toBe(dir);
      expect(await ask(b, '@env:POOL_TOKEN')).toBe('secret');
    } finally {
      a.release();
      b.release();
      await pool.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 20000);
});
