import { describe, it, expect, jest } from '@jest/globals';
import { auditCompression } from '../../src/services/compression-audit.js';
import type { CatalogTool } from '../../src/mcp/tool-catalog.js';

function tool(serverName: string, toolName: string, description: string): CatalogTool {
  return { serverName, toolName, description, inputSchema: { type: 'object' } };
}

const tools = [
  tool('fs', 'read_file', 'Read the complete contents of one file from disk.'),
  tool('fs', 'read_multiple_files', 'Read the contents of several files at once, returning each file with its path.'),
  tool('git', 'git_status', 'Show the working tree status of the repository.'),
  tool('files', 'read_file', 'Read the complete contents of one file from disk.'),
];

function cacheOf(entries: Record<string, string>) {
  return { getCompressedDescription: (server: string, name: string) => entries[`${server}/${name}`] };
}

describe('auditCompression', () => {
  it('flags a compression that reads more like a sibling tool', async () => {
    const audit = await auditCompression(
      tools,
      cacheOf({
        'fs/read_file': 'Reads the contents of several files at once with their paths.',
        'git/git_status': 'Working tree status.',
      })
    );

    expect(audit.method).toBe('lexical');
    expect(audit.checked).toBe(2);
    expect(audit.confusable).toHaveLength(1);
    expect(audit.confusable[0]).toMatchObject({
      tool: 'fs/read_file',
      closestTo: 'fs/read_multiple_files',
    });
    expect(audit.confusable[0].otherSimilarity).toBeGreaterThanOrEqual(
      audit.confusable[0].ownSimilarity
    );
  });

  it('lists identical tools on different servers as possible duplicates', async () => {
    const audit = await auditCompression(tools, cacheOf({}));

    expect(audit.duplicates).toEqual([
      { tools: ['fs/read_file', 'files/read_file'], similarity: 1 },
    ]);
    expect(audit.notes[0]).toContain('No tool has a compressed description yet');
  });

  it('compares by meaning with a model', async () => {
    const vectors: Record<string, number[]> = {
      one: [1, 0, 0, 5],
      several: [0, 1, 0, 5],
      status: [0, 0, 1, 5],
    };
    const pick = (text: string) =>
      new Float32Array(
        text.includes('several') ? vectors.several : text.includes('status') ? vectors.status : vectors.one
      );
    const embed = jest.fn(async (texts: string[]) => texts.map(pick));

    const audit = await auditCompression(
      tools.slice(0, 3),
      cacheOf({ 'fs/read_file': 'Reads several files.', 'git/git_status': 'Tree status.' }),
      { embed }
    );

    expect(audit.method).toBe('semantic');
    expect(audit.confusable.map((finding) => finding.tool)).toEqual(['fs/read_file']);
  });

  it('falls back to shared words when the model fails', async () => {
    const embed = jest.fn(async () => Promise.reject(new Error('bridge down')));
    const audit = await auditCompression(tools, cacheOf({}), { embed });

    expect(audit.method).toBe('lexical');
    expect(audit.notes[0]).toContain('bridge down');
  });

  it('with a margin, flags only descriptions clearly closer to another tool', async () => {
    const entries = { 'fs/read_file': 'Read the contents of one or several files from disk.' };
    const strict = await auditCompression(tools.slice(0, 3), cacheOf(entries));
    const lenient = await auditCompression(tools.slice(0, 3), cacheOf(entries), undefined, { margin: 0.5 });

    expect(strict.confusable.length).toBeGreaterThanOrEqual(lenient.confusable.length);
    expect(lenient.confusable).toEqual([]);
  });
});

describe('auditCompression edges', () => {
  it('handles tools with no words to compare', async () => {
    const bare = [
      { serverName: 's', toolName: 'a', inputSchema: { type: 'object' as const } },
      { serverName: 't', toolName: 'b', inputSchema: { type: 'object' as const } },
    ];
    const audit = await auditCompression(bare, cacheOf({ 's/a': 'the' }));
    expect(audit.checked).toBe(1);
    expect(audit.duplicates).toEqual([]);
  });

  it('reports a model that fails with a non-Error', async () => {
    const embed = jest.fn(async () => Promise.reject('bridge gone'));
    const audit = await auditCompression(tools, cacheOf({}), { embed });
    expect(audit.notes[0]).toContain('(bridge gone)');
  });
});
