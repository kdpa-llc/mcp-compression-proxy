import type { CatalogTool } from '../mcp/tool-catalog.js';
import type { ModelBackend } from '../models/types.js';
import { centerFor, centeredCosine } from '../models/embedding-index.js';
import { splitWords, tokenize } from '../search/text.js';
import { toolKey } from '../search/usage-log.js';

/**
 * A shortened description that now reads more like another tool than its own.
 * An agent choosing by the short text would plausibly pick the wrong tool.
 */
export interface ConfusableCompression {
  tool: string;
  compressed: string;
  closestTo: string;
  ownSimilarity: number;
  otherSimilarity: number;
}

/** Two tools on different servers that look like the same capability. */
export interface PossibleDuplicate {
  tools: [string, string];
  similarity: number;
}

export interface CompressionAudit {
  method: 'lexical' | 'semantic';
  checked: number;
  confusable: ConfusableCompression[];
  duplicates: PossibleDuplicate[];
  notes: string[];
}

/** Similarity above which tools on different servers are reported as possible duplicates. */
const DUPLICATE_THRESHOLD = { lexical: 0.75, semantic: 0.8 };

type Vector = Map<string, number> | Float32Array;

/** TF-IDF vectors, the model-free way to compare descriptions. */
function tfidfVectors(texts: string[]): { vectors: Map<string, number>[]; similarity: (a: Vector, b: Vector) => number } {
  const tokenized = texts.map((text) => tokenize(text));
  const documentFrequency = new Map<string, number>();
  for (const tokens of tokenized) {
    for (const token of new Set(tokens)) {
      documentFrequency.set(token, (documentFrequency.get(token) ?? 0) + 1);
    }
  }
  const idf = (token: string) =>
    Math.log(1 + texts.length / (documentFrequency.get(token) ?? 1));

  const vectors = tokenized.map((tokens) => {
    const vector = new Map<string, number>();
    for (const token of tokens) vector.set(token, (vector.get(token) ?? 0) + 1);
    for (const [token, count] of vector) vector.set(token, count * idf(token));
    return vector;
  });

  const similarity = (a: Vector, b: Vector) => {
    const left = a as Map<string, number>;
    const right = b as Map<string, number>;
    let dot = 0;
    for (const [token, weight] of left) dot += weight * (right.get(token) ?? 0);
    const norm = (vector: Map<string, number>) =>
      Math.sqrt([...vector.values()].reduce((sum, weight) => sum + weight * weight, 0));
    const denominator = norm(left) * norm(right);
    return denominator === 0 ? 0 : dot / denominator;
  };
  return { vectors, similarity };
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

/**
 * Check compressed descriptions against the originals they replace.
 *
 * A compression is flagged when it is at least as close to another tool's
 * original description as to its own - the case where shortening removed the
 * detail that told two tools apart (read_file vs read_multiple_files).
 * Separately, tools on different servers with near-identical descriptions are
 * listed as possible duplicates: excluding one saves its whole definition.
 *
 * Uses the local model's embeddings when given, TF-IDF otherwise.
 */
export async function auditCompression(
  tools: CatalogTool[],
  compression: {
    getCompressedDescription(serverName: string, toolName: string): string | undefined;
  },
  model?: Pick<ModelBackend, 'embed'>
): Promise<CompressionAudit> {
  const notes: string[] = [];
  const originals = tools.map(
    (tool) => `${splitWords(tool.toolName).join(' ')}. ${tool.description ?? ''}`
  );
  const compressedIndexes = tools
    .map((tool, index) => ({
      index,
      text: compression.getCompressedDescription(tool.serverName, tool.toolName),
    }))
    .filter((entry): entry is { index: number; text: string } => !!entry.text);
  const compressedTexts = compressedIndexes.map(
    ({ index, text }) => `${splitWords(tools[index].toolName).join(' ')}. ${text}`
  );

  const lexical = () => {
    const { vectors, similarity } = tfidfVectors([...originals, ...compressedTexts]);
    return {
      method: 'lexical' as const,
      originalVectors: vectors.slice(0, originals.length) as Vector[],
      compressedVectors: vectors.slice(originals.length) as Vector[],
      similarity,
    };
  };

  const semantic = async (embed: Pick<ModelBackend, 'embed'>) => {
    const embedded = await embed.embed([...originals, ...compressedTexts]);
    const originalEmbeddings = embedded.slice(0, originals.length);
    const mean = centerFor(originalEmbeddings);
    return {
      method: 'semantic' as const,
      originalVectors: originalEmbeddings as Vector[],
      compressedVectors: embedded.slice(originals.length) as Vector[],
      similarity: (a: Vector, b: Vector) =>
        centeredCosine(a as Float32Array, b as Float32Array, mean),
    };
  };

  let space: ReturnType<typeof lexical> | Awaited<ReturnType<typeof semantic>> = lexical();
  if (model && tools.length > 1) {
    try {
      space = await semantic(model);
    } catch (error) {
      notes.push(
        `Local model unavailable (${error instanceof Error ? error.message : error}); compared by shared words instead.`
      );
    }
  }
  const { method, originalVectors, compressedVectors, similarity } = space;

  const key = (index: number) => toolKey(tools[index].serverName, tools[index].toolName);
  const confusable: ConfusableCompression[] = [];

  compressedIndexes.forEach(({ index, text }, position) => {
    const vector = compressedVectors[position];
    const own = similarity(vector, originalVectors[index]);
    let best = { index: -1, score: -Infinity };
    originalVectors.forEach((other, otherIndex) => {
      if (otherIndex === index) return;
      const score = similarity(vector, other);
      if (score > best.score) best = { index: otherIndex, score };
    });
    if (best.index !== -1 && best.score >= own) {
      confusable.push({
        tool: key(index),
        compressed: text,
        closestTo: key(best.index),
        ownSimilarity: round(own),
        otherSimilarity: round(best.score),
      });
    }
  });

  const duplicates: PossibleDuplicate[] = [];
  const threshold = DUPLICATE_THRESHOLD[method];
  for (let i = 0; i < tools.length; i++) {
    for (let j = i + 1; j < tools.length; j++) {
      if (tools[i].serverName === tools[j].serverName) continue;
      const score = similarity(originalVectors[i], originalVectors[j]);
      if (score >= threshold) {
        duplicates.push({ tools: [key(i), key(j)], similarity: round(score) });
      }
    }
  }
  duplicates.sort((a, b) => b.similarity - a.similarity);

  if (compressedIndexes.length === 0) {
    notes.push('No tool has a compressed description yet; only duplicates were checked.');
  }

  return {
    method,
    checked: compressedIndexes.length,
    confusable,
    duplicates,
    notes,
  };
}
