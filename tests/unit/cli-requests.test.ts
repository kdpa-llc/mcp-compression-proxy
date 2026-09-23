import { describe, it, expect, jest, afterEach } from '@jest/globals';
import { randomUUID } from 'crypto';
import type { LocalModel } from '../../src/models/local-model.js';
import type { ModelSelection } from '../../src/models/types.js';
import { CliRequests, CliViews, CliView, cliViewFactory, CLI_VIEW_IDLE_MS } from '../../src/daemon/cli-requests.js';
import type { ClientContext } from '../../src/mcp/backend-pool.js';
import type { IPCMethod, IPCResponse } from '../../src/types/index.js';
import { daemonFixture, MOCK_SERVER } from '../helpers/daemon-fixture.js';

type Fixture = ReturnType<typeof daemonFixture>;

describe('CliRequests', () => {
  let fixture: Fixture | undefined;
  let views: CliViews | undefined;
  afterEach(async () => {
    views?.closeAll();
    views = undefined;
    await fixture?.cleanup();
    fixture = undefined;
  });

  function setup(config?: Record<string, unknown>, model?: LocalModel) {
    fixture = daemonFixture(config, { model });
    const current = fixture;
    views = new CliViews(cliViewFactory(current.pool, current.services, current.models));
    const cli = new CliRequests({
      views,
      services: current.services,
      fallbackContext: { cwd: current.project, env: current.env },
      status: () => ({ running: true, servers: current.pool.statuses() }),
    });
    const context = { cwd: current.project, env: current.env };
    const ask = (method: IPCMethod, params?: Record<string, unknown>): Promise<IPCResponse> =>
      cli.handle({ id: randomUUID(), method, params, context });
    return { cli, ask, fixture: current };
  }

  const mockConfig = (extra: Record<string, unknown> = {}) => ({
    mcpServers: [
      { name: 'mock', command: process.execPath, args: [MOCK_SERVER], env: { MOCK_TOOL_COUNT: '3' } },
    ],
    ...extra,
  });

  it("lists, searches, describes and calls the tools of the shell's own project", async () => {
    const { ask } = setup(mockConfig({ cli: { payloadThreshold: 20 } }));

    const tools = (await ask('tools')).result as { count: number; tools: Array<{ tool: string; description: string }> };
    expect(tools.count).toBe(3);
    expect(tools.tools[0].description.endsWith('...')).toBe(true);

    const found = (await ask('search', { query: 'tool_001', limit: 1 })).result as { tools: Array<{ tool: string }> };
    expect(found.tools).toEqual([expect.objectContaining({ tool: 'tool_001' })]);

    const info = (await ask('info', { server: 'mock', tool: 'tool_001' })).result;
    expect(info).toMatchObject({ name: 'tool_001', title: 'Tool One', annotations: { readOnlyHint: true } });
    expect((await ask('info', { server: 'mock', tool: 'nope' })).error?.message).toContain('not found');

    const called = (await ask('call', { server: 'mock', tool: 'tool_000', arguments: { input: 'a long input value' } }))
      .result as { output: string; payload?: { id: string } };
    expect(called.payload?.id).toBeDefined();
    const read = (await ask('payload-read', { id: called.payload?.id, all: true })).result as { content: string };
    expect(read.content).toBe('tool_000 executed successfully');
    const matches = (await ask('payload-find', { id: called.payload?.id, query: 'executed' })).result as {
      matches: unknown[];
    };
    expect(matches.matches.length).toBe(1);
  }, 20000);

  it('shapes a call, reshapes its saved source, and refuses to shape without want or where', async () => {
    const { ask } = setup();
    const input = JSON.stringify({ items: [{ id: 1, title: 'login bug' }, { id: 2, title: 'docs' }] });
    const shaped = (await ask('call', { server: 'mock', tool: 'tool_000', arguments: { input }, want: { items: [{ id: 'integer' }] } }))
      .result as { shaped: { data: unknown; source: { id: string } } };
    expect(shaped.shaped.data).toEqual({ items: [{ id: 1 }, { id: 2 }] });

    const reshaped = (await ask('payload-shape', { id: shaped.shaped.source.id, where: 'login' })).result as {
      data: unknown;
    };
    expect(reshaped.data).toEqual([{ id: 1, title: 'login bug' }]);
    expect((await ask('payload-shape', { id: shaped.shaped.source.id })).error?.message).toContain('want and/or where');
  }, 20000);

  it('refuses an excluded tool and reports search quality from learned usage', async () => {
    const { ask } = setup(mockConfig({ excludeTools: ['mock__tool_002'], search: { learnFromUsage: true } }));
    expect((await ask('call', { server: 'mock', tool: 'tool_002' })).error?.message).toContain('excluded');

    await ask('search', { query: 'tool_001' });
    await ask('info', { server: 'mock', tool: 'tool_001' });
    expect((await ask('search-quality')).result).toMatchObject({ enabled: true, selections: 1, top1: 1 });
  }, 20000);

  it('suggests, and runs a confident read-only proposal', async () => {
    const selectTool = jest.fn(async (): Promise<ModelSelection> => ({
      calls: [{ name: 'mock__tool_001', arguments: { input: 'x' } }],
      suppressed: [],
      confidence: 0.99,
      ungrounded: [],
    }));
    const model = { backend: { selectTool }, config: { provider: 'needle' } } as unknown as LocalModel;
    const { ask } = setup(mockConfig({ model: { provider: 'needle' } }), model);

    const proposed = (await ask('suggest', { request: 'run tool 001', candidates: 3 })).result as {
      suggestion: { runnable: boolean };
      ran?: unknown;
    };
    expect(proposed.suggestion.runnable).toBe(true);
    expect(proposed.ran).toBeUndefined();

    const ran = (await ask('suggest', { request: 'run tool 001', run: true })).result as { ran: { output: string } };
    expect(ran.ran.output).toBe('tool_001 executed successfully');
  }, 20000);

  it('audits compressions and re-queues the confusable ones', async () => {
    const { ask, fixture } = setup(mockConfig({ mcpServers: [
      { name: 'mock', command: process.execPath, args: [MOCK_SERVER], env: { MOCK_TOOL_COUNT: '2' } },
    ] }));
    const original = (index: number) =>
      `Original verbose description for tool_00${index}, long enough that compressing it would visibly change the character count reported by the coverage numbers.`;
    fixture.compressionCache.saveCompressed('mock', 'tool_000', 'Tool 001 thing.', original(0));

    const plain = (await ask('audit')).result as { requeued: number; checked: number };
    expect(plain).toMatchObject({ checked: 1, requeued: 0 });
    const requeued = (await ask('audit', { requeue: true })).result as { requeued: number; confusable: unknown[] };
    expect(requeued.requeued).toBe(requeued.confusable.length);
  }, 20000);

  it('runs the describe workflow: next, review, apply and revert', async () => {
    const { ask, fixture } = setup();
    const next = (await ask('describe', { action: 'next', limit: 2, mode: 'compress' })).result as {
      items: unknown[];
      mode: string;
    };
    expect(next).toMatchObject({ mode: 'compress' });
    expect(next.items).toHaveLength(2);

    const proposals = [{ server: 'mock', tool: 'tool_000', description: 'Run tool zero; it only reports success.' }];
    const review = (await ask('describe', { action: 'review', proposals })).result as { accepted: number };
    expect(review.accepted).toBe(1);
    const applied = (await ask('describe', { action: 'apply', proposals })).result as { applied: string[] };
    expect(applied.applied).toEqual(['mock/tool_000']);
    expect(fixture.persistence.save).toHaveBeenCalled();

    expect((await ask('describe', { action: 'revert', tool: 'mock/tool_000' })).result).toEqual({
      reverted: ['mock/tool_000'],
    });
    fixture.compressionCache.saveCompressed('mock', 'tool_001', 'x', 'y');
    expect((await ask('describe', { action: 'revert', all: true })).result).toEqual({ reverted: ['mock/tool_001'] });
    expect((await ask('describe', { action: 'revert', tool: 'nope' })).result).toEqual({ reverted: [] });
    expect((await ask('describe', { action: 'dance' })).error?.message).toContain('Unknown describe action');
  }, 20000);

  it('compresses through the configured endpoint, or explains how to set one up', async () => {
    const without = setup();
    expect((await without.ask('compress')).error?.message).toContain('No compressor configured');
    views?.closeAll();
    await fixture?.cleanup();

    const fetchMock = jest.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      const content = JSON.stringify([
        { serverName: 'mock', toolName: 'tool_000', description: 'Zero.' },
        { serverName: 'mock', toolName: 'tool_001', description: 'One.' },
      ]);
      return new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 });
    });
    try {
      const { ask } = setup(mockConfig({ compressor: { url: 'http://localhost:1/v1', model: 'tiny' } }));
      expect((await ask('compress', { limit: 2 })).result).toMatchObject({
        compressed: 2,
        attempted: 2,
        remaining: 1,
      });
      expect((await ask('compress', { limit: 1 })).result).toMatchObject({ compressed: 0, attempted: 1 });
    } finally {
      fetchMock.mockRestore();
    }
  }, 20000);

  it('runs scripts, reports stats and status, and rejects what it does not know', async () => {
    const { ask, cli, fixture } = setup();
    expect((await ask('script', { steps: 'nope' })).error?.message).toContain('must be an array');
    const script = (await ask('script', {
      steps: [
        { id: 'a', server: 'mock', tool: 'tool_000', arguments: { input: '{"x":1}' }, want: { x: 'integer' } },
      ],
    })).result as { steps: Array<{ output: string }> };
    expect(JSON.parse(script.steps[0].output)).toEqual({ x: 1 });

    expect((await ask('stats', { detailLevel: 'full' })).result).toMatchObject({ summary: { toolsTotal: 3 } });
    expect((await ask('stats')).result).toMatchObject({ summary: { toolsTotal: 3 } });

    const status = (await ask('daemon-status')).result as { servers: Array<{ name: string }>; connectedServers: number };
    expect(status.servers.map((server) => server.name)).toEqual(['mock']);
    expect(status.connectedServers).toBe(1);
    const ping = await cli.handle({ id: '1', method: 'daemon-status', params: { ping: true } });
    expect(ping.result).toMatchObject({ running: true });

    // No context: an older mcp-cli, answered from the daemon's own directory.
    const legacy = await cli.handle({ id: '2', method: 'tools' });
    expect((legacy.result as { count: number }).count).toBe(3);

    expect((await ask('dance' as IPCMethod)).error?.message).toBe('Unknown method: dance');
    expect(fixture.pool.statuses()).toHaveLength(1);
  }, 20000);

  it('answers missing or malformed parameters without crashing', async () => {
    const fetchMock = jest.spyOn(globalThis, 'fetch').mockImplementation(
      async () => new Response(JSON.stringify({ choices: [{ message: { content: '[]' } }] }), { status: 200 })
    );
    try {
      const { ask, fixture } = setup(mockConfig({ compressor: { url: 'http://localhost:1/v1', model: 'tiny' } }));
      expect((await ask('search')).result).toMatchObject({ tools: [] });
      expect((await ask('info')).error?.message).toContain("Tool '' not found");
      expect((await ask('call')).error?.message).toContain('not configured');
      expect((await ask('payload-shape', { where: 'x' })).error).toBeDefined();
      expect((await ask('suggest')).result).toMatchObject({ suggestion: { runnable: false } });
      expect((await ask('payload-read')).error).toBeDefined();
      expect((await ask('payload-find')).error).toBeDefined();
      expect((await ask('describe')).error?.message).toContain('Unknown describe action');
      expect((await ask('describe', { action: 'next' })).result).toMatchObject({ mode: 'rewrite' });
      expect((await ask('describe', { action: 'next', server: 'mock', tool: 'mock/tool_001' })).result).toMatchObject({
        items: [expect.objectContaining({ tool: 'tool_001' })],
      });
      const plain = (await ask('info', { server: 'mock', tool: 'tool_000' })).result as Record<string, unknown>;
      expect(plain).not.toHaveProperty('title');
      expect(plain).not.toHaveProperty('annotations');
      expect((await ask('describe', { action: 'revert' })).result).toEqual({ reverted: [] });
      expect((await ask('describe', { action: 'apply', proposals: [{ server: 'mock', tool: 'nope', description: 'x' }] }))
        .result).toMatchObject({ applied: [] });
      expect((await ask('audit', { requeue: true })).result).toMatchObject({ requeued: 0 });
      expect((await ask('compress')).result).toMatchObject({ attempted: 3 });

      // A short compressed description is listed whole.
      fixture.compressionCache.saveCompressed(
        'mock',
        'tool_000',
        'Zero.',
        'Original verbose description for tool_000, long enough that compressing it would visibly change the character count reported by the coverage numbers.'
      );
      const tools = (await ask('tools')).result as { tools: Array<{ tool: string; description: string }> };
      expect(tools.tools.find((tool) => tool.tool === 'tool_000')?.description).toBe('Zero.');
    } finally {
      fetchMock.mockRestore();
    }
  }, 20000);

  it('reports something thrown that is not an Error', async () => {
    const { ask, fixture } = setup();
    jest.spyOn(fixture.payloadStore, 'read').mockImplementation(() => {
      throw 'store offline';
    });
    expect((await ask('payload-read', { id: 'x' })).error).toEqual({ code: -1, message: 'Unknown error' });
  }, 20000);

  it('turns a failure into an error response', async () => {
    const { ask, fixture } = setup();
    const response = await ask('payload-read', { id: 'missing' });
    expect(response.error?.code).toBe(-1);
    expect(fixture.logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ method: 'payload-read' }),
      'Request handler error'
    );
  }, 20000);
});

