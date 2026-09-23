import { Bm25Index } from '../search/bm25.js';
import { centerFor, centeredCosine } from '../models/embedding-index.js';
import type { ModelBackend } from '../models/types.js';

/**
 * Reduce a tool's output to what the caller asked for, before it reaches the
 * agent's context.
 *
 * `want` is a shape, written like the answer you expect:
 *
 *   {"items": [{"number": "integer", "title": "string", "assignee": {"login": "string?"}}]}
 *
 * - an object lists the keys to keep (matched exactly, then ignoring case and
 *   `_`/`-`, then as a dotted path such as "user.login")
 * - a one-element array means "a list of this"
 * - a string leaf is a type: string, number, integer, boolean, object, array
 *   or any; `a|b|c` is one of those values; a trailing `?` makes it optional
 *
 * `where` keeps the items most relevant to a plain-English description.
 *
 * JSON output is projected deterministically - no model, nothing invented.
 * Text output needs the local model, which fills the shape from the text;
 * those values are marked as model-extracted with the model's confidence.
 * Either way the full output is kept by the caller as a payload, so a shaped
 * answer can always be checked against the source.
 */

export interface ShapeSpec {
  want?: unknown;
  where?: string;
  /** Items kept after `where` ranking, and the cap on model-extracted items. */
  limit?: number;
}

export interface ShapeMeta {
  method: 'projection' | 'model-extraction' | 'filter-only' | 'none';
  /** JSON Pointer of the list the shape was applied to, when one was found. */
  arrayPath?: string;
  items?: { total: number; kept: number; sourceIndexes: number[] };
  filter?: { where: string; ranking: 'lexical' | 'lexical+semantic' };
  /** Required fields the source did not have; they are null in `data`. */
  missing: string[];
  /** Values whose type does not match the shape; kept as found. */
  mismatched: string[];
  /** Lowest model confidence among extracted records, when a model was used. */
  confidence?: number | null;
  notes: string[];
}

export interface ShapeResult {
  data: unknown;
  meta: ShapeMeta;
}

export const DEFAULT_WHERE_LIMIT = 20;
/** Characters of text per model extraction; Needle attends over ~1k tokens. */
const EXTRACT_CHUNK_CHARS = 2400;
const EXTRACT_CHUNK_OVERLAP = 200;
/** Item text embedded for `where` ranking. */
const EMBED_ITEM_CHARS = 1000;
const MAX_EMBEDDED_ITEMS = 300;
const LIST_KEYS = ['items', 'results', 'data', 'records', 'entries', 'nodes', 'list', 'values'];
const LEAF_TYPES = new Set(['string', 'number', 'integer', 'boolean', 'object', 'array', 'any']);

interface Leaf {
  optional: boolean;
  type?: string;
  options?: string[];
}

function parseLeaf(spec: string): Leaf {
  let text = spec.trim();
  const optional = text.endsWith('?');
  if (optional) text = text.slice(0, -1).trim();
  if (text.includes('|')) {
    return { optional, options: text.split('|').map((option) => option.trim()).filter(Boolean) };
  }
  const type = text.toLowerCase();
  if (!LEAF_TYPES.has(type)) {
    throw new Error(
      `Unknown type "${spec}" in want; use string, number, integer, boolean, object, array, any, a|b|c, or add ? for optional`
    );
  }
  return { optional, type };
}

function normaliseKey(key: string): string {
  return key.toLowerCase().replace(/[_\-\s]/g, '');
}

function lookup(source: Record<string, unknown>, key: string): { found: boolean; value?: unknown } {
  if (Object.prototype.hasOwnProperty.call(source, key)) {
    return { found: true, value: source[key] };
  }
  const wanted = normaliseKey(key);
  for (const [candidate, value] of Object.entries(source)) {
    if (normaliseKey(candidate) === wanted) return { found: true, value };
  }
  if (key.includes('.')) {
    let current: unknown = source;
    for (const part of key.split('.')) {
      if (!current || typeof current !== 'object' || Array.isArray(current)) {
        return { found: false };
      }
      const next = lookup(current as Record<string, unknown>, part);
      if (!next.found) return { found: false };
      current = next.value;
    }
    return { found: true, value: current };
  }
  return { found: false };
}

