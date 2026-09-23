import { describe, it, expect, jest, afterEach } from '@jest/globals';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { PayloadStore } from '../../src/cli/payload-interceptor.js';
import { MetaTools, META_TOOLS, LAZY_KEPT_MANAGEMENT_TOOLS } from '../../src/native/meta-tools.js';
import { ToolSearch } from '../../src/search/tool-search.js';
import type { CatalogTool } from '../../src/mcp/tool-catalog.js';
import type { ModelBackend } from '../../src/models/types.js';

const tools: CatalogTool[] = [
  {
    serverName: 'gh',
    toolName: 'list_issues',
    description: 'List issues in a repository.',
    inputSchema: { type: 'object', properties: { repo: { type: 'string' } } },
    title: 'List issues',
    annotations: { readOnlyHint: true },
  },
  {
    serverName: 'gh',
    toolName: 'create_issue',
    description: 'Create a new issue.',
    inputSchema: { type: 'object' },
  },
];

const issues = JSON.stringify({
  items: [
    { number: 1, title: 'Login fails', body: 'long text' },
    { number: 2, title: 'Dark mode', body: 'long text' },
  ],
});

function text(result: CallToolResult): string {
  return result.content.map((item) => (item.type === 'text' ? item.text : '')).join('\n');
}

describe('MetaTools', () => {
  const stores: PayloadStore[] = [];
  afterEach(() => {
    stores.splice(0).forEach((store) => store.destroy());
  });

  function setup(model?: Partial<ModelBackend>) {
    const payloadStore = new PayloadStore();
    stores.push(payloadStore);
    const catalog = {
      list: async () => tools,
      find: async (server: string, tool: string) =>
        tools.find((entry) => entry.serverName === server && entry.toolName === tool),
    };
    const compression = {
      getCompressedDescription: jest.fn<(s: string, t: string) => string | undefined>(() => undefined),
      invalidate: jest.fn((_server: string, _tool: string) => true),
      saveToDisk: jest.fn(async () => undefined),
    };
    const usage = { recordSelection: jest.fn(), recordSearch: jest.fn(), scores: () => new Map() };
    const callBackend = jest.fn(
      async (_s: string, tool: string, _args: Record<string, unknown>): Promise<CallToolResult> => ({
        content: [{ type: 'text', text: `ran ${tool}` }],
      })
    );
    const executeText = jest.fn(async () => ({ output: issues }));
    const meta = new MetaTools({
      catalog,
      search: new ToolSearch(catalog, compression),
      usage: usage as never,
      compression,
      payloadStore,
      threshold: () => 10_000,
      model: () => model as ModelBackend | undefined,
      callBackend,
      executeText,
    });
    return { meta, usage, callBackend, executeText, compression, payloadStore };
  }

  it('lists a lean set for lazy exposure and the wrapper call for full exposure', () => {
    const { meta } = setup();

    expect(meta.definitions('lazy').map((tool) => tool.name)).toEqual([
      META_TOOLS.searchTools,
      META_TOOLS.getTool,
      META_TOOLS.callTool,
      META_TOOLS.suggestTool,
      META_TOOLS.shapeOutput,
    ]);
    expect(meta.definitions('full').map((tool) => tool.name)).toEqual([
      META_TOOLS.callTool,
      META_TOOLS.shapeOutput,
      META_TOOLS.auditCompression,
    ]);
    expect(LAZY_KEPT_MANAGEMENT_TOOLS).toContain('mcp-compression-proxy__read_output');
    expect(meta.handles(META_TOOLS.getTool)).toBe(true);
    expect(meta.handles('gh__list_issues')).toBe(false);
  });

  it('searches, then describes a tool with its schema and annotations', async () => {
    const { meta, usage } = setup();

    const found = JSON.parse(text(await meta.call(META_TOOLS.searchTools, { query: 'list issues', limit: 1 })));
    expect(found.tools).toEqual([{ server: 'gh', tool: 'list_issues', description: 'List issues in a repository.' }]);
    expect(found.total).toBeGreaterThanOrEqual(1);

    const described = JSON.parse(text(await meta.call(META_TOOLS.getTool, { server: 'gh', tool: 'list_issues' })));
    expect(described).toMatchObject({
      inputSchema: { properties: { repo: { type: 'string' } } },
      title: 'List issues',
      annotations: { readOnlyHint: true },
    });
    expect(usage.recordSelection).toHaveBeenCalledWith('gh', 'list_issues');

    const missing = await meta.call(META_TOOLS.getTool, { server: 'gh', tool: 'nope' });
    expect(missing.isError).toBe(true);
    expect((await meta.call(META_TOOLS.searchTools, {})).isError).toBe(true);
  });

  it('calls through unchanged without want/where, and shapes with them', async () => {
    const { meta, callBackend, payloadStore } = setup();

    expect(text(await meta.call(META_TOOLS.callTool, { server: 'gh', tool: 'list_issues' }))).toBe('ran list_issues');
    expect(callBackend).toHaveBeenCalledWith('gh', 'list_issues', {});

    const shaped = JSON.parse(
      text(
        await meta.call(META_TOOLS.callTool, {
          server: 'gh',
          tool: 'list_issues',
          arguments: { repo: 'x/y' },
          want: { items: [{ number: 'integer', title: 'string' }] },
          where: 'login',
        })
      )
    );
    expect(shaped.data).toEqual({ items: [{ number: 1, title: 'Login fails' }] });
    expect(payloadStore.read(shaped.source.id, { all: true }).content).toBe(issues);

    const reshaped = JSON.parse(
      text(await meta.call(META_TOOLS.shapeOutput, { id: shaped.source.id, where: 'dark' }))
    );
    expect(reshaped.data).toEqual([{ number: 2, title: 'Dark mode', body: 'long text' }]);

    expect((await meta.call(META_TOOLS.shapeOutput, { id: shaped.source.id })).isError).toBe(true);
    expect((await meta.call(META_TOOLS.callTool, { tool: 'x' })).isError).toBe(true);
  });

  it('returns a failed backend call as an error instead of shaping it', async () => {
    const { meta, executeText } = setup();
    executeText.mockResolvedValueOnce({ output: 'boom', isError: true } as never);

    const result = await meta.call(META_TOOLS.callTool, { server: 'gh', tool: 'list_issues', where: 'x' });
    expect(result.isError).toBe(true);
    expect(text(result)).toBe('boom');
  });

  it('suggests, and runs only a runnable proposal when asked', async () => {
    const selectTool = jest.fn<ModelBackend['selectTool']>(async () => ({
      calls: [{ name: 'gh__list_issues', arguments: { repo: 'a/b' } }],
      suppressed: [],
      confidence: 0.97,
      ungrounded: [],
    }));
    const { meta, callBackend } = setup({ selectTool });

    const proposed = JSON.parse(text(await meta.call(META_TOOLS.suggestTool, { request: 'list issues in a/b' })));
    expect(proposed.suggestion.runnable).toBe(true);
    expect(callBackend).not.toHaveBeenCalled();

    const ran = await meta.call(META_TOOLS.suggestTool, { request: 'list issues in a/b', run: true });
    expect(callBackend).toHaveBeenCalledWith('gh', 'list_issues', { repo: 'a/b' });
    expect(text(ran)).toContain('ran list_issues');

    expect((await meta.call(META_TOOLS.suggestTool, {})).isError).toBe(true);
  });

  it('audits and re-queues confusable compressions', async () => {
    const { meta, compression } = setup();
    compression.getCompressedDescription.mockImplementation((_server, tool) =>
      tool === 'list_issues' ? 'Create a new issue.' : undefined
    );

    const audit = JSON.parse(text(await meta.call(META_TOOLS.auditCompression, { requeue: true })));

    expect(audit.confusable[0]).toMatchObject({ tool: 'gh/list_issues', closestTo: 'gh/create_issue' });
    expect(audit.requeued).toBe(1);
    expect(compression.invalidate).toHaveBeenCalledWith('gh', 'list_issues');
    expect(compression.saveToDisk).toHaveBeenCalled();
  });

  it('turns thrown errors into tool errors', async () => {
    const { meta } = setup();
    const result = await meta.call(META_TOOLS.shapeOutput, { id: 'nope', where: 'x' });
    expect(result.isError).toBe(true);
    expect(text(result)).toContain('not found');
    expect((await meta.call('mcp-compression-proxy__unknown', {})).isError).toBe(true);
  });
});
