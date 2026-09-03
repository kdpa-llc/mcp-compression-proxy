import { createHash } from 'crypto';
import {
  existsSync,
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

export const DEFAULT_PAYLOAD_THRESHOLD = 10_000;
export const DEFAULT_PAYLOAD_READ_LENGTH = 10_000;

export interface PayloadReference {
  id: string;
  path: string;
  chars: number;
  createdAt: number;
}

export interface CapturedPayload {
  output: string;
  reference?: PayloadReference;
}

export interface PayloadReadResult {
  id: string;
  content: string;
  offset: number;
  nextOffset: number;
  totalChars: number;
  eof: boolean;
}

export interface PayloadFindMatch {
  offset: number;
  line: number;
  match: string;
  context: string;
}

export interface PayloadFindResult {
  id: string;
  query: string;
  totalChars: number;
  matches: PayloadFindMatch[];
  truncated: boolean;
}

interface PayloadEntry extends PayloadReference {
  hash: string;
}

export interface PayloadStoreOptions {
  maxEntries?: number;
  directory?: string;
  removeDirectoryOnDestroy?: boolean;
}

/**
 * Process-local, file-backed storage for large MCP outputs.
 *
 * Handles, not paths, are accepted by read/find operations so callers cannot
 * use the daemon as an arbitrary local-file reader. Files live in a private
 * 0700 temp directory and are written 0600.
 */
export class PayloadStore {
  private readonly maxEntries: number;
  private readonly configuredDirectory: string | undefined;
  private readonly removeDirectoryOnDestroy: boolean;
  private readonly entries = new Map<string, PayloadEntry>();
  private payloadDir: string | undefined;

  constructor(options: PayloadStoreOptions = {}) {
    this.maxEntries = Math.max(1, options.maxEntries ?? 100);
    this.configuredDirectory = options.directory;
    this.removeDirectoryOnDestroy =
      options.removeDirectoryOnDestroy ??
      options.directory === undefined;
  }

  private getPayloadDir(): string {
    if (this.payloadDir === undefined) {
      if (this.configuredDirectory) {
        mkdirSync(this.configuredDirectory, {
          recursive: true,
          mode: 0o700,
        });
        // Tighten an existing directory created under a permissive umask.
        const mode = statSync(this.configuredDirectory).mode & 0o777;
        if (mode !== 0o700) {
          chmodSync(this.configuredDirectory, 0o700);
        }
        this.payloadDir = this.configuredDirectory;
      } else {
        this.payloadDir = mkdtempSync(join(tmpdir(), 'mcp-output-'));
      }
    }
    return this.payloadDir;
  }

  private getEntry(id: string): PayloadEntry {
    if (!/^[a-f0-9]{16,64}$/.test(id)) {
      throw new Error(`Payload '${id}' not found or expired`);
    }

    let entry = this.entries.get(id);
    if (!entry) {
      const path = join(this.getPayloadDir(), `mcp_output_${id}.txt`);
      if (existsSync(path)) {
        const content = readFileSync(path, 'utf-8');
        const stat = statSync(path);
        entry = {
          id,
          path,
          chars: content.length,
          createdAt: stat.mtimeMs,
          hash: createHash('sha256').update(content).digest('hex'),
        };
        this.entries.set(id, entry);
      }
    }

    if (!entry || !existsSync(entry.path)) {
      this.entries.delete(id);
      throw new Error(`Payload '${id}' not found or expired`);
    }
    return entry;
  }

  private refreshEntries(): void {
    const directory = this.getPayloadDir();
    for (const filename of readdirSync(directory)) {
      const match = filename.match(/^mcp_output_([a-f0-9]{16,64})\.txt$/);
      if (!match || this.entries.has(match[1])) continue;
      const path = join(directory, filename);
      try {
        const stat = statSync(path);
        this.entries.set(match[1], {
          id: match[1],
          path,
          chars: stat.size,
          createdAt: stat.mtimeMs,
          hash: match[1],
        });
      } catch {
        /* another process removed it */
      }
    }
  }

  private evictOldest(): void {
    this.refreshEntries();
    const oldest = Array.from(this.entries.values())
      .sort((left, right) => left.createdAt - right.createdAt)[0];
    if (!oldest) return;

    this.entries.delete(oldest.id);
    try {
      unlinkSync(oldest.path);
    } catch {
      /* already gone */
    }
  }

  capture(
    output: string,
    threshold = DEFAULT_PAYLOAD_THRESHOLD
  ): CapturedPayload {
    if (output.length <= threshold) {
      return { output };
    }

    const hash = createHash('sha256').update(output).digest('hex');
    const id = hash;
    const existing = this.entries.get(id);
    if (existing && existing.hash === hash && existsSync(existing.path)) {
      return {
        output: this.referenceMessage(existing),
        reference: existing,
      };
    }
    if (existing) {
      this.entries.delete(id);
    }

    this.refreshEntries();
    while (this.entries.size >= this.maxEntries) {
      this.evictOldest();
    }

    const filename = `mcp_output_${id}.txt`;
    const path = join(this.getPayloadDir(), filename);
    try {
      writeFileSync(path, output, {
        encoding: 'utf-8',
        mode: 0o600,
        flag: 'wx',
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw error;
      }
    }

    const entry: PayloadEntry = {
      id,
      path,
      chars: output.length,
      createdAt: Date.now(),
      hash,
    };
    this.entries.set(id, entry);

    return {
      output: this.referenceMessage(entry),
      reference: entry,
    };
  }

  private referenceMessage(reference: PayloadReference): string {
    return (
      `Output saved to ${reference.path} (${reference.chars} chars). ` +
      `Payload ID: ${reference.id}. Use mcp_find_output or mcp_read_output to inspect it.`
    );
  }

  read(
    id: string,
    options: { offset?: number; length?: number; all?: boolean } = {}
  ): PayloadReadResult {
    const entry = this.getEntry(id);
    const content = readFileSync(entry.path, 'utf-8');
    const offset = Math.min(
      Math.max(0, Math.trunc(options.offset ?? 0)),
      content.length
    );
    const requestedLength = options.all
      ? content.length - offset
      : Math.max(1, Math.trunc(options.length ?? DEFAULT_PAYLOAD_READ_LENGTH));
    const nextOffset = Math.min(offset + requestedLength, content.length);

    return {
      id,
      content: content.slice(offset, nextOffset),
      offset,
      nextOffset,
      totalChars: content.length,
      eof: nextOffset >= content.length,
    };
  }

  find(
    id: string,
    query: string,
    options: {
      caseSensitive?: boolean;
      maxMatches?: number;
      contextChars?: number;
    } = {}
  ): PayloadFindResult {
    if (query.length === 0) {
      throw new Error('Payload search query must not be empty');
    }

    const entry = this.getEntry(id);
    const content = readFileSync(entry.path, 'utf-8');
    const caseSensitive = options.caseSensitive ?? false;
    const maxMatches = Math.min(
      100,
      Math.max(1, Math.trunc(options.maxMatches ?? 20))
    );
    const contextChars = Math.min(
      2000,
      Math.max(0, Math.trunc(options.contextChars ?? 200))
    );
    const haystack = caseSensitive ? content : content.toLowerCase();
    const needle = caseSensitive ? query : query.toLowerCase();
    const matches: PayloadFindMatch[] = [];
    let fromIndex = 0;

    while (matches.length < maxMatches) {
      const offset = haystack.indexOf(needle, fromIndex);
      if (offset === -1) break;

      const contextStart = Math.max(0, offset - contextChars);
      const contextEnd = Math.min(
        content.length,
        offset + query.length + contextChars
      );
      matches.push({
        offset,
        line: content.slice(0, offset).split('\n').length,
        match: content.slice(offset, offset + query.length),
        context: content.slice(contextStart, contextEnd),
      });
      fromIndex = offset + Math.max(1, query.length);
    }

    return {
      id,
      query,
      totalChars: content.length,
      matches,
      truncated: haystack.indexOf(needle, fromIndex) !== -1,
    };
  }

  destroy(): void {
    this.entries.clear();
    if (this.payloadDir && this.removeDirectoryOnDestroy) {
      rmSync(this.payloadDir, { recursive: true, force: true });
    }
    this.payloadDir = undefined;
  }
}

const defaultPayloadStore = new PayloadStore();

/**
 * Backward-compatible string-only wrapper used by existing callers.
 */
export function interceptPayload(
  output: string,
  threshold?: number
): string {
  return defaultPayloadStore.capture(output, threshold).output;
}