function matchesLeaf(value: unknown, leaf: Leaf): boolean {
  if (value === null || value === undefined) return false;
  if (leaf.options) {
    return leaf.options.some((option) => option.toLowerCase() === String(value).toLowerCase());
  }
  switch (leaf.type) {
    case 'string':
      return typeof value === 'string';
    case 'number':
      return typeof value === 'number';
    case 'integer':
      return Number.isInteger(value);
    case 'boolean':
      return typeof value === 'boolean';
    case 'object':
      return typeof value === 'object' && !Array.isArray(value);
    case 'array':
      return Array.isArray(value);
    default:
      return true;
  }
}

interface ProjectionIssues {
  missing: string[];
  mismatched: string[];
}

/** Apply a shape to a JSON value. Never invents a value: absent means null. */
export function project(
  value: unknown,
  shape: unknown,
  path: string,
  issues: ProjectionIssues
): unknown {
  if (typeof shape === 'string') {
    const leaf = parseLeaf(shape);
    if (value === undefined || value === null) {
      if (!leaf.optional) issues.missing.push(path || '/');
      return null;
    }
    if (!matchesLeaf(value, leaf)) issues.mismatched.push(path || '/');
    return value;
  }

  if (Array.isArray(shape)) {
    if (shape.length !== 1) {
      throw new Error('A list in want must hold exactly one element: the shape of each item');
    }
    if (value === undefined || value === null) {
      issues.missing.push(path || '/');
      return null;
    }
    const items = Array.isArray(value) ? value : [value];
    return items.map((item, index) => project(item, shape[0], `${path}/${index}`, issues));
  }

  if (shape && typeof shape === 'object') {
    if (value === undefined || value === null) {
      issues.missing.push(path || '/');
      return null;
    }
    if (Array.isArray(value)) {
      return value.map((item, index) => project(item, shape, `${path}/${index}`, issues));
    }
    if (typeof value !== 'object') {
      issues.mismatched.push(path || '/');
      return null;
    }
    const result: Record<string, unknown> = {};
    for (const [key, subShape] of Object.entries(shape as Record<string, unknown>)) {
      const found = lookup(value as Record<string, unknown>, key);
      result[key] = project(found.found ? found.value : undefined, subShape, `${path}/${key}`, issues);
    }
    return result;
  }

  throw new Error('want must be an object, a one-element list, or a type string');
}

/** The list an item-level shape or filter should apply to, and where it was found. */
export function findList(value: unknown): { items: unknown[]; path: string } | undefined {
  if (Array.isArray(value)) return { items: value, path: '' };
  if (!value || typeof value !== 'object') return undefined;
  const record = value as Record<string, unknown>;
  for (const key of LIST_KEYS) {
    const found = lookup(record, key);
    if (found.found && Array.isArray(found.value)) {
      return { items: found.value, path: `/${key}` };
    }
  }
  const arrays = Object.entries(record)
    .filter(([, candidate]) => Array.isArray(candidate))
    .sort((a, b) => (b[1] as unknown[]).length - (a[1] as unknown[]).length);
  if (arrays.length > 0) {
    return { items: arrays[0][1] as unknown[], path: `/${arrays[0][0]}` };
  }
  return undefined;
}

function itemText(item: unknown): string {
  return typeof item === 'string' ? item : JSON.stringify(item) ?? '';
}

/**
 * Rank items by relevance to `where` and keep the best `limit`.
 * Lexical ranking drops items sharing no word with `where`; with a model,
 * embedding similarity is fused in and can keep paraphrased matches.
 */
