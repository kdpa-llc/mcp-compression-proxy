import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { splitWords, stem, tokenize } from '../../src/search/text.js';
import { Bm25Index } from '../../src/search/bm25.js';
import { ToolSearch, type SemanticScorer } from '../../src/search/tool-search.js';
import { MAX_USAGE_RECORDS, UsageLog } from '../../src/search/usage-log.js';
import type { CatalogTool } from '../../src/mcp/tool-catalog.js';
import { SEARCH_CATALOG, SEARCH_QUERIES } from '../fixtures/search-catalog.js';

const catalogTools: CatalogTool[] = SEARCH_CATALOG.map((entry) => ({
  serverName: entry.server,
  toolName: entry.tool,
  description: entry.description,
  inputSchema: { type: 'object' },
}));

const noCompression = { getCompressedDescription: () => undefined };

function searchOver(tools: CatalogTool[], options = {}) {
  return new ToolSearch({ list: async () => tools }, noCompression, options);
}

function keys(result: { hits: Array<{ server: string; tool: string }> }): string[] {
  return result.hits.map((hit) => `${hit.server}/${hit.tool}`);
}

describe('search text', () => {
  it('splits identifiers and keeps acronym plurals whole', () => {
    expect(splitWords('getFileContents')).toEqual(['get', 'file', 'contents']);
    expect(splitWords('github__search_code')).toEqual(['github', 'search', 'code']);
    expect(splitWords('parseHTMLPage')).toEqual(['parse', 'html', 'page']);
    expect(splitWords('which PRs')).toEqual(['which', 'prs']);
  });

  it('stems plurals before suffixes and keeps short roots', () => {
    expect(stem('meetings')).toBe(stem('meeting'));
    expect(stem('directories')).toBe('directory');
    expect(stem('listing')).toBe('list');
    expect(stem('string')).toBe('string');
    expect(stem('class')).toBe('class');
  });

  it('drops stop words, expands abbreviations and maps synonyms', () => {
    expect(tokenize('show the folder')).toEqual(['show', 'directory']);
    expect(tokenize('open PRs')).toEqual(['open', 'pull', 'request']);
    expect(tokenize('remove a repo')).toEqual(['delete', 'repository']);
  });
});

describe('Bm25Index', () => {
  it('ranks name matches above description mentions', () => {
    const index = new Bm25Index([
      { id: 'mentions', name: 'get_status', text: 'Unrelated, though it mentions a directory once.' },
      { id: 'named', name: 'list_directory', text: 'Lists entries.' },
    ]);

    expect(index.search('directory').map((hit) => hit.id)).toEqual(['named', 'mentions']);
  });

  it('returns nothing for an empty index or a query of only stop words', () => {
    expect(new Bm25Index([]).search('anything')).toEqual([]);
    expect(new Bm25Index([{ id: 'a', name: 'a', text: 'b' }]).search('the of')).toEqual([]);
    expect(new Bm25Index([{ id: 'a', name: 'a', text: 'b' }]).size).toBe(1);
  });
});

