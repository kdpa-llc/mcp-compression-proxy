import { describe, it, expect, jest } from '@jest/globals';
import type { Logger } from 'pino';
import { CompressionCache } from '../../src/services/compression-cache.js';
import type { CompressionPersistence } from '../../src/services/compression-persistence.js';
import {
  applyReview,
  descriptionIssues,
  nextBatch,
  parseProposals,
  reviewProposals,
  MAX_DESCRIPTION_CHARS,
} from '../../src/services/description-rewrite.js';
import type { CatalogTool } from '../../src/mcp/tool-catalog.js';

const logger = { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() } as unknown as Logger;

function newCache(): CompressionCache {
  const persistence = {
    load: jest.fn(async () => new Map()),
    save: jest.fn(async () => undefined),
    clear: jest.fn(async () => undefined),
    getCacheFilePath: () => '/tmp/none.json',
  } as unknown as CompressionPersistence;
  return new CompressionCache(logger, persistence);
}

const tools: CatalogTool[] = [
  {
    serverName: 'gh',
    toolName: 'list_issues',
    description: 'Gets issues.',
    inputSchema: {
      type: 'object',
      properties: { repo: { type: 'string' }, state: { type: 'string', description: 'state' } },
      required: ['repo'],
    },
  },
  {
    serverName: 'gh',
    toolName: 'create_issue',
    description: 'Create a new issue in a GitHub repository with a title and body.',
    inputSchema: {
      type: 'object',
      properties: { title: { type: 'string', description: 'Issue title' } },
    },
  },
  {
    serverName: 'fs',
    toolName: 'read_file',
    description:
      'Read the complete contents of a file from the file system. Handles various text encodings and returns the text.',
    inputSchema: { type: 'object', properties: { path: { type: 'string', description: 'Path' } } },
  },
];

describe('descriptionIssues', () => {
  it('names what makes a description weak', () => {
    expect(descriptionIssues(tools[0])).toEqual([
      'description is very short',
      '1 of 2 parameter(s) undocumented',
    ]);
    expect(descriptionIssues({ ...tools[0], description: '' })[0]).toBe('no description');
    expect(descriptionIssues({ ...tools[2], description: 'x'.repeat(MAX_DESCRIPTION_CHARS + 1) })).toEqual([
      'description is very long',
    ]);
    expect(descriptionIssues(tools[2])).toEqual([]);
  });
});

describe('nextBatch', () => {
  it('puts the weakest descriptions first, with parameters and similar tools', () => {
    const batch = nextBatch(tools, newCache(), { mode: 'rewrite', limit: 2 });

    expect(batch.items.map((item) => `${item.server}/${item.tool}`)).toEqual([
      'gh/list_issues',
      'fs/read_file',
    ]);
    expect(batch.remaining).toBe(1);
    expect(batch.items[0].parameters).toEqual({
      repo: { type: 'string', required: true },
      state: { type: 'string', required: false, description: 'state' },
    });
    expect(batch.items[0].similar.map((entry) => entry.tool)).toContain('gh/create_issue');
    expect(batch.guidelines.join(' ')).toContain('Never add a capability');
    expect(batch.answerFormat).toContain('parameters');
  });

  it('skips done tools, but offers compressed ones with issues for rewriting', () => {
    const cache = newCache();
    cache.saveCompressed('gh', 'list_issues', 'Issues.', 'Gets issues.');
    cache.saveCompressed('fs', 'read_file', 'Read a file.', tools[2].description);

    const compress = nextBatch(tools, cache, { mode: 'compress' });
    expect(compress.items.map((item) => item.tool)).toEqual(['create_issue']);
    expect(compress.answerFormat).not.toContain('parameters');

    const rewrite = nextBatch(tools, cache, { mode: 'rewrite' });
    expect(rewrite.items.map((item) => item.tool)).toEqual(['list_issues', 'create_issue']);
    expect(rewrite.items[0]).toMatchObject({ current: 'Issues.' });
    expect(rewrite.items[0]).not.toHaveProperty('currentKind');

    cache.saveCompressed('gh', 'list_issues', 'List issues.', 'Gets issues.', { kind: 'rewritten' });
    expect(nextBatch(tools, cache, { mode: 'rewrite' }).items.map((item) => item.tool)).toEqual(['create_issue']);
    expect(nextBatch(tools, cache, { mode: 'rewrite', all: true }).items).toHaveLength(3);
  });

  it('re-offers a tool whose server changed its original', () => {
    const cache = newCache();
    cache.saveCompressed('fs', 'read_file', 'Read a file.', 'An older original.');
    expect(nextBatch(tools, cache, { mode: 'compress' }).items.map((item) => item.tool)).toContain('read_file');
  });

  it('filters by server or a single tool, which is offered even when done', () => {
    const cache = newCache();
    cache.saveCompressed('fs', 'read_file', 'Read a file.', tools[2].description, { kind: 'rewritten' });
    expect(nextBatch(tools, cache, { server: 'gh' }).items.every((item) => item.server === 'gh')).toBe(true);
    expect(nextBatch(tools, cache, { tool: 'fs/read_file' }).items.map((item) => item.tool)).toEqual(['read_file']);
  });
});