export async function rankItems(
  items: unknown[],
  where: string,
  limit: number,
  model?: Pick<ModelBackend, 'embed'>
): Promise<{ indexes: number[]; ranking: 'lexical' | 'lexical+semantic'; notes: string[] }> {
  const notes: string[] = [];
  const fused = new Map<number, number>();
  const add = (index: number, weight: number, rank: number) =>
    fused.set(index, (fused.get(index) ?? 0) + weight / (10 + rank));

  const index = new Bm25Index(
    items.map((item, position) => ({ id: String(position), name: '', text: itemText(item) }))
  );
  index.search(where).forEach((hit, rank) => add(Number(hit.id), 1, rank + 1));

  let ranking: 'lexical' | 'lexical+semantic' = 'lexical';
  if (model && items.length > 0) {
    try {
      const considered = items.slice(0, MAX_EMBEDDED_ITEMS);
      const vectors = await model.embed(
        considered.map((item) => itemText(item).slice(0, EMBED_ITEM_CHARS))
      );
      const [query] = await model.embed([where]);
      if (query && vectors.length === considered.length) {
        const center = centerFor(vectors);
        const scores = vectors.map((vector) => centeredCosine(query, vector, center));
        // A filter must be able to say "none of these", and raw model
        // similarities sit close together, so only items scoring clearly
        // above this list's average count as relevant by meaning.
        const average = scores.reduce((sum, score) => sum + score, 0) / scores.length;
        const spread = Math.sqrt(
          scores.reduce((sum, score) => sum + (score - average) ** 2, 0) / scores.length
        );
        if (spread > 0) {
          scores
            .map((score, position) => ({ position, z: (score - average) / spread }))
            .filter(({ z }) => z > 0.5)
            .sort((a, b) => b.z - a.z)
            .slice(0, limit)
            .forEach(({ position }, rank) => add(position, 0.5, rank + 1));
        }
        ranking = 'lexical+semantic';
        if (items.length > MAX_EMBEDDED_ITEMS) {
          notes.push(`Only the first ${MAX_EMBEDDED_ITEMS} items were compared by meaning.`);
        }
      }
    } catch (error) {
      notes.push(`Model ranking unavailable (${error instanceof Error ? error.message : error}); ranked by shared words only.`);
    }
  }

  const indexes = [...fused]
    .sort((a, b) => b[1] - a[1] || a[0] - b[0])
    .slice(0, limit)
    .map(([position]) => position);
  return { indexes, ranking, notes };
}

/** JSON Schema parameters for a Needle extraction of this shape. */
export function shapeToSchema(shape: unknown): Record<string, unknown> {
  if (typeof shape === 'string') {
    const leaf = parseLeaf(shape);
    if (leaf.options) return { type: 'string', enum: leaf.options };
    if (leaf.type === 'any' || leaf.type === undefined) return { type: 'string' };
    if (leaf.type === 'array') return { type: 'array', items: { type: 'string' } };
    return { type: leaf.type };
  }
  if (Array.isArray(shape)) {
    return { type: 'array', items: shapeToSchema(shape[0]) };
  }
  if (shape && typeof shape === 'object') {
    const properties: Record<string, unknown> = {};
    const required: string[] = [];
    for (const [key, subShape] of Object.entries(shape as Record<string, unknown>)) {
      properties[key] = shapeToSchema(subShape);
      const optional = typeof subShape === 'string' && subShape.trim().endsWith('?');
      if (!optional) required.push(key);
    }
    return { type: 'object', properties, required };
  }
  throw new Error('want must be an object, a one-element list, or a type string');
}

/** Split text into overlapping chunks at line boundaries where possible. */
export function chunkText(text: string, size = EXTRACT_CHUNK_CHARS, overlap = EXTRACT_CHUNK_OVERLAP): string[] {
  if (text.length <= size) return [text];
  const chunks: string[] = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(text.length, start + size);
    if (end < text.length) {
      const newline = text.lastIndexOf('\n', end);
      if (newline > start + size / 2) end = newline;
    }
    chunks.push(text.slice(start, end));
    if (end >= text.length) break;
    start = Math.max(end - overlap, start + 1);
  }
  return chunks;
}

/** Blocks of text that are plausibly one item each: paragraphs, else lines. */
export function splitBlocks(text: string): string[] {
  const paragraphs = text.split(/\n\s*\n/).map((block) => block.trim()).filter(Boolean);
  if (paragraphs.length > 1) return paragraphs;
  return text.split('\n').map((line) => line.trim()).filter(Boolean);
}

