import type { CatalogTool } from '../mcp/tool-catalog.js';
import type { ModelBackend } from '../models/types.js';
import { Bm25Index } from '../search/bm25.js';
import { toolKey } from '../search/usage-log.js';
import type { CachedDescription } from '../types/compression.js';
import { auditCompression } from './compression-audit.js';

/**
 * Compressing and rewriting tool descriptions with the agent's own model.
 *
 * No API key and no model in the proxy: `next` hands the agent a batch of
 * tools with everything needed to describe them well, the agent writes the
 * new text, `review` shows the user what would change and what fails the
 * checks, and `apply` saves only what passed. The original is always kept and
 * any tool can be reverted.
 *
 * - compress: shorter, same meaning; replaces the description only
 * - rewrite: clearer, may be longer; may also rewrite parameter descriptions
 */

export type DescribeMode = 'compress' | 'rewrite';

export const MAX_DESCRIPTION_CHARS = 1024;
export const MAX_PARAMETER_CHARS = 400;
const SHORT_DESCRIPTION_CHARS = 40;
const SIMILAR_TOOLS = 3;
/**
 * A rewrite is meant to move away from a weak original, so it is rejected
 * only when another tool's original is clearly closer, not merely tied.
 */
export const DISTINCTNESS_MARGIN = 0.05;

export const GUIDELINES: Record<DescribeMode, string[]> = {
  compress: [
    'Write a much shorter description that still says what the tool does and when to use it.',
    'Keep any detail that tells it apart from the similar tools listed.',
    'Drop examples, parameter lists and restatements of the schema.',
    'Never add a capability, limit or behaviour the original does not state.',
  ],
  rewrite: [
    'Say what the tool does, when to use it, and when to use one of the similar tools instead.',
    'State input formats, units and important limits the original or the schema imply; do not invent any.',
    'Keep it compact: one to three sentences. Longer than the original is fine only when the original was unclear.',
    'Parameters: describe only listed parameters, in a phrase each. Names, types and required fields cannot change.',
    'Never add a capability, limit or behaviour the original does not state. If the original is too vague to know, keep the claim vague.',
  ],
};

export interface ParameterInfo {
  type?: string;
  required: boolean;
  description?: string;
  current?: string;
}

export interface DescribeItem {
  server: string;
  tool: string;
  original: string;
  current?: string;
  currentKind?: CachedDescription['kind'];
  parameters: Record<string, ParameterInfo>;
  /** Why the original description is weak; drives the order of `next`. */
  issues: string[];
  /** Tools a reader could confuse with this one; the text must tell them apart. */
  similar: Array<{ tool: string; description: string }>;
}

export interface DescribeBatch {
  mode: DescribeMode;
  items: DescribeItem[];
  remaining: number;
  guidelines: string[];
  /** The shape of the file `review` and `apply` read. */
  answerFormat: string;
}

export interface CacheView {
  getEntry(serverName: string, toolName: string): CachedDescription | undefined;
  isStale(serverName: string, toolName: string, liveOriginal?: string): boolean;
}

function properties(tool: CatalogTool): Record<string, { type?: unknown; description?: unknown }> {
  const schema = tool.inputSchema as { properties?: Record<string, { type?: unknown; description?: unknown }> };
  return schema?.properties && typeof schema.properties === 'object' ? schema.properties : {};
}

function requiredNames(tool: CatalogTool): Set<string> {
  const required = (tool.inputSchema as { required?: unknown })?.required;
  return new Set(Array.isArray(required) ? required.filter((name): name is string => typeof name === 'string') : []);
}

/** What makes a description weak, worst first. */
export function descriptionIssues(tool: CatalogTool): string[] {
  const issues: string[] = [];
  const description = tool.description?.trim() ?? '';
  if (!description) issues.push('no description');
  else if (description.length < SHORT_DESCRIPTION_CHARS) issues.push('description is very short');
  else if (description.length > MAX_DESCRIPTION_CHARS) issues.push('description is very long');

  const params = Object.entries(properties(tool));
  const undocumented = params.filter(([, spec]) => typeof spec?.description !== 'string' || !spec.description.trim());
  if (undocumented.length > 0) {
    issues.push(`${undocumented.length} of ${params.length} parameter(s) undocumented`);
  }
  return issues;
}