describe('parseProposals', () => {
  it('accepts an array or {tools}, and server/tool in one field', () => {
    expect(parseProposals([{ tool: 'gh/list_issues', description: ' x ' }])[0]).toMatchObject({
      server: 'gh',
      tool: 'list_issues',
      description: 'x',
    });
    expect(parseProposals({ tools: [{ server: 'a', tool: 'b', description: 'c' }] })).toHaveLength(1);
    expect(() => parseProposals({ nope: true })).toThrow('Expected a JSON array');
    expect(parseProposals([null])[0]).toEqual({ raw: null });
  });
});

describe('reviewProposals and applyReview', () => {
  it('accepts a sound rewrite and saves it with its parameters, keeping the original', async () => {
    const cache = newCache();
    const review = await reviewProposals(
      [
        {
          server: 'gh',
          tool: 'list_issues',
          description: 'List issues in one repository, optionally filtered by state.',
          parameters: { state: 'open, closed or all' },
        },
      ],
      tools,
      cache
    );

    expect(review.reviewed[0]).toMatchObject({ accepted: true, problems: [] });
    expect(review.reviewed[0].before.parameters).toEqual({ state: 'state' });
    expect(review.reviewed[0].after.parameters).toEqual({ state: 'open, closed or all' });

    const outcome = applyReview(review, tools, cache);
    expect(outcome.applied).toEqual(['gh/list_issues']);

    const entry = cache.getEntry('gh', 'list_issues');
    expect(entry).toMatchObject({
      original: 'Gets issues.',
      kind: 'rewritten',
      parameters: { state: 'open, closed or all' },
    });

    const schema = cache.applySchemaDescriptions('gh', 'list_issues', tools[0].inputSchema, 'Gets issues.');
    expect(schema).toEqual({
      type: 'object',
      properties: { repo: { type: 'string' }, state: { type: 'string', description: 'open, closed or all' } },
      required: ['repo'],
    });
    // The catalog's schema object is never mutated.
    expect((tools[0].inputSchema as unknown as { properties: { state: { description: string } } }).properties.state.description).toBe('state');
  });

  it('rejects entries that fail a check, and never saves them', async () => {
    const cache = newCache();
    const review = await reviewProposals(
      [
        { server: 'gh', tool: 'nope', description: 'x' },
        { server: 'gh', tool: 'list_issues', description: '' },
        { server: 'gh', tool: 'list_issues', description: 'y'.repeat(MAX_DESCRIPTION_CHARS + 1) },
        { server: 'gh', tool: 'create_issue', description: 'Create an issue.', parameters: { body: 'Body' } },
        { server: 'fs', tool: 'read_file', description: 'Read a file.', parameters: { path: '' } },
        { description: 'no target' },
      ],
      tools,
      cache
    );

    const problems = review.reviewed.map((item) => item.problems.join(' | '));
    expect(problems[0]).toContain('no tool gh/nope');
    expect(problems[1]).toContain('superseded');
    expect(problems[1]).toContain('description is empty');
    expect(problems[2]).toContain('the limit is');
    expect(problems[3]).toContain('parameter "body" is not in the tool');
    expect(problems[4]).toContain('parameter "path" description is empty');
    expect(problems[5]).toContain('missing server or tool');
    expect(review.accepted).toBe(0);

    expect(applyReview(review, tools, cache).applied).toEqual([]);
    expect(cache.getEntry('gh', 'list_issues')).toBeUndefined();
  });

  it('rejects a description that reads like a different tool', async () => {
    const review = await reviewProposals(
      [{ server: 'gh', tool: 'list_issues', description: 'Create a new issue in a GitHub repository with a title and body.' }],
      tools,
      newCache()
    );
    expect(review.reviewed[0].accepted).toBe(false);
    expect(review.reviewed[0].problems[0]).toContain('reads more like gh/create_issue');
  });

  it('holds compressions to compress rules', async () => {
    const review = await reviewProposals(
      [
        { server: 'fs', tool: 'read_file', description: tools[2].description + ' More.' },
        { server: 'gh', tool: 'create_issue', description: 'Create an issue.', parameters: { title: 'Title' } },
      ],
      tools,
      newCache(),
      { mode: 'compress' }
    );
    expect(review.reviewed[0].problems).toContain('a compression must be shorter than the original');
    expect(review.reviewed[1].problems).toContain('parameters can only be changed in rewrite mode');
  });

  it('warns about a much longer rewrite or an unchanged one, without rejecting', async () => {
    const review = await reviewProposals(
      [
        { server: 'gh', tool: 'list_issues', description: `List issues in one repository. ${'Filtered by state. '.repeat(15)}` },
        { server: 'gh', tool: 'create_issue', description: tools[1].description },
      ],
      tools,
      newCache()
    );
    expect(review.reviewed[0].warnings[0]).toContain('longer than the original');
    expect(review.reviewed[1].warnings).toContain('same as the original');
  });

  it('saves compressions as compressed and keeps earlier parameter rewrites', async () => {
    const cache = newCache();
    cache.saveCompressed('gh', 'list_issues', 'Old.', 'Gets issues.', {
      kind: 'rewritten',
      parameters: { repo: 'owner/name' },
    });

    const review = await reviewProposals(
      [{ server: 'gh', tool: 'list_issues', description: 'Issues.' }],
      tools,
      cache,
      { mode: 'compress' }
    );
    applyReview(review, tools, cache);

    expect(cache.getEntry('gh', 'list_issues')).toMatchObject({
      compressed: 'Issues.',
      kind: 'compressed',
      parameters: { repo: 'owner/name' },
    });
  });
});

