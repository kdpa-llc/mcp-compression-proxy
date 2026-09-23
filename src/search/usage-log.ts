import { appendFileSync, closeSync, openSync, readSync, renameSync, statSync, writeFileSync } from 'fs';
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
/**
 * Lines the file may hold beyond the bound before it is rewritten, so a full
 * log costs one rewrite per this many choices rather than one per choice.
 */
export const USAGE_TRIM_SLACK = 500;
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
/**
 * The part of the file already read. The native proxy and the mcp-cli daemon
 * append to the same file, so each reads on from here to see the other's
 * choices; a new inode means the file was rewritten and is read again.
 */
interface ReadPosition {
  ino: number;
  offset: number;
  /** Lines in the file, which may exceed the records kept in memory. */
  lines: number;
}

export class UsageLog {
  private readonly recent: RecentSearch[] = [];
  private records: UsageRecord[] = [];
  private position: ReadPosition | undefined;
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
    try {
      // mode applies on creation; umask can only tighten it.
      appendFileSync(this.filePath, JSON.stringify(record) + '\n', { mode: 0o600 });
      this.trimIfNeeded();
    } catch {
      // Learning is best-effort; a read-only home must not fail the call.
      // Keep the choice for this process at least.
      this.records.push(record);
      this.associations = undefined;
    }
    return record;
  }

  /**
   * Rewrite the file with only the newest records once it has grown well past
   * the bound. Written beside it and renamed over it, so a reader never sees
   * half a file; a choice another process appends between the read and the
   * rename is lost, which learning can afford.
   */
  private trimIfNeeded(): void {
    const records = this.load();
    if (!this.position || this.position.lines <= MAX_USAGE_RECORDS + USAGE_TRIM_SLACK) return;
    const temp = `${this.filePath}.${process.pid}.tmp`;
    writeFileSync(temp, records.map((entry) => JSON.stringify(entry)).join('\n') + '\n', {
      mode: 0o600,
    });
    renameSync(temp, this.filePath);
  }

  /**
   * Every stored record, oldest first, including those other processes have
   * appended since the last read. Unparseable lines are skipped.
   */
  load(): UsageRecord[] {
    let stat;
    try {
      stat = statSync(this.filePath);
    } catch {
      // No log yet, or it was deleted: nothing on disk to learn from.
      if (this.position) {
        this.records = [];
        this.position = undefined;
        this.associations = undefined;
      }
      return this.records;
    }

    if (!this.position || this.position.ino !== stat.ino || stat.size < this.position.offset) {
      this.records = [];
      this.position = { ino: stat.ino, offset: 0, lines: 0 };
      this.associations = undefined;
    }
    if (stat.size > this.position.offset) {
      this.readFrom(this.position, stat.size);
    }
    return this.records;
  }

  /** Parse the complete lines between the read position and `size`. */
  private readFrom(position: ReadPosition, size: number): void {
    const buffer = Buffer.alloc(size - position.offset);
    const fd = openSync(this.filePath, 'r');
    let read: number;
    try {
      read = readSync(fd, buffer, 0, buffer.length, position.offset);
    } finally {
      closeSync(fd);
    }
    // A line still being appended has no newline yet; it is read next time.
    const end = buffer.subarray(0, read).lastIndexOf(0x0a);
    if (end === -1) return;

    for (const line of buffer.subarray(0, end).toString('utf-8').split('\n')) {
      if (!line.trim()) continue;
      position.lines++;
      try {
        const parsed = JSON.parse(line) as UsageRecord;
        if (typeof parsed.query === 'string' && typeof parsed.tool === 'string') {
          this.records.push(parsed);
        }
      } catch {
        // A torn write leaves one bad line; the rest is still good.
      }
    }
    position.offset += end + 1;
    if (this.records.length > MAX_USAGE_RECORDS) {
      this.records = this.records.slice(-MAX_USAGE_RECORDS);
    }
    this.associations = undefined;
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
    this.load(); // picks up other processes' choices, and resets associations if any
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