async function extractRecord(
  text: string,
  objectShape: unknown,
  model: Pick<ModelBackend, 'extract'>
): Promise<{ value: Record<string, unknown> | null; confidence: number | null; withheld: boolean }> {
  const parameters = shapeToSchema(objectShape);
  let merged: Record<string, unknown> | null = null;
  let confidence: number | null = null;
  let withheld = false;

  for (const chunk of chunkText(text)) {
    const extraction = await model.extract(chunk, {
      name: 'record',
      description: 'The requested fields, taken only from the text.',
      parameters,
    });
    if (!extraction.value) continue;
    merged ??= {};
    for (const [key, value] of Object.entries(extraction.value)) {
      if (merged[key] === undefined && value !== null && value !== '') merged[key] = value;
    }
    withheld ||= extraction.withheld;
    if (extraction.confidence !== null) {
      confidence = confidence === null ? extraction.confidence : Math.min(confidence, extraction.confidence);
    }
  }
  return { value: merged, confidence, withheld };
}

function parseJson(output: string): { ok: true; value: unknown } | { ok: false } {
  const trimmed = output.trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return { ok: false };
  try {
    return { ok: true, value: JSON.parse(trimmed) };
  } catch {
    return { ok: false };
  }
}

/** Shape a tool's text output according to `spec`. */
export async function shapeOutput(
  output: string,
  spec: ShapeSpec,
  model?: Pick<ModelBackend, 'embed' | 'extract'>
): Promise<ShapeResult> {
  const want = typeof spec.want === 'string' && /^[[{]/.test(spec.want.trim())
    ? JSON.parse(spec.want)
    : spec.want;
  const where = spec.where?.trim() || undefined;
  const limit = Math.max(1, Math.trunc(spec.limit ?? DEFAULT_WHERE_LIMIT));
  const meta: ShapeMeta = { method: 'none', missing: [], mismatched: [], notes: [] };

  if (want === undefined && !where) {
    return { data: output, meta: { ...meta, notes: ['Nothing to shape: pass want and/or where.'] } };
  }

  const parsed = parseJson(output);
  if (parsed.ok) {
    return shapeJson(parsed.value, want, where, limit, meta, model);
  }
  return shapeText(output, want, where, limit, meta, model);
}

/**
 * The shape of one list item, when `want` describes a list: either `[item]`
 * itself, or an object whose key naming the output's list holds `[item]`
 * ({"items": [{...}]} for {"items": [...]}).
 */
function itemShapeFor(
  want: unknown,
  listPath: string | undefined
): { shape: unknown; wrapKey?: string } | undefined {
  if (Array.isArray(want)) return { shape: want[0] };
  if (!want || typeof want !== 'object' || !listPath || listPath === '/') return undefined;
  const listKey = normaliseKey(listPath.slice(1));
  for (const [key, subShape] of Object.entries(want as Record<string, unknown>)) {
    if (normaliseKey(key) === listKey && Array.isArray(subShape) && subShape.length === 1) {
      return { shape: subShape[0], wrapKey: key };
    }
  }
  return undefined;
}

async function shapeJson(
  value: unknown,
  want: unknown,
  where: string | undefined,
  limit: number,
  meta: ShapeMeta,
  model?: Pick<ModelBackend, 'embed'>
): Promise<ShapeResult> {
  const list = findList(value);
  const item = itemShapeFor(want, list?.path || (list ? '/' : undefined));

  // Without a filter or a list-shaped want, this is a plain projection.
  if (!where && !item) {
    if (want !== undefined) {
      meta.method = 'projection';
      return { data: project(value, want, '', meta), meta };
    }
  }

  if (!list) {
    if (where) meta.notes.push('No list found in the output, so where was not applied.');
    if (want === undefined) {
      meta.method = 'filter-only';
      return { data: value, meta };
    }
    meta.method = 'projection';
    return { data: project(value, want, '', meta), meta };
  }

  meta.arrayPath = list.path || '/';
  let items = list.items;
  let sourceIndexes = items.map((_item, index) => index);
  if (where) {
    const ranked = await rankItems(items, where, limit, model);
    sourceIndexes = ranked.indexes;
    items = ranked.indexes.map((index) => list.items[index]);
    meta.filter = { where, ranking: ranked.ranking };
    meta.notes.push(...ranked.notes);
  }
  meta.items = { total: list.items.length, kept: items.length, sourceIndexes };

  if (want === undefined) {
    meta.method = 'filter-only';
    return { data: items, meta };
  }

  meta.method = 'projection';
  const base = list.path === '' ? '' : list.path;
  const itemShape = item?.shape ?? want;
  const projected = items.map((entry, index) =>
    project(entry, itemShape, `${base}/${sourceIndexes[index]}`, meta)
  );

  if (item?.wrapKey) {
    // Keep the other requested top-level fields around the filtered list.
    const rest = Object.fromEntries(
      Object.entries(want as Record<string, unknown>).filter(([key]) => key !== item.wrapKey)
    );
    const outer = Object.keys(rest).length > 0
      ? (project(value, rest, '', meta) as Record<string, unknown>)
      : {};
    return { data: { ...outer, [item.wrapKey]: projected }, meta };
  }
  return { data: projected, meta };
}

async function shapeText(
  output: string,
  want: unknown,
  where: string | undefined,
  limit: number,
  meta: ShapeMeta,
  model?: Pick<ModelBackend, 'embed' | 'extract'>
): Promise<ShapeResult> {
  if (want === undefined) {
    // Plain text with only a filter: rank its blocks.
    const blocks = splitBlocks(output);
    const ranked = await rankItems(blocks, where as string, limit, model);
    meta.method = 'filter-only';
    meta.filter = { where: where as string, ranking: ranked.ranking };
    meta.items = { total: blocks.length, kept: ranked.indexes.length, sourceIndexes: ranked.indexes };
    meta.notes.push('The output is text; it was split into paragraphs (or lines) to filter.', ...ranked.notes);
    return { data: ranked.indexes.map((index) => blocks[index]), meta };
  }

  if (!model) {
    meta.notes.push(
      'The output is not JSON. Extracting fields from text needs the local model ("model" in servers.json); use the payload with output find/read instead.'
    );
    return { data: null, meta };
  }

  meta.method = 'model-extraction';
  meta.notes.push('Values were extracted by the local model from text; check them against the payload before relying on them.');

  if (Array.isArray(want)) {
    let blocks = splitBlocks(output);
    let indexes = blocks.map((_block, index) => index);
    if (where) {
      const ranked = await rankItems(blocks, where, limit, model);
      indexes = ranked.indexes;
      meta.filter = { where, ranking: ranked.ranking };
      meta.notes.push(...ranked.notes);
    }
    if (indexes.length > limit) {
      meta.notes.push(`Only the first ${limit} of ${indexes.length} blocks were extracted; pass limit for more.`);
      indexes = indexes.slice(0, limit);
    }
    blocks = indexes.map((index) => blocks[index]);

    const records: unknown[] = [];
    const kept: number[] = [];
    let confidence: number | null = null;
    for (let position = 0; position < blocks.length; position++) {
      const extracted = await extractRecord(blocks[position], want[0], model);
      if (!extracted.value) continue;
      records.push(project(extracted.value, want[0], `/${indexes[position]}`, meta));
      kept.push(indexes[position]);
      if (extracted.confidence !== null) {
        confidence = confidence === null ? extracted.confidence : Math.min(confidence, extracted.confidence);
      }
      if (extracted.withheld) meta.notes.push(`Block ${indexes[position]} came from a low-confidence (withheld) extraction.`);
    }
    meta.confidence = confidence;
    meta.items = { total: splitBlocks(output).length, kept: records.length, sourceIndexes: kept };
    return { data: records, meta };
  }

  const extracted = await extractRecord(output, want, model);
  meta.confidence = extracted.confidence;
  if (extracted.withheld) meta.notes.push('The model withheld this extraction as low-confidence.');
  if (!extracted.value) {
    meta.notes.push('The model found none of the requested fields in the text.');
    return { data: null, meta };
  }
  return { data: project(extracted.value, want, '', meta), meta };
}