function needsWork(tool: CatalogTool, cache: CacheView, mode: DescribeMode, all: boolean): boolean {
  const entry = cache.getEntry(tool.serverName, tool.toolName);
  if (!entry?.compressed) return true;
  if (cache.isStale(tool.serverName, tool.toolName, tool.description)) return true;
  if (all) return true;
  return mode === 'rewrite' && entry.kind !== 'rewritten' && descriptionIssues(tool).length > 0;
}

/** The next tools to describe, weakest descriptions first. */
export function nextBatch(
  tools: CatalogTool[],
  cache: CacheView,
  options: { mode?: DescribeMode; limit?: number; server?: string; tool?: string; all?: boolean } = {}
): DescribeBatch {
  const mode = options.mode ?? 'rewrite';
  const limit = Math.max(1, Math.min(options.limit ?? 10, 50));

  const candidates = tools
    .filter((tool) => !options.server || tool.serverName === options.server)
    .filter((tool) => !options.tool || toolKey(tool.serverName, tool.toolName) === options.tool)
    .filter((tool) => options.tool !== undefined || needsWork(tool, cache, mode, options.all === true))
    .map((tool) => ({ tool, issues: descriptionIssues(tool) }))
    .sort(
      (a, b) =>
        b.issues.length - a.issues.length ||
        toolKey(a.tool.serverName, a.tool.toolName).localeCompare(toolKey(b.tool.serverName, b.tool.toolName))
    );

  const index = new Bm25Index(
    tools.map((tool) => ({
      id: toolKey(tool.serverName, tool.toolName),
      name: `${tool.serverName} ${tool.toolName}`,
      text: tool.description ?? '',
    }))
  );
  const byKey = new Map(tools.map((tool) => [toolKey(tool.serverName, tool.toolName), tool]));

  const items = candidates.slice(0, limit).map(({ tool, issues }): DescribeItem => {
    const key = toolKey(tool.serverName, tool.toolName);
    const entry = cache.getEntry(tool.serverName, tool.toolName);
    const required = requiredNames(tool);
    const parameters: Record<string, ParameterInfo> = {};
    for (const [name, spec] of Object.entries(properties(tool))) {
      parameters[name] = {
        ...(typeof spec?.type === 'string' ? { type: spec.type } : {}),
        required: required.has(name),
        ...(typeof spec?.description === 'string' ? { description: spec.description } : {}),
        ...(entry?.parameters?.[name] ? { current: entry.parameters[name] } : {}),
      };
    }
    const similar = index
      .search(`${tool.toolName} ${tool.description ?? ''}`)
      .filter((hit) => hit.id !== key)
      .slice(0, SIMILAR_TOOLS)
      .map((hit) => ({ tool: hit.id, description: byKey.get(hit.id)?.description ?? '' }));

    return {
      server: tool.serverName,
      tool: tool.toolName,
      original: tool.description ?? '',
      ...(entry?.compressed ? { current: entry.compressed } : {}),
      ...(entry?.kind ? { currentKind: entry.kind } : {}),
      parameters,
      issues,
      similar,
    };
  });

  return {
    mode,
    items,
    remaining: Math.max(0, candidates.length - items.length),
    guidelines: GUIDELINES[mode],
    answerFormat:
      mode === 'rewrite'
        ? '[{"server":"...","tool":"...","description":"...","parameters":{"<name>":"..."}}]  (parameters optional)'
        : '[{"server":"...","tool":"...","description":"..."}]',
  };
}

export interface Proposal {
  server: string;
  tool: string;
  description: string;
  parameters?: Record<string, string>;
}

export interface ReviewedProposal {
  server: string;
  tool: string;
  accepted: boolean;
  /** Reasons it will not be applied. */
  problems: string[];
  /** Worth a look, but not blocking. */
  warnings: string[];
  before: { description: string; parameters: Record<string, string> };
  after: { description: string; parameters: Record<string, string> };
  chars: { before: number; after: number };
  proposal?: Proposal;
}

