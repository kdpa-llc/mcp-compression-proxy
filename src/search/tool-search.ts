import type { CatalogTool } from '../mcp/tool-catalog.js';
import { Bm25Index } from './bm25.js';
import { splitWords } from './text.js';
import { toolKey, type UsageLog } from './usage-log.js';

/**
 * Similarity of each tool to a query from a model, keyed `server/tool`.
 * Returns undefined while the model is unavailable or still indexing, so
 * search degrades to lexical ranking instead of waiting.
 */
export interface SemanticScorer {
  score(query: string, tools: CatalogTool[]): Promise<Map<string, number> | undefined>;
}

export interface ToolSearchHit {
  server: string;
  tool: string;
  description: string;
  score: number;
}

export interface ToolSearchResult {
  hits: ToolSearchHit[];
  /** Matches before the limit was applied. */
  total: number;
  /** Which signals contributed: lexical always, semantic and usage when available. */
  signals: Array<'lexical' | 'semantic' | 'usage'>;
}

export const DEFAULT_SEARCH_LIMIT = 15;
/** Semantic neighbours taken as candidates even without a shared word. */
const SEMANTIC_CANDIDATES = 10;
/**
 * Reciprocal rank fusion constant. Small because catalogs are small: the
 * difference between rank 1 and rank 3 should matter.
 */
const RRF_K = 10;
/**
 * Semantic similarity counts half as much as a lexical match. Measured with
 * Needle 3 on tests/fixtures/search-catalog.ts (30 queries): lexical alone
 * put the right tool first 17 times and in the top five 23 times; equal
 * weights gave 14 and 26; half weight 15 and 26. Search shows a list, so the
 * top-five gain is worth the small top-one cost.
 */
const WEIGHTS = { lexical: 1, semantic: 0.5, usage: 0.5 };

function normalise(text: string): string {
  return splitWords(text).join(' ');
}

/**
 * Ranked tool search: BM25 over names and descriptions, fused with model
 * similarity and learned usage when those are available.
 *
 * Every signal is optional except the lexical one, so search works with no
 * model installed and nothing recorded, and each added signal can only add
 * candidates and reorder them.
 */
export class ToolSearch {
  constructor(
    private readonly catalog: { list(): Promise<CatalogTool[]> },
    private readonly compression: {
      getCompressedDescription(
        serverName: string,
        toolName: string,
        liveOriginal?: string
      ): string | undefined;
    },
    private readonly options: { usage?: UsageLog; semantic?: SemanticScorer } = {}
  ) {}

  /**
   * `record: false` keeps internal lookups (suggest, lazy-mode helpers) out of
   * the usage log, whose quality numbers describe searches agents made.
   */
  async search(
    query: string,
    limit = DEFAULT_SEARCH_LIMIT,
    options: { record?: boolean } = {}
  ): Promise<ToolSearchResult> {
    const tools = await this.catalog.list();
    const byKey = new Map(tools.map((tool) => [toolKey(tool.serverName, tool.toolName), tool]));
    const signals: ToolSearchResult['signals'] = ['lexical'];
    const fused = new Map<string, number>();
    const add = (key: string, weight: number, rank: number) => {
      fused.set(key, (fused.get(key) ?? 0) + weight / (RRF_K + rank));
    };

    const index = new Bm25Index(
      tools.map((tool) => ({
        id: toolKey(tool.serverName, tool.toolName),
        name: `${tool.serverName} ${tool.toolName} ${tool.title ?? ''}`,
        text: `${tool.description ?? ''} ${
          this.compression.getCompressedDescription(tool.serverName, tool.toolName, tool.description) ?? ''
        }`,
      }))
    );
    index.search(query).forEach((hit, rank) => add(hit.id, WEIGHTS.lexical, rank + 1));

    const semantic = await this.options.semantic?.score(query, tools).catch(() => undefined);
    if (semantic && semantic.size > 0) {
      signals.push('semantic');
      [...semantic]
        .sort((a, b) => b[1] - a[1])
        .slice(0, SEMANTIC_CANDIDATES)
        .forEach(([key], rank) => add(key, WEIGHTS.semantic, rank + 1));
    }

    const usage = this.options.usage?.scores(query);
    if (usage && usage.size > 0) {
      signals.push('usage');
      [...usage]
        .filter(([key]) => byKey.has(key))
        .sort((a, b) => b[1] - a[1])
        .forEach(([key], rank) => add(key, WEIGHTS.usage, rank + 1));
    }

    // Someone who types a tool's exact name wants that tool first, whatever
    // the descriptions say. Substring matches keep the old search's recall.
    const needle = normalise(query);
    if (needle) {
      for (const [key, tool] of byKey) {
        const name = normalise(tool.toolName);
        const full = normalise(`${tool.serverName} ${tool.toolName}`);
        if (name === needle || full === needle) {
          add(key, 10, 0);
        } else if (full.includes(needle)) {
          add(key, WEIGHTS.lexical, RRF_K);
        }
      }
    }

    const ranked = [...fused]
      .filter(([key]) => byKey.has(key))
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));

    const hits = ranked.slice(0, Math.max(1, limit)).map(([key, score]) => {
      const tool = byKey.get(key) as CatalogTool;
      const description =
        this.compression.getCompressedDescription(tool.serverName, tool.toolName, tool.description) ||
        tool.description ||
        '';
      return {
        server: tool.serverName,
        tool: tool.toolName,
        description: description.length > 60 ? description.slice(0, 57) + '...' : description,
        score: Math.round(score * 1000) / 1000,
      };
    });

    if (options.record !== false) {
      this.options.usage?.recordSearch(
        query,
        hits.map((hit) => toolKey(hit.server, hit.tool))
      );
    }

    return { hits, total: ranked.length, signals };
  }
}
