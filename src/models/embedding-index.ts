import { createHash } from 'crypto';
import { readFileSync, renameSync, writeFileSync } from 'fs';
import type { Logger } from 'pino';
import type { CatalogTool } from '../mcp/tool-catalog.js';
import type { SemanticScorer } from '../search/tool-search.js';
import { toolKey } from '../search/usage-log.js';
import type { ModelBackend } from './types.js';

/** Missing vectors embedded inline before answering; more than this indexes in the background. */
const INLINE_EMBED_LIMIT = 48;
const EMBED_BATCH = 32;
/** Cached vectors kept on disk; enough for several large catalogs. */
const MAX_CACHED_VECTORS = 20_000;

/** The text embedded for a tool. Descriptions ranked better than name+description in testing. */
export function embeddingText(tool: Pick<CatalogTool, 'toolName' | 'description'>): string {
  return tool.description?.trim() || tool.toolName.replace(/[_-]+/g, ' ');
}

function hashText(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 32);
}

function encode(vector: Float32Array): string {
  return Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength).toString('base64');
}

function decode(encoded: string): Float32Array {
  const bytes = Buffer.from(encoded, 'base64');
  const aligned = new ArrayBuffer(bytes.length);
  new Uint8Array(aligned).set(bytes);
  return new Float32Array(aligned);
}

/** Cosine similarity of two vectors after subtracting a shared mean. */
export function centeredCosine(a: Float32Array, b: Float32Array, mean: Float32Array): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i] - mean[i];
    const y = b[i] - mean[i];
    dot += x * y;
    normA += x * x;
    normB += y * y;
  }
  return normA === 0 || normB === 0 ? 0 : dot / Math.sqrt(normA * normB);
}

export function meanVector(vectors: Float32Array[]): Float32Array {
  const mean = new Float32Array(vectors[0]?.length ?? 0);
  for (const vector of vectors) {
    for (let i = 0; i < mean.length; i++) mean[i] += vector[i];
  }
  for (let i = 0; i < mean.length; i++) mean[i] /= vectors.length || 1;
  return mean;
}

/**
 * Tool embeddings for semantic search, cached by the text they embed.
 *
 * Needle's raw vectors all point roughly the same way (every tool scored
 * 0.89-0.94 against every query in testing), so similarity is measured after
 * subtracting the catalog's mean vector, which moved the right tool to first
 * place for more queries. A catalog with many unseen tools is indexed in the
 * background; until then search answers lexically instead of waiting.
 */
export class EmbeddingIndex implements SemanticScorer {
  private readonly vectors = new Map<string, Float32Array>();
  private indexing: Promise<void> | undefined;
  private loaded = false;
  private dirty = false;

  constructor(
    private readonly model: Pick<ModelBackend, 'embed'>,
    private readonly logger: Logger,
    private readonly cacheFile?: string
  ) {}

  private load(): void {
    if (this.loaded || !this.cacheFile) {
      this.loaded = true;
      return;
    }
    this.loaded = true;
    try {
      const parsed = JSON.parse(readFileSync(this.cacheFile, 'utf-8')) as {
        version?: number;
        vectors?: Record<string, string>;
      };
      if (parsed.version === 1 && parsed.vectors) {
        for (const [hash, encoded] of Object.entries(parsed.vectors)) {
          this.vectors.set(hash, decode(encoded));
        }
      }
    } catch {
      // No cache yet, or an unreadable one: rebuild as tools are embedded.
    }
  }

  private persist(): void {
    if (!this.cacheFile || !this.dirty) return;
    this.dirty = false;
    const entries = [...this.vectors].slice(-MAX_CACHED_VECTORS);
    const temp = `${this.cacheFile}.${process.pid}.tmp`;
    try {
      writeFileSync(
        temp,
        JSON.stringify({
          version: 1,
          vectors: Object.fromEntries(entries.map(([hash, vector]) => [hash, encode(vector)])),
        }),
        { mode: 0o600 }
      );
      renameSync(temp, this.cacheFile);
    } catch (error) {
      this.logger.debug({ error }, 'Could not persist embedding cache');
    }
  }

  private async embedMissing(texts: string[]): Promise<void> {
    for (let start = 0; start < texts.length; start += EMBED_BATCH) {
      const batch = texts.slice(start, start + EMBED_BATCH);
      const vectors = await this.model.embed(batch);
      batch.forEach((text, index) => {
        if (vectors[index]) this.vectors.set(hashText(text), vectors[index]);
      });
      this.dirty = true;
    }
    this.persist();
  }

  private missingTexts(tools: CatalogTool[]): string[] {
    this.load();
    const missing = new Set<string>();
    for (const tool of tools) {
      const text = embeddingText(tool);
      if (!this.vectors.has(hashText(text))) missing.add(text);
    }
    return [...missing];
  }

  /** Embed every tool not yet indexed, in the background. Safe to call repeatedly. */
  warm(tools: CatalogTool[]): Promise<void> {
    if (this.indexing) return this.indexing;
    const missing = this.missingTexts(tools);
    if (missing.length === 0) return Promise.resolve();

    this.logger.info({ tools: missing.length }, 'Indexing tool embeddings');
    this.indexing = this.embedMissing(missing)
      .catch((error) => {
        this.logger.warn({ error: String(error) }, 'Tool embedding failed; search stays lexical');
      })
      .finally(() => {
        this.indexing = undefined;
      });
    return this.indexing;
  }

  /** Vectors for these tools, keyed `server/tool`; undefined while any are missing. */
  async vectorsFor(tools: CatalogTool[]): Promise<Map<string, Float32Array> | undefined> {
    const missing = this.missingTexts(tools);
    if (missing.length > INLINE_EMBED_LIMIT) {
      void this.warm(tools);
      return undefined;
    }
    if (missing.length > 0) {
      await this.embedMissing(missing);
    }
    const result = new Map<string, Float32Array>();
    for (const tool of tools) {
      const vector = this.vectors.get(hashText(embeddingText(tool)));
      if (!vector) return undefined;
      result.set(toolKey(tool.serverName, tool.toolName), vector);
    }
    return result;
  }

  async score(query: string, tools: CatalogTool[]): Promise<Map<string, number> | undefined> {
    if (tools.length === 0 || !query.trim()) return undefined;
    const vectors = await this.vectorsFor(tools);
    if (!vectors) return undefined;

    const [queryVector] = await this.model.embed([query]);
    if (!queryVector) return undefined;

    const mean = meanVector([...vectors.values()]);
    const scores = new Map<string, number>();
    for (const [key, vector] of vectors) {
      scores.set(key, centeredCosine(queryVector, vector, mean));
    }
    return scores;
  }
}
