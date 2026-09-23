import { appendFileSync, readFileSync, writeFileSync } from 'fs';
import { tokenize } from './text.js';

/**
 * One search that was followed by the agent choosing a tool.
 *
 * `rank` is the 1-based position the chosen tool had in that search's
 * results, or null when the agent went on to use a tool the search never
 * showed - a miss.
 */
export interface UsageRecord {
  at: number;
  query: string;
  server: string;
  tool: string;
  rank: number | null;
  shown: number;
}

export interface SearchQuality {
  selections: number;
  top1: number;
  top5: number;
  misses: number;
  top1Rate: number;
  top5Rate: number;
  missRate: number;
  topTools: Array<{ tool: string; selections: number }>;
}

interface RecentSearch {
  query: string;
  keys: string[];
  at: number;
  selected: Set<string>;
}

/** Keep the log bounded; older choices matter less than recent ones anyway. */
export const MAX_USAGE_RECORDS = 5000;
/** A tool chosen this long after a search that listed it still counts. */
const ATTRIBUTION_WINDOW_MS = 10 * 60_000;
/** A first choice this soon after a search that did not list it is a miss. */
const MISS_WINDOW_MS = 2 * 60_000;
const MAX_RECENT_SEARCHES = 20;

export function toolKey(server: string, tool: string): string {
  return `${server}/${tool}`;
}

/**
 * Learns from the search -> info/call sequence the CLI produces anyway.
 *
 * A search followed by using one of its results is a labelled example of
 * which tool a query meant. Recorded locally (owner-only file) and only when
 * enabled, the pairs give two things: a boost for tools that past queries
 * with the same words ended up choosing, and real numbers for how often the
 * chosen tool was ranked first or in the top five.
 */
export class UsageLog {
  private readonly recent: RecentSearch[] = [];
  private records: UsageRecord[] | undefined;
  private associations:
    | { tokens: Map<string, Map<string, number>>; tools: Map<string, number> }
    | undefined;

  constructor(
    private readonly filePath: string,
    private readonly isEnabled: () => boolean,
    private readonly now: () => number = Date.now
  ) {}

  /** Remember what a search showed, so a later choice can be attributed to it. */
  recordSearch(query: string, keys: string[]): void {
    if (!this.isEnabled()) return;
    this.recent.push({ query, keys, at: this.now(), selected: new Set() });
    if (this.recent.length > MAX_RECENT_SEARCHES) {
      this.recent.shift();
    }
  }

  /** The agent inspected or called a tool. Returns the record written, if any. */
  recordSelection(server: string, tool: string): UsageRecord | undefined {
    if (!this.isEnabled()) return undefined;
    const key = toolKey(server, tool);
    const now = this.now();

    for (let index = this.recent.length - 1; index >= 0; index--) {
      const search = this.recent[index];
      if (now - search.at > ATTRIBUTION_WINDOW_MS) break;
      const position = search.keys.indexOf(key);
      if (position === -1) continue;
      if (search.selected.has(key)) return undefined; // info then call: one choice
      search.selected.add(key);
      return this.append({
        at: now,
        query: search.query,
        server,
        tool,
        rank: position + 1,
        shown: search.keys.length,
      });
    }

    // The agent went straight to a tool the last search did not show.
    const last = this.recent.at(-1);
    if (last && now - last.at <= MISS_WINDOW_MS && last.selected.size === 0) {
      last.selected.add(key);
      return this.append({
        at: now,
        query: last.query,
        server,
        tool,
        rank: null,
        shown: last.keys.length,
      });
    }
    return undefined;
  }

  private append(record: UsageRecord): UsageRecord {
    const records = this.load();
    records.push(record);
    this.associations = undefined;

    try {
      if (records.length > MAX_USAGE_RECORDS) {
        records.splice(0, records.length - MAX_USAGE_RECORDS);
        writeFileSync(
          this.filePath,
          records.map((entry) => JSON.stringify(entry)).join('\n') + '\n',
          { mode: 0o600 }
        );
      } else {
        // mode applies on creation; umask can only tighten it.
        appendFileSync(this.filePath, JSON.stringify(record) + '\n', { mode: 0o600 });
      }
    } catch {
      // Learning is best-effort; a read-only home must not fail the call.
    }
    return record;
  }

  /** Every stored record, oldest first. Unparseable lines are skipped. */
  load(): UsageRecord[] {
    if (this.records) return this.records;
    const records: UsageRecord[] = [];
    try {
      for (const line of readFileSync(this.filePath, 'utf-8').split('\n')) {
        if (!line.trim()) continue;
        try {
          const parsed = JSON.parse(line) as UsageRecord;
          if (typeof parsed.query === 'string' && typeof parsed.tool === 'string') {
            records.push(parsed);
          }
        } catch {
          // A torn write leaves one bad line; the rest is still good.
        }
      }
    } catch {
      // No log yet.
    }
    this.records = records.slice(-MAX_USAGE_RECORDS);
    return this.records;
  }

  /**
   * How strongly past queries sharing words with this one chose each tool.
   * Keys are `server/tool`; tools never chosen are absent.
   */
  scores(query: string): Map<string, number> {
    const scores = new Map<string, number>();
    if (!this.isEnabled()) return scores;
    const { tokens } = this.buildAssociations();
    const queryTokens = [...new Set(tokenize(query))];
    if (queryTokens.length === 0) return scores;

    for (const token of queryTokens) {
      for (const [key, count] of tokens.get(token) ?? []) {
        scores.set(key, (scores.get(key) ?? 0) + Math.log(1 + count) / queryTokens.length);
      }
    }
    return scores;
  }

  private buildAssociations() {
    if (this.associations) return this.associations;
    const tokens = new Map<string, Map<string, number>>();
    const tools = new Map<string, number>();
    for (const record of this.load()) {
      // A miss still says which tool the words meant.
      const key = toolKey(record.server, record.tool);
      tools.set(key, (tools.get(key) ?? 0) + 1);
      for (const token of new Set(tokenize(record.query))) {
        const perTool = tokens.get(token) ?? new Map<string, number>();
        perTool.set(key, (perTool.get(key) ?? 0) + 1);
        tokens.set(token, perTool);
      }
    }
    this.associations = { tokens, tools };
    return this.associations;
  }

  /** How often the chosen tool was ranked first, in the top five, or not shown. */
  quality(): SearchQuality {
    const records = this.load();
    const selections = records.length;
    const top1 = records.filter((record) => record.rank === 1).length;
    const top5 = records.filter((record) => record.rank !== null && record.rank <= 5).length;
    const misses = records.filter((record) => record.rank === null).length;
    const rate = (count: number) =>
      selections === 0 ? 0 : Math.round((count / selections) * 1000) / 10;

    const topTools = [...this.buildAssociations().tools]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, 10)
      .map(([tool, count]) => ({ tool, selections: count }));

    return {
      selections,
      top1,
      top5,
      misses,
      top1Rate: rate(top1),
      top5Rate: rate(top5),
      missRate: rate(misses),
      topTools,
    };
  }
}