describe('applySchemaDescriptions', () => {
  it('leaves schemas alone without rewrites, for noCompress tools, and for stale entries', () => {
    const cache = newCache();
    const schema = tools[0].inputSchema;
    expect(cache.applySchemaDescriptions('gh', 'list_issues', schema)).toBe(schema);

    cache.saveCompressed('gh', 'list_issues', 'x', 'Gets issues.', { parameters: { repo: 'owner/name', ghost: 'g' } });
    const applied = cache.applySchemaDescriptions('gh', 'list_issues', schema, 'Gets issues.') as {
      properties: Record<string, { description?: string }>;
    };
    expect(applied.properties.repo.description).toBe('owner/name');
    expect(applied.properties).not.toHaveProperty('ghost');

    expect(cache.applySchemaDescriptions('gh', 'list_issues', schema, 'Changed original.')).toBe(schema);
    expect(cache.applySchemaDescriptions('gh', 'list_issues', { type: 'object' }, 'Gets issues.')).toEqual({
      type: 'object',
    });

    cache.setNoCompressPatterns(['gh__*']);
    expect(cache.applySchemaDescriptions('gh', 'list_issues', schema, 'Gets issues.')).toBe(schema);
  });
});

describe('description rewrite edges', () => {
  const bare: CatalogTool = { serverName: 'x', toolName: 'bare', inputSchema: { type: 'object' } };

  it('handles tools with no description and no properties', () => {
    expect(descriptionIssues(bare)).toEqual(['no description']);
    const batch = nextBatch([...tools, bare], newCache(), { tool: 'x/bare' });
    expect(batch.items[0]).toMatchObject({ original: '', parameters: {} });
    const withBareSimilar = nextBatch([bare, { ...bare, toolName: 'bare_two' }], newCache(), { tool: 'x/bare' });
    expect(withBareSimilar.items[0].similar).toEqual([{ tool: 'x/bare_two', description: '' }]);
  });

  it('rejects a missing description, parameters on an unknown tool, and over-long parameter text', async () => {
    const review = await reviewProposals(
      [
        { server: 'gh', tool: 'list_issues', parameters: { state: 'x'.repeat(401) } },
        { server: 'gh', tool: 'ghost', description: 'x', parameters: { a: 'b' } },
      ],
      tools,
      newCache()
    );
    expect(review.reviewed[0].problems).toEqual([
      'description is empty',
      'parameter "state" description is over 400 chars',
    ]);
    expect(review.reviewed[1].problems).toContain('parameter "a" is not in the tool\'s schema');
  });
});

