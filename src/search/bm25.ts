import { tokenize } from './text.js';

export interface Bm25Document {
  id: string;
  /** Identifier-like text, weighted above the description. */
  name: string;
  text: string;
}

export interface Bm25Hit {
  id: string;
  score: number;
}

const K1 = 1.2;
const B = 0.75;
/** A name token counts this many times: a tool called list_directory is about listing directories more surely than one that mentions them. */
const NAME_WEIGHT = 3;

/**
 * Okapi BM25 over tool names and descriptions.
 *
 * Built per snapshot; tool catalogs are hundreds to low thousands of entries,
 * so an inverted index is cheap to rebuild and scoring is a single pass.
 */
export class Bm25Index {
  private readonly termFrequencies: Array<Map<string, number>> = [];
  private readonly lengths: number[] = [];
  private readonly documentFrequency = new Map<string, number>();
  private readonly ids: string[] = [];
  private readonly averageLength: number;

  constructor(documents: Bm25Document[]) {
    for (const document of documents) {
      const frequencies = new Map<string, number>();
      let length = 0;
      const add = (token: string, weight: number) => {
        frequencies.set(token, (frequencies.get(token) ?? 0) + weight);
        length += weight;
      };
      for (const token of tokenize(document.name)) add(token, NAME_WEIGHT);
      for (const token of tokenize(document.text)) add(token, 1);

      for (const token of frequencies.keys()) {
        this.documentFrequency.set(token, (this.documentFrequency.get(token) ?? 0) + 1);
      }
      this.termFrequencies.push(frequencies);
      this.lengths.push(length);
      this.ids.push(document.id);
    }

    const total = this.lengths.reduce((sum, length) => sum + length, 0);
    this.averageLength = documents.length > 0 ? total / documents.length : 0;
  }

  get size(): number {
    return this.ids.length;
  }

  /** Only called for tokens some document contains, so the count exists. */
  private idf(token: string): number {
    const df = this.documentFrequency.get(token) as number;
    return Math.log(1 + (this.ids.length - df + 0.5) / (df + 0.5));
  }

  /** Documents with a positive score, best first. */
  search(query: string): Bm25Hit[] {
    const queryTokens = [...new Set(tokenize(query))];
    if (queryTokens.length === 0 || this.ids.length === 0) {
      return [];
    }

    const hits: Bm25Hit[] = [];
    for (let index = 0; index < this.ids.length; index++) {
      const frequencies = this.termFrequencies[index];
      const lengthNorm = 1 - B + (B * this.lengths[index]) / (this.averageLength || 1);
      let score = 0;
      for (const token of queryTokens) {
        const tf = frequencies.get(token);
        if (!tf) continue;
        score += this.idf(token) * ((tf * (K1 + 1)) / (tf + K1 * lengthNorm));
      }
      if (score > 0) {
        hits.push({ id: this.ids[index], score });
      }
    }

    return hits.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
  }
}