describe('CliViews', () => {
  function fakeView() {
    return { close: jest.fn() } as unknown as CliView;
  }

  it('reuses a view per directory and environment, ignoring shell bookkeeping', () => {
    const create = jest.fn((_context: ClientContext) => fakeView());
    const views = new CliViews(create);
    const a = views.get({ cwd: '/p', env: { TOKEN: 'a', PWD: '/p', SHLVL: '1' } });
    expect(views.get({ cwd: '/p', env: { TOKEN: 'a', PWD: '/elsewhere', SHLVL: '3' } })).toBe(a);
    expect(views.get({ cwd: '/p', env: { TOKEN: 'b' } })).not.toBe(a);
    expect(views.get({ cwd: '/q', env: { TOKEN: 'a' } })).not.toBe(a);
    expect(views.size).toBe(3);
    expect(create.mock.calls[0][0]).toMatchObject({ id: expect.stringMatching(/^cli-/), cwd: '/p' });
    views.closeAll();
    expect(a.close).toHaveBeenCalled();
    expect(views.size).toBe(0);
  });

  it('closes views nobody used for a while', () => {
    let now = 0;
    const views = new CliViews(() => fakeView(), { idleMs: 1000, now: () => now });
    const old = views.get({ cwd: '/old', env: {} });
    now = 600;
    const fresh = views.get({ cwd: '/fresh', env: {} });
    now = 1000;
    views.sweep();
    expect(old.close).toHaveBeenCalled();
    expect(fresh.close).not.toHaveBeenCalled();
    now = 2000;
    views.sweep();
    expect(views.size).toBe(0);
    views.sweep();
  });

  it('sweeps on a timer that stops once no view is left', async () => {
    jest.useFakeTimers();
    try {
      const views = new CliViews(() => fakeView());
      const view = views.get({ cwd: '/p', env: {} });
      await jest.advanceTimersByTimeAsync(CLI_VIEW_IDLE_MS + CLI_VIEW_IDLE_MS / 2);
      expect(view.close).toHaveBeenCalled();
      expect(jest.getTimerCount()).toBe(0);
      views.closeAll();
    } finally {
      jest.useRealTimers();
    }
  });
});

it('builds the default CLI view with the daemon settings', async () => {
  const fixture = daemonFixture();
  try {
    const view = cliViewFactory(fixture.pool, fixture.services, fixture.models)({
      id: 'cli-x',
      cwd: fixture.project,
      env: fixture.env,
    });
    await view.view.ready;
    expect(view.threshold()).toBe(10_000);
    expect(view.policy()).toEqual({ noCompressPatterns: [], fallbackBehavior: 'original' });
    expect(view.view.backends.getAuthFailureConfirmer()).toBeUndefined();

    // A directory with no configuration at all.
    const empty = cliViewFactory(fixture.pool, fixture.services, fixture.models)({
      id: 'cli-y',
      cwd: fixture.home,
      env: fixture.env,
    });
    await empty.view.ready;
    expect(empty.view.config()).toBeNull();
    expect(empty.policy()).toEqual({ noCompressPatterns: [], fallbackBehavior: 'original' });
    empty.close();
    expect(view.model()).toBeUndefined();
    view.close();
  } finally {
    await fixture.cleanup();
  }
});