export interface Review {
  mode: DescribeMode;
  method: 'lexical' | 'semantic';
  reviewed: ReviewedProposal[];
  accepted: number;
  rejected: number;
}

/** Accept an array, or {"tools": [...]}, of proposals; `tool` may be "server/tool". */
export function parseProposals(input: unknown): Array<Partial<Proposal> & { raw: unknown }> {
  const list = Array.isArray(input)
    ? input
    : input && typeof input === 'object' && Array.isArray((input as { tools?: unknown }).tools)
      ? (input as { tools: unknown[] }).tools
      : undefined;
  if (!list) {
    throw new Error('Expected a JSON array of {"server","tool","description"} entries');
  }
  return list.map((raw) => {
    const entry = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
    let server = typeof entry.server === 'string' ? entry.server : undefined;
    let tool = typeof entry.tool === 'string' ? entry.tool : undefined;
    if (!server && tool?.includes('/')) {
      server = tool.slice(0, tool.indexOf('/'));
      tool = tool.slice(tool.indexOf('/') + 1);
    }
    const parameters =
      entry.parameters && typeof entry.parameters === 'object' && !Array.isArray(entry.parameters)
        ? (entry.parameters as Record<string, string>)
        : undefined;
    return {
      raw,
      ...(server ? { server } : {}),
      ...(tool ? { tool } : {}),
      ...(typeof entry.description === 'string' ? { description: entry.description.trim() } : {}),
      ...(parameters ? { parameters } : {}),
    };
  });
}

function currentParameters(tool: CatalogTool, entry?: CachedDescription): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [name, spec] of Object.entries(properties(tool))) {
    const text = entry?.parameters?.[name] ?? (typeof spec?.description === 'string' ? spec.description : '');
    if (text) result[name] = text;
  }
  return result;
}

/**
 * Check proposals without saving anything: the tool and parameters exist, the
 * text is within bounds, and - against every tool in the catalog - the new
 * description is still closest to its own tool's original.
 */
