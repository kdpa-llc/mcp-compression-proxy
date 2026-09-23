import { describe, it, expect, jest } from '@jest/globals';
import {
  chunkText,
  findList,
  project,
  rankItems,
  shapeOutput,
  shapeToSchema,
  splitBlocks,
} from '../../src/services/output-shaper.js';
import type { ModelBackend, ModelExtraction } from '../../src/models/types.js';

const issues = [
  { number: 1, title: 'Login fails with SSO', state: 'open', user: { login: 'alice' }, labels: ['auth'] },
  { number: 2, title: 'Dark mode colours', state: 'closed', user: { login: 'bob' }, labels: [] },
  { number: 3, title: 'Session token expires too early', state: 'open', user: { login: 'carol' }, labels: ['auth'] },
  { number: 4, title: 'Typo in README', state: 'open', user: null, labels: ['docs'] },
];

/** A word-overlap model: one dimension per vocabulary word, plus a shared offset. */
function stubModel(extractions: Array<Partial<ModelExtraction>> = []) {
  const vocabulary = ['login', 'session', 'token', 'auth', 'authentication', 'sso', 'readme', 'colours'];
  const embed = jest.fn(async (texts: string[]) =>
    texts.map((text) => {
      const lower = text.toLowerCase();
      const vector = new Float32Array(vocabulary.length + 1);
      vocabulary.forEach((word, index) => {
        if (lower.includes(word)) vector[index] = 1;
      });
      // "authentication" should land near login/session/token issues.
      if (lower.includes('authentication')) {
        vector[0] = vector[1] = vector[2] = 1;
      }
      vector[vocabulary.length] = 3;
      return vector;
    })
  );
  let call = 0;
  const extract = jest.fn(async (_text: string, _schema: unknown) => ({
    calls: [],
    suppressed: [],
    confidence: 0.8,
    ungrounded: [],
    value: null,
    withheld: false,
    ...(extractions[call++] ?? {}),
  }));
  return { embed, extract } as unknown as Pick<ModelBackend, 'embed' | 'extract'> & {
    embed: typeof embed;
    extract: typeof extract;
  };
}

describe('project', () => {
  it('keeps requested keys, matching case, separators and dotted paths', () => {
    const found = { issues: [] as string[], missing: [] as string[], mismatched: [] as string[] };
    const result = project(
      { Number: 7, created_at: '2026-01-01', user: { login: 'alice' } },
      { number: 'integer', createdAt: 'string', 'user.login': 'string', gone: 'string?' },
      '',
      found
    );
    expect(result).toEqual({ number: 7, createdAt: '2026-01-01', 'user.login': 'alice', gone: null });
    expect(found.missing).toEqual([]);
  });

  it('reports missing and mismatched fields without inventing values', () => {
    const report = { missing: [] as string[], mismatched: [] as string[] };
    const result = project(
      { a: 'x', c: 'maybe', d: 5 },
      { a: 'integer', b: 'string', c: 'yes|no', d: { e: 'string' } },
      '',
      report
    );
    expect(result).toEqual({ a: 'x', b: null, c: 'maybe', d: null });
    expect(report.missing).toEqual(['/b']);
    expect(report.mismatched).toEqual(['/a', '/c', '/d']);
  });

  it('maps list shapes and object shapes over arrays', () => {
    const report = { missing: [] as string[], mismatched: [] as string[] };
    expect(project([{ a: 1 }, { a: 2 }], { a: 'number' }, '', report)).toEqual([{ a: 1 }, { a: 2 }]);
    expect(project({ a: 1 }, [{ a: 'number' }], '', report)).toEqual([{ a: 1 }]);
    expect(project(null, [{ a: 'number' }], '/x', report)).toBeNull();
    expect(report.missing).toEqual(['/x']);
    expect(project([true], ['boolean'], '', report)).toEqual([true]);
    expect(project({ v: [1] }, { v: 'array', w: 'any?', o: 'object?' }, '', report)).toEqual({
      v: [1],
      w: null,
      o: null,
    });
  });

  it('rejects malformed shapes with a usable message', () => {
    const report = { missing: [], mismatched: [] };
    expect(() => project({}, { a: 'date' }, '', report)).toThrow('Unknown type "date"');
    expect(() => project([], [{ a: 'string' }, { b: 'string' }], '', report)).toThrow('exactly one element');
    expect(() => project({}, 5, '', report)).toThrow('want must be');
  });
});

describe('findList', () => {
  it('finds a top-level list, a conventional key, or the largest array', () => {
    expect(findList([1])?.path).toBe('');
    expect(findList({ total: 2, Items: [1, 2] })?.path).toBe('/items');
    expect(findList({ a: [1], b: [1, 2, 3] })).toEqual({ items: [1, 2, 3], path: '/b' });
    expect(findList({ a: 1 })).toBeUndefined();
    expect(findList('text')).toBeUndefined();
  });
});

