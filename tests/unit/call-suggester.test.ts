import { describe, it, expect, jest } from '@jest/globals';
import { CallSuggester } from '../../src/services/call-suggester.js';
import { ToolSearch } from '../../src/search/tool-search.js';
import type { CatalogTool } from '../../src/mcp/tool-catalog.js';
import type { ModelBackend, ModelSelection } from '../../src/models/types.js';

const tools: CatalogTool[] = [
  {
    serverName: 'fs',
    toolName: 'list_directory',
    description: 'List files and folders in a directory.',
    inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    annotations: { readOnlyHint: true },
  },
  {
    serverName: 'fs',
    toolName: 'delete_file',
    description: 'Delete a file from disk.',
    inputSchema: { type: 'object', properties: { path: { type: 'string' } } },
  },
];

const catalog = {
  list: async () => tools,
  find: async (server: string, tool: string) =>
    tools.find((entry) => entry.serverName === server && entry.toolName === tool),
};

function suggester(selection?: Partial<ModelSelection> | Error) {
  const search = new ToolSearch(catalog, { getCompressedDescription: () => undefined });
  const selectTool = jest.fn<ModelBackend['selectTool']>(async () => {
    if (selection instanceof Error) throw selection;
    return { calls: [], suppressed: [], confidence: 0.95, ungrounded: [], ...selection };
  });
  return {
    instance: new CallSuggester(search, catalog, selection === undefined ? undefined : { selectTool }),
    selectTool,
  };
}

describe('CallSuggester', () => {
  it('returns candidates with schemas when no model is configured', async () => {
    const { instance } = suggester();
    const result = await instance.suggest('list the files in a folder');

    expect(result.candidates[0]).toMatchObject({
      server: 'fs',
      tool: 'list_directory',
      inputSchema: { required: ['path'] },
      annotations: { readOnlyHint: true },
    });
    expect(result.proposal).toBeUndefined();
    expect(result.runnable).toBe(false);
    expect(result.runBlockedBy).toBe('no local model');
  });

  it('reports when nothing matches', async () => {
    const { instance } = suggester({});
    const result = await instance.suggest('zzzz qqqq');
    expect(result.candidates).toEqual([]);
    expect(result.runBlockedBy).toBe('no candidate tools');
  });

  it('proposes a runnable call for a confident, grounded, read-only choice', async () => {
    const { instance, selectTool } = suggester({
      calls: [{ name: 'fs__list_directory', arguments: { path: '/tmp' } }],
      reasoning: "'/tmp' -> path",
    });
    const result = await instance.suggest('list the files in /tmp folder');

    expect(selectTool).toHaveBeenCalledWith(
      'list the files in /tmp folder',
      expect.arrayContaining([
        expect.objectContaining({ name: 'fs__list_directory', parameters: tools[0].inputSchema }),
      ])
    );
    expect(result.proposal).toMatchObject({
      server: 'fs',
      tool: 'list_directory',
      arguments: { path: '/tmp' },
      readOnly: true,
      withheld: false,
    });
    expect(result.runnable).toBe(true);
  });

  it.each([
    [
      'a tool without readOnlyHint',
      { calls: [{ name: 'fs__delete_file', arguments: { path: '/tmp/x' } }] },
      'readOnlyHint',
    ],
    [
      'low confidence',
      { calls: [{ name: 'fs__list_directory', arguments: { path: '/' } }], confidence: 0.4 },
      'below 0.9',
    ],
    [
      'unknown confidence',
      { calls: [{ name: 'fs__list_directory', arguments: { path: '/' } }], confidence: null },
      'unknown',
    ],
    [
      'ungrounded arguments',
      {
        calls: [{ name: 'fs__list_directory', arguments: { path: '/etc' } }],
        ungrounded: ['fs__list_directory.path'],
      },
      'not found in the request: path',
    ],
    [
      'a withheld call',
      { suppressed: [{ name: 'fs__list_directory', arguments: { path: '/' } }] },
      'withheld',
    ],
    [
      'several calls',
      {
        calls: [
          { name: 'fs__list_directory', arguments: { path: '/a' } },
          { name: 'fs__delete_file', arguments: { path: '/b' } },
        ],
      },
      'more than one call',
    ],
  ])('never marks %s as runnable', async (_label, selection, reason) => {
    const { instance } = suggester(selection as Partial<ModelSelection>);
    const result = await instance.suggest('list or delete files in a folder');

    expect(result.proposal).toBeDefined();
    expect(result.runnable).toBe(false);
    expect(result.runBlockedBy).toContain(reason);
  });

  it('explains when the model proposes nothing or fails', async () => {
    const empty = await suggester({ calls: [] }).instance.suggest('list files');
    expect(empty.runBlockedBy).toBe('no proposal');

    const unknown = await suggester({
      calls: [{ name: 'other__tool', arguments: {} }],
    }).instance.suggest('list files');
    expect(unknown.proposal).toBeUndefined();

    const failed = await suggester(new Error('bridge down')).instance.suggest('list files');
    expect(failed.runBlockedBy).toBe('model error');
    expect(failed.notes.join(' ')).toContain('bridge down');
  });
});