describe('ToolSearch', () => {
  it('beats plain substring matching on the labelled catalog', async () => {
    const search = searchOver(catalogTools);
    let top1 = 0;
    let top5 = 0;
    let substringTop5 = 0;

    for (const { query, expected } of SEARCH_QUERIES) {
      const ranked = keys(await search.search(query, 50));
      if (ranked[0] === expected) top1++;
      if (ranked.slice(0, 5).includes(expected)) top5++;

      const substring = catalogTools
        .filter((tool) =>
          `${tool.serverName}/${tool.toolName} ${tool.description}`
            .toLowerCase()
            .includes(query.toLowerCase())
        )
        .map((tool) => `${tool.serverName}/${tool.toolName}`);
      if (substring.slice(0, 5).includes(expected)) substringTop5++;
    }

    // Measured at 17/30 and 23/30 when written; the floor leaves room for
    // tokenizer tweaks without letting ranking quietly regress to substring.
    expect(top1).toBeGreaterThanOrEqual(15);
    expect(top5).toBeGreaterThanOrEqual(21);
    expect(top5).toBeGreaterThan(substringTop5 * 3);
  });

  it('puts an exactly named tool first', async () => {
    const search = searchOver(catalogTools);

    expect(keys(await search.search('read_file'))[0]).toBe('filesystem/read_file');
    expect(keys(await search.search('github/search_code'))[0]).toBe('github/search_code');
  });

  it('keeps substring matches the old search found', async () => {
    const search = searchOver(catalogTools);

    // "git_s" is not a token of anything, but it is a substring of git_status.
    expect(keys(await search.search('git_s'))).toContain('git/git_status');
  });

  it('applies the limit but reports the full match count', async () => {
    const result = await searchOver(catalogTools).search('file', 3);

    expect(result.hits).toHaveLength(3);
    expect(result.total).toBeGreaterThan(3);
    expect(result.signals).toEqual(['lexical']);
  });

  it('shortens long descriptions and prefers the compressed one', async () => {
    const long: CatalogTool = {
      serverName: 's',
      toolName: 'long_tool',
      description: 'x'.repeat(100),
      inputSchema: { type: 'object' },
    };
    const plain = await searchOver([long]).search('long_tool');
    expect(plain.hits[0].description).toHaveLength(60);
    expect(plain.hits[0].description.endsWith('...')).toBe(true);

    const compressed = await new ToolSearch({ list: async () => [long] }, {
      getCompressedDescription: () => 'Short.',
    }).search('long_tool');
    expect(compressed.hits[0].description).toBe('Short.');
  });

  it('adds semantic neighbours that share no word with the query', async () => {
    const semantic: SemanticScorer = {
      score: async () =>
        new Map([
          ['memory/create_entities', 0.9],
          ['filesystem/read_file', 0.1],
        ]),
    };
    const result = await searchOver(catalogTools, { semantic }).search(
      'remember a fact about a person'
    );

    expect(result.signals).toContain('semantic');
    // Lexical has nothing for it; the model's top pick ranks with lexical's.
    expect(keys(result).slice(0, 2)).toContain('memory/create_entities');
  });

  it('ranks a tool both signals agree on above one only a single signal likes', async () => {
    const semantic: SemanticScorer = {
      score: async () =>
        new Map([
          ['memory/create_entities', 0.9],
          ['filesystem/move_file', 0.8],
        ]),
    };
    const result = await searchOver(catalogTools, { semantic }).search('rename a file');

    expect(keys(result)[0]).toBe('filesystem/move_file');
  });

  it('falls back to lexical ranking when the model is unavailable or fails', async () => {
    const unavailable: SemanticScorer = { score: async () => undefined };
    const failing: SemanticScorer = { score: async () => Promise.reject(new Error('down')) };

    for (const semantic of [unavailable, failing]) {
      const result = await searchOver(catalogTools, { semantic }).search('rename a file');
      expect(result.signals).toEqual(['lexical']);
      expect(keys(result)[0]).toBe('filesystem/move_file');
    }
  });
});

describe('UsageLog', () => {
  let dir: string;
  let clock: number;

  function makeLog(enabled = true) {
    return new UsageLog(join(dir, 'usage.jsonl'), () => enabled, () => clock);
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'usage-log-'));
    clock = 1_000_000;
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('records the rank of a chosen search result once, in an owner-only file', () => {
    const log = makeLog();
    log.recordSearch('show folder', ['fs/read', 'fs/list']);

    clock += 5_000;
    expect(log.recordSelection('fs', 'list')).toMatchObject({ rank: 2, shown: 2 });
    // info followed by call is one choice, not two.
    expect(log.recordSelection('fs', 'list')).toBeUndefined();

    const file = join(dir, 'usage.jsonl');
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readFileSync(file, 'utf-8').trim().split('\n')).toHaveLength(1);
  });

  it('records a miss when the first choice after a search was not shown', () => {
    const log = makeLog();
    log.recordSearch('show folder', ['fs/read']);

    clock += 10_000;
    expect(log.recordSelection('fs', 'list')).toMatchObject({ rank: null });
    // Only the first choice after a search can be its miss.
    expect(log.recordSelection('fs', 'other')).toBeUndefined();
  });

  it('ignores choices long after any search', () => {
    const log = makeLog();
    log.recordSearch('show folder', ['fs/list']);

    clock += 11 * 60_000;
    expect(log.recordSelection('fs', 'list')).toBeUndefined();
  });

  it('does nothing while disabled', () => {
    const log = makeLog(false);
    log.recordSearch('show folder', ['fs/list']);

    expect(log.recordSelection('fs', 'list')).toBeUndefined();
    expect(log.scores('show folder').size).toBe(0);
  });

  it('boosts tools that past queries with the same words chose', async () => {
    const log = makeLog();
    log.recordSearch('remember a fact about a person', ['filesystem/get_file_info']);
    clock += 1000;
    log.recordSelection('memory', 'create_entities');

    expect(log.scores('remember my manager').get('memory/create_entities')).toBeGreaterThan(0);

    const result = await searchOver(catalogTools, { usage: log }).search('remember this person');
    expect(result.signals).toContain('usage');
    expect(keys(result)[0]).toBe('memory/create_entities');
  });

  it('feeds searches made through ToolSearch into attribution', async () => {
    const log = makeLog();
    await searchOver(catalogTools, { usage: log }).search('rename a file');

    clock += 1000;
    expect(log.recordSelection('filesystem', 'move_file')).toMatchObject({ rank: 1 });
  });

  it('summarises search quality', () => {
    const log = makeLog();
    for (const [chosen, shown] of [
      ['a/one', ['a/one', 'a/two']],
      ['a/two', ['a/one', 'a/two']],
      ['a/three', ['a/one']],
    ] as const) {
      log.recordSearch('q', [...shown]);
      clock += 1000;
      const [server, tool] = chosen.split('/');
      log.recordSelection(server, tool);
      clock += 3 * 60_000;
    }

    expect(log.quality()).toMatchObject({
      selections: 3,
      top1: 1,
      top5: 2,
      misses: 1,
      top1Rate: 33.3,
      top5Rate: 66.7,
      missRate: 33.3,
    });
    expect(makeLog().quality().selections).toBe(3); // persisted
    expect(new UsageLog(join(dir, 'none.jsonl'), () => true).quality().top1Rate).toBe(0);
  });

  it('skips torn lines and keeps the log bounded', () => {
    const file = join(dir, 'usage.jsonl');
    const line = JSON.stringify({ at: 1, query: 'q', server: 's', tool: 't', rank: 1, shown: 1 });
    writeFileSync(file, `${line}\n{"broken\n${Array(MAX_USAGE_RECORDS).fill(line).join('\n')}\n`);

    const log = makeLog();
    expect(log.load()).toHaveLength(MAX_USAGE_RECORDS);

    log.recordSearch('q', ['s/t']);
    log.recordSelection('s', 't');
    expect(readFileSync(file, 'utf-8').trim().split('\n')).toHaveLength(MAX_USAGE_RECORDS);
  });
});

