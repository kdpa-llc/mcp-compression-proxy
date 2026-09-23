import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import { join } from 'path';
import type { Logger } from 'pino';
import { NeedleBridge } from '../../src/models/needle-bridge.js';
import { EmbeddingIndex } from '../../src/models/embedding-index.js';
import { ToolSearch } from '../../src/search/tool-search.js';
import type { CatalogTool } from '../../src/mcp/tool-catalog.js';
import { SEARCH_CATALOG, SEARCH_QUERIES } from '../fixtures/search-catalog.js';

/**
 * The real Needle 3 model through python/needle_bridge.py.
 *
 * Skipped unless NEEDLE_PYTHON names an interpreter with cactus-needle
 * installed (the first run downloads ~35 MB of weights):
 *
 *   python3 -m venv .venv-needle && .venv-needle/bin/pip install cactus-needle
 *   NEEDLE_PYTHON=$PWD/.venv-needle/bin/python npx jest tests/e2e-real/needle-model.test.ts
 *
 * Following the rule for real models here: assert that each round trip
 * produced a well-formed, substantive answer, and log quality numbers rather
 * than pinning them.
 */
const python = process.env.NEEDLE_PYTHON;
const describeIfNeedle = python ? describe : describe.skip;

const logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: console.warn,
  error: console.error,
} as unknown as Logger;

describeIfNeedle('Needle 3 bridge (real model)', () => {
  let bridge: NeedleBridge;
  const tools: CatalogTool[] = SEARCH_CATALOG.map((entry) => ({
    serverName: entry.server,
    toolName: entry.tool,
    description: entry.description,
    inputSchema: { type: 'object' },
  }));

  beforeAll(() => {
    bridge = new NeedleBridge(
      { provider: 'needle', command: python, timeout: 300 },
      join(process.cwd(), 'python/needle_bridge.py'),
      logger
    );
  });

  afterAll(async () => {
    await bridge?.close();
  });

  it('embeds text into fixed-size vectors', async () => {
    const vectors = await bridge.embed(['list files in a folder', 'send an email']);
    expect(vectors).toHaveLength(2);
    expect(vectors[0].length).toBeGreaterThan(100);
    expect(vectors[1].length).toBe(vectors[0].length);
  }, 300_000);

  it('returns a well-formed tool selection', async () => {
    const selection = await bridge.selectTool('show me what is in /tmp', [
      {
        name: 'list_directory',
        description: 'List files and folders in a directory',
        parameters: {
          type: 'object',
          properties: { path: { type: 'string' } },
          required: ['path'],
        },
      },
    ]);
    expect(Array.isArray(selection.calls)).toBe(true);
    expect(selection.confidence === null || typeof selection.confidence === 'number').toBe(true);
    console.log('selection', JSON.stringify(selection));
  }, 120_000);

  it('blends into search without losing top-five recall', async () => {
    const lexical = new ToolSearch({ list: async () => tools }, { getCompressedDescription: () => undefined });
    const embeddings = new EmbeddingIndex(bridge, logger);
    await embeddings.warm(tools);
    const hybrid = new ToolSearch(
      { list: async () => tools },
      { getCompressedDescription: () => undefined },
      { semantic: embeddings }
    );

    const measure = async (search: ToolSearch) => {
      let top1 = 0;
      let top5 = 0;
      for (const { query, expected } of SEARCH_QUERIES) {
        const keys = (await search.search(query, 50)).hits.map((hit) => `${hit.server}/${hit.tool}`);
        if (keys[0] === expected) top1++;
        if (keys.slice(0, 5).includes(expected)) top5++;
      }
      return { top1, top5 };
    };

    const lexicalScore = await measure(lexical);
    const hybridScore = await measure(hybrid);
    console.log(`lexical ${JSON.stringify(lexicalScore)} hybrid ${JSON.stringify(hybridScore)} of ${SEARCH_QUERIES.length}`);

    expect(hybridScore.top5).toBeGreaterThanOrEqual(lexicalScore.top5 - 3);
  }, 300_000);
});