export async function reviewProposals(
  input: unknown,
  tools: CatalogTool[],
  cache: CacheView,
  options: { mode?: DescribeMode; model?: Pick<ModelBackend, 'embed'> } = {}
): Promise<Review> {
  const mode = options.mode ?? 'rewrite';
  const byKey = new Map(tools.map((tool) => [toolKey(tool.serverName, tool.toolName), tool]));
  const parsed = parseProposals(input);

  const latest = new Map<string, number>();
  parsed.forEach((entry, position) => {
    if (entry.server && entry.tool) latest.set(toolKey(entry.server, entry.tool), position);
  });

  const reviewed: ReviewedProposal[] = parsed.map((entry, position) => {
    const problems: string[] = [];
    const warnings: string[] = [];
    const key = entry.server && entry.tool ? toolKey(entry.server, entry.tool) : undefined;
    const tool = key ? byKey.get(key) : undefined;
    const cached = tool ? cache.getEntry(tool.serverName, tool.toolName) : undefined;
    const beforeDescription = cached?.compressed ?? tool?.description ?? '';
    const beforeParameters = tool ? currentParameters(tool, cached) : {};

    if (!key) problems.push('missing server or tool');
    else if (!tool) problems.push(`no tool ${key} (unknown, or excluded)`);
    if (key && latest.get(key) !== position) problems.push('superseded by a later entry for the same tool');

    const description = entry.description ?? '';
    if (!description) problems.push('description is empty');
    if (description.length > MAX_DESCRIPTION_CHARS) {
      problems.push(`description is ${description.length} chars; the limit is ${MAX_DESCRIPTION_CHARS}`);
    }

    const afterParameters = { ...beforeParameters };
    if (entry.parameters) {
      if (mode === 'compress') {
        problems.push('parameters can only be changed in rewrite mode');
      }
      const known = tool ? properties(tool) : {};
      for (const [name, text] of Object.entries(entry.parameters)) {
        if (!(name in known)) {
          problems.push(`parameter "${name}" is not in the tool's schema`);
        } else if (typeof text !== 'string' || !text.trim()) {
          problems.push(`parameter "${name}" description is empty`);
        } else if (text.length > MAX_PARAMETER_CHARS) {
          problems.push(`parameter "${name}" description is over ${MAX_PARAMETER_CHARS} chars`);
        } else {
          afterParameters[name] = text.trim();
        }
      }
    }

    const original = tool?.description ?? '';
    if (mode === 'compress' && description.length >= original.length && original.length > 0) {
      problems.push('a compression must be shorter than the original');
    }
    if (mode === 'rewrite' && original && description.length > Math.max(original.length * 1.5, original.length + 200)) {
      warnings.push(
        `longer than the original (${original.length} -> ${description.length} chars); worth it only if the original was unclear`
      );
    }
    if (description && description === original) warnings.push('same as the original');

    return {
      server: entry.server ?? '',
      tool: entry.tool ?? '',
      accepted: problems.length === 0,
      problems,
      warnings,
      before: { description: beforeDescription, parameters: beforeParameters },
      after: { description, parameters: afterParameters },
      chars: { before: beforeDescription.length, after: description.length },
      ...(problems.length === 0 && entry.server && entry.tool
        ? {
            proposal: {
              server: entry.server,
              tool: entry.tool,
              description,
              ...(entry.parameters ? { parameters: entry.parameters } : {}),
            },
          }
        : {}),
    };
  });

  // The same check `mcp-cli audit` runs, over the proposed text only.
  const proposed = new Map(
    reviewed.filter((item) => item.accepted).map((item) => [toolKey(item.server, item.tool), item.after.description])
  );
  const audit = await auditCompression(
    tools,
    { getCompressedDescription: (server, name) => proposed.get(toolKey(server, name)) },
    options.model,
    { margin: DISTINCTNESS_MARGIN }
  );
  const confusable = new Map(audit.confusable.map((finding) => [finding.tool, finding]));
  for (const item of reviewed) {
    const finding = item.accepted ? confusable.get(toolKey(item.server, item.tool)) : undefined;
    if (finding) {
      item.accepted = false;
      delete item.proposal;
      item.problems.push(
        `reads more like ${finding.closestTo} than its own tool (${finding.otherSimilarity} vs ${finding.ownSimilarity}); say what sets it apart`
      );
    }
  }

  const accepted = reviewed.filter((item) => item.accepted).length;
  return { mode, method: audit.method, reviewed, accepted, rejected: reviewed.length - accepted };
}

/** Save accepted proposals. Rejected ones are never saved. */
export function applyReview(
  review: Review,
  tools: CatalogTool[],
  cache: CacheView & {
    saveCompressed(
      serverName: string,
      toolName: string,
      description: string,
      original?: string,
      options?: { kind?: CachedDescription['kind']; parameters?: Record<string, string> }
    ): void;
  }
): { applied: string[]; skipped: string[] } {
  const byKey = new Map(tools.map((tool) => [toolKey(tool.serverName, tool.toolName), tool]));
  const applied: string[] = [];
  const skipped: string[] = [];

  for (const item of review.reviewed) {
    const key = toolKey(item.server, item.tool);
    const tool = byKey.get(key);
    if (!item.accepted || !item.proposal || !tool) {
      skipped.push(key);
      continue;
    }
    const existing = cache.getEntry(tool.serverName, tool.toolName);
    // A stale entry's parameter rewrites describe a schema that has changed.
    const keptParameters =
      existing && !cache.isStale(tool.serverName, tool.toolName, tool.description) ? existing.parameters : undefined;
    cache.saveCompressed(tool.serverName, tool.toolName, item.proposal.description, tool.description, {
      kind: review.mode === 'rewrite' ? 'rewritten' : 'compressed',
      parameters: { ...keptParameters, ...item.proposal.parameters },
    });
    applied.push(key);
  }
  return { applied, skipped };
}