describe('search edges', () => {
  it('ignores a query with no words, and ranks ties by name', async () => {
    const tools: CatalogTool[] = [
      { serverName: 'b', toolName: 'y', description: 'Read files.', inputSchema: { type: 'object' } },
      { serverName: 'a', toolName: 'x', description: 'Read files.', inputSchema: { type: 'object' } },
      { serverName: 'c', toolName: 'z', inputSchema: { type: 'object' } },
    ];
    const search = searchOver(tools);

    expect((await search.search('!!!')).hits).toEqual([]);
    expect(keys(await search.search('read'))).toEqual(['a/x', 'b/y']);
    expect((await search.search('c/z')).hits[0]).toMatchObject({ tool: 'z', description: '' });
  });

  it('orders several usage-boosted tools by strength', async () => {
    const usage = {
      scores: () => new Map([['filesystem/read_file', 0.2], ['git/git_log', 0.9]]),
      recordSearch: () => undefined,
    } as unknown as UsageLog;
    const result = await searchOver(catalogTools, { usage }).search('zzz unmatched');
    expect(keys(result).slice(0, 2)).toEqual(['git/git_log', 'filesystem/read_file']);
  });

  it('scores documents that have no words at all', () => {
    expect(new Bm25Index([{ id: 'a', name: '', text: '' }, { id: 'b', name: 'read', text: '' }]).search('read'))
      .toEqual([{ id: 'b', score: expect.any(Number) }]);
  });
});

describe('UsageLog edges', () => {
  it('keeps only recent searches, skips records it cannot use, and ignores empty queries', () => {
    const dir = mkdtempSync(join(tmpdir(), 'usage-edges-'));
    try {
      const file = join(dir, 'usage.jsonl');
      writeFileSync(file, `${JSON.stringify({ tool: 'x' })}\n`);
      let clock = 0;
      const log = new UsageLog(file, () => true, () => clock);

      expect(log.load()).toEqual([]);
      for (let index = 0; index < 21; index++) log.recordSearch(`q${index}`, [`s/t${index}`]);
      clock += 1000;
      // The oldest search fell out, so its result can no longer be attributed.
      expect(log.recordSelection('s', 't0')).toMatchObject({ rank: null });
      expect(log.recordSelection('s', 't20')).toMatchObject({ rank: 1 });
      expect(log.scores('the of').size).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('search tie-breaks', () => {
  it('orders equal matches by name', async () => {
    const tools: CatalogTool[] = ['xyz_two', 'xyz_one'].map((toolName) => ({
      serverName: 'aa',
      toolName,
      description: 'Unrelated words.',
      inputSchema: { type: 'object' },
    }));
    // "yz" is no token of either, only a substring of both names.
    expect(keys(await searchOver(tools).search('yz_'))).toEqual(['aa/xyz_one', 'aa/xyz_two']);
  });

  it('scores an index whose documents have no words', () => {
    expect(new Bm25Index([{ id: 'a', name: '', text: '' }]).search('read')).toEqual([]);
  });
});