describe('shapeOutput on JSON', () => {
  it('projects the documented example shape without a model', async () => {
    const output = JSON.stringify({ total: 4, items: issues });
    const result = await shapeOutput(output, {
      want: { items: [{ number: 'integer', title: 'string', 'user.login': 'string?' }] },
    });

    expect(result.meta.method).toBe('projection');
    expect(result.data).toEqual({
      items: [
        { number: 1, title: 'Login fails with SSO', 'user.login': 'alice' },
        { number: 2, title: 'Dark mode colours', 'user.login': 'bob' },
        { number: 3, title: 'Session token expires too early', 'user.login': 'carol' },
        { number: 4, title: 'Typo in README', 'user.login': null },
      ],
    });
    expect(result.meta.items).toEqual({ total: 4, kept: 4, sourceIndexes: [0, 1, 2, 3] });
    expect(result.meta.missing).toEqual([]);
  });

  it('accepts want as a JSON string, as the CLI passes it', async () => {
    const result = await shapeOutput(JSON.stringify(issues), { want: '[{"number":"integer"}]' });
    expect(result.data).toEqual([{ number: 1 }, { number: 2 }, { number: 3 }, { number: 4 }]);
  });

  it('keeps the items that share words with where, and says where they came from', async () => {
    const result = await shapeOutput(JSON.stringify({ items: issues }), {
      want: { count: 'integer?', items: [{ number: 'integer' }] },
      where: 'auth',
    });

    expect(result.data).toEqual({ count: null, items: [{ number: 1 }, { number: 3 }] });
    expect(result.meta.filter).toEqual({ where: 'auth', ranking: 'lexical' });
    expect(result.meta.items).toMatchObject({ total: 4, kept: 2 });
    expect(result.meta.items?.sourceIndexes.sort()).toEqual([0, 2]);
    expect(result.meta.arrayPath).toBe('/items');
  });

  it('adds paraphrased matches when a model ranks by meaning', async () => {
    const model = stubModel();
    const result = await shapeOutput(
      JSON.stringify(issues.map(({ number, title }) => ({ number, title }))),
      { where: 'authentication problems', limit: 3 },
      model
    );

    expect(result.meta.method).toBe('filter-only');
    expect(result.meta.filter?.ranking).toBe('lexical+semantic');
    // No title contains "authentication"; the closest by meaning survives,
    // and unrelated items are dropped rather than padding the list to limit.
    const numbers = (result.data as Array<{ number: number }>).map((issue) => issue.number);
    expect(numbers).toContain(3);
    expect(numbers).not.toContain(2);
    expect(numbers).not.toContain(4);
  });

  it('projects a plain object and filters a bare list', async () => {
    const single = await shapeOutput(JSON.stringify(issues[0]), { want: { title: 'string' } });
    expect(single.data).toEqual({ title: 'Login fails with SSO' });

    const filtered = await shapeOutput(JSON.stringify(issues), { where: 'readme' });
    expect(filtered.data).toEqual([issues[3]]);
  });

  it('explains when where has no list to act on', async () => {
    const result = await shapeOutput(JSON.stringify({ a: 1 }), { want: { a: 'number' }, where: 'x' });
    expect(result.data).toEqual({ a: 1 });
    expect(result.meta.notes.join(' ')).toContain('No list found');

    const onlyWhere = await shapeOutput(JSON.stringify({ a: 1 }), { where: 'x' });
    expect(onlyWhere.meta.method).toBe('filter-only');
    expect(onlyWhere.data).toEqual({ a: 1 });
  });

  it('returns the output unchanged when asked for nothing', async () => {
    const result = await shapeOutput('hello', {});
    expect(result.data).toBe('hello');
    expect(result.meta.notes[0]).toContain('Nothing to shape');
  });

  it('falls back to lexical ranking when the model fails', async () => {
    const model = stubModel();
    model.embed.mockRejectedValue(new Error('bridge down'));
    const result = await shapeOutput(JSON.stringify(issues), { where: 'readme' }, model);
    expect(result.meta.filter?.ranking).toBe('lexical');
    expect(result.meta.notes.join(' ')).toContain('bridge down');
  });
});

describe('shapeOutput on text', () => {
  const text = [
    'number: 12, title: Broken build',
    '',
    'Unrelated chatter about lunch.',
    '',
    'number: 13, title: Flaky auth test',
  ].join('\n');

  it('needs the model to extract fields from text and says so', async () => {
    const result = await shapeOutput(text, { want: { title: 'string' } });
    expect(result.data).toBeNull();
    expect(result.meta.method).toBe('none');
    expect(result.meta.notes[0]).toContain('needs the local model');
  });

  it('filters text blocks without a model', async () => {
    const result = await shapeOutput(text, { where: 'auth test' });
    expect(result.data).toEqual(['number: 13, title: Flaky auth test']);
    expect(result.meta.items).toMatchObject({ total: 3, kept: 1 });
  });

  it('extracts one record per block, with the lowest confidence reported', async () => {
    const model = stubModel([
      { value: { number: 12, title: 'Broken build' }, confidence: 0.9 },
      { value: null },
      { value: { number: 13, title: 'Flaky auth test' }, confidence: 0.6, withheld: true },
    ]);
    const result = await shapeOutput(text, { want: [{ number: 'integer', title: 'string' }] }, model);

    expect(result.meta.method).toBe('model-extraction');
    expect(result.data).toEqual([
      { number: 12, title: 'Broken build' },
      { number: 13, title: 'Flaky auth test' },
    ]);
    expect(result.meta.confidence).toBe(0.6);
    expect(result.meta.items).toEqual({ total: 3, kept: 2, sourceIndexes: [0, 2] });
    expect(result.meta.notes.join(' ')).toContain('low-confidence');
    expect(model.extract).toHaveBeenCalledWith(
      'number: 12, title: Broken build',
      expect.objectContaining({
        parameters: {
          type: 'object',
          properties: { number: { type: 'integer' }, title: { type: 'string' } },
          required: ['number', 'title'],
        },
      })
    );
  });

  it('narrows blocks with where and caps extraction at the limit', async () => {
    const model = stubModel([{ value: { title: 'Flaky auth test' }, confidence: 0.7 }]);
    const many = Array.from({ length: 5 }, (_unused, index) => `title: auth item ${index}`).join('\n\n');

    const result = await shapeOutput(many, { want: [{ title: 'string' }], where: 'auth', limit: 2 }, model);

    expect(model.extract).toHaveBeenCalledTimes(2);
    expect(result.meta.filter?.where).toBe('auth');
    expect(result.meta.items?.total).toBe(5);
  });

  it('merges a single record across chunks of a long text', async () => {
    const model = stubModel([
      { value: { title: 'First', owner: null }, confidence: 0.9 },
      { value: { title: 'Second', owner: 'dana' }, confidence: 0.5 },
    ]);
    const long = `title: First\n${'filler line\n'.repeat(300)}owner: dana`;

    const result = await shapeOutput(long, { want: { title: 'string', owner: 'string' } }, model);

    expect(result.data).toEqual({ title: 'First', owner: 'dana' });
    expect(result.meta.confidence).toBe(0.5);
  });

  it('reports when the model finds nothing', async () => {
    const model = stubModel([{ value: null, withheld: true }]);
    const result = await shapeOutput('nothing here', { want: { title: 'string' } }, model);
    expect(result.data).toBeNull();
    expect(result.meta.notes.join(' ')).toContain('found none of the requested fields');
  });
});

describe('helpers', () => {
  it('turns a shape into a JSON schema for the model', () => {
    expect(shapeToSchema({ state: 'open|closed', tags: 'array?', n: 'any', list: ['string'] })).toEqual({
      type: 'object',
      properties: {
        state: { type: 'string', enum: ['open', 'closed'] },
        tags: { type: 'array', items: { type: 'string' } },
        n: { type: 'string' },
        list: { type: 'array', items: { type: 'string' } },
      },
      required: ['state', 'n', 'list'],
    });
    expect(() => shapeToSchema(3)).toThrow('want must be');
  });

  it('chunks long text on line boundaries with overlap', () => {
    const text = Array.from({ length: 100 }, (_unused, index) => `line ${index}`).join('\n');
    const chunks = chunkText(text, 200, 20);
    expect(chunks.length).toBeGreaterThan(3);
    expect(chunks.every((chunk) => chunk.length <= 200)).toBe(true);
    expect(chunks.join('')).toContain('line 99');
    expect(chunkText('short')).toEqual(['short']);
  });

  it('splits text into paragraphs, else lines', () => {
    expect(splitBlocks('a\n\nb\n')).toEqual(['a', 'b']);
    expect(splitBlocks('a\nb\n')).toEqual(['a', 'b']);
  });

  it('does not let a two-item list invert meaning-based ranking', async () => {
    // Vectors from a real failure: centering two items on their own mean made
    // the item that shared nothing with "login" score as the better match.
    const vector = (entries: Record<number, number>) => {
      const result = new Float32Array(64);
      for (const [dim, value] of Object.entries(entries)) result[Number(dim)] = value;
      return result;
    };
    const vectors = [
      vector({ 9: 1, 36: 1, 41: 1, 50: 1, 53: 2, 58: 1, 63: 0.5 }),
      vector({ 1: 1, 5: 1, 9: 1, 18: 1, 53: 1, 63: 0.5 }),
      vector({ 50: 1, 63: 0.5 }),
    ];
    const embed = jest.fn(async (texts: string[]) =>
      texts.length === 2 ? vectors.slice(0, 2) : [vectors[2]]
    );

    const ranked = await rankItems(['{"title":"Login"}', '{"title":"Dark"}'], 'unmatched words', 5, { embed });

    expect(ranked.ranking).toBe('lexical+semantic');
    expect(ranked.indexes).toEqual([0]);
  });

  it('ranks nothing for an empty list', async () => {
    const ranked = await rankItems([], 'q', 5);
    expect(ranked.indexes).toEqual([]);
  });
});
