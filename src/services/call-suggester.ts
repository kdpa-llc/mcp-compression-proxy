import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { CatalogTool } from '../mcp/tool-catalog.js';
import type { ModelBackend, ModelCall } from '../models/types.js';
import type { ToolSearch } from '../search/tool-search.js';

/** Candidates handed to the model; Needle itself narrows to five per turn. */
export const DEFAULT_SUGGEST_CANDIDATES = 5;
/**
 * Confidence needed before a proposed call may run unattended. High on
 * purpose: on a 16-tool catalog Needle reported 0.95-1.0 for choices that
 * were wrong, so the score is a floor, never the only gate.
 */
export const DEFAULT_RUN_CONFIDENCE = 0.9;

export interface SuggestCandidate {
  server: string;
  tool: string;
  description: string;
  inputSchema: Tool['inputSchema'];
  annotations?: Tool['annotations'];
}

export interface SuggestProposal {
  server: string;
  tool: string;
  arguments: Record<string, unknown>;
  confidence: number | null;
  reasoning?: string;
  /** Argument paths the model filled without evidence in the request. */
  ungrounded: string[];
  /** The engine withheld the call as too uncertain; shown for confirmation only. */
  withheld: boolean;
  readOnly: boolean;
}

export interface SuggestResult {
  request: string;
  proposal?: SuggestProposal;
  /** Every other proposed call when the request asked for several things. */
  followUps: SuggestProposal[];
  candidates: SuggestCandidate[];
  /** Whether `proposal` passed every gate for running without confirmation. */
  runnable: boolean;
  /** Why not, when it did not. */
  runBlockedBy?: string;
  notes: string[];
}

/** Needle tool names must be identifiers; `server__tool` round-trips uniquely. */
function modelName(tool: CatalogTool): string {
  return `${tool.serverName}__${tool.toolName}`;
}

/**
 * Turn a plain-English request into a proposed tool call.
 *
 * Search narrows the catalog to a few candidates with their schemas, which is
 * useful on its own: the agent skips an info round trip. With the local model
 * configured, it also proposes arguments. It never runs anything itself;
 * `runnable` says whether a caller that asked to run may do so: the tool must
 * declare readOnlyHint, the model must be confident, every argument must be
 * grounded in the request, and the engine must not have withheld the call.
 */
export class CallSuggester {
  constructor(
    private readonly search: ToolSearch,
    private readonly catalog: { find(serverName: string, toolName: string): Promise<CatalogTool | undefined> },
    private readonly model?: Pick<ModelBackend, 'selectTool'>
  ) {}

  async suggest(
    request: string,
    options: { candidates?: number; minConfidence?: number } = {}
  ): Promise<SuggestResult> {
    const notes: string[] = [];
    const found = await this.search.search(
      request,
      options.candidates ?? DEFAULT_SUGGEST_CANDIDATES,
      { record: false }
    );

    const tools: CatalogTool[] = [];
    for (const hit of found.hits) {
      const tool = await this.catalog.find(hit.server, hit.tool);
      if (tool) tools.push(tool);
    }
    const candidates: SuggestCandidate[] = tools.map((tool) => ({
      server: tool.serverName,
      tool: tool.toolName,
      description: tool.description ?? '',
      inputSchema: tool.inputSchema,
      ...(tool.annotations ? { annotations: tool.annotations } : {}),
    }));

    const result: SuggestResult = {
      request,
      followUps: [],
      candidates,
      runnable: false,
      notes,
    };

    if (tools.length === 0) {
      notes.push('No tool matched the request.');
      result.runBlockedBy = 'no candidate tools';
      return result;
    }

    if (!this.model) {
      notes.push('No local model is configured, so arguments were not proposed; pick a candidate and fill its schema.');
      result.runBlockedBy = 'no local model';
      return result;
    }

    const byName = new Map(tools.map((tool) => [modelName(tool), tool]));
    let selection;
    try {
      selection = await this.model.selectTool(
        request,
        tools.map((tool) => ({
          name: modelName(tool),
          description: tool.description ?? tool.toolName,
          parameters: tool.inputSchema as Record<string, unknown>,
        }))
      );
    } catch (error) {
      notes.push(`The local model could not propose a call: ${error instanceof Error ? error.message : String(error)}`);
      result.runBlockedBy = 'model error';
      return result;
    }

    const toProposal = (call: ModelCall, withheld: boolean): SuggestProposal | undefined => {
      const tool = byName.get(call.name);
      if (!tool) return undefined;
      const prefix = `${call.name}.`;
      return {
        server: tool.serverName,
        tool: tool.toolName,
        arguments: call.arguments ?? {},
        confidence: selection.confidence,
        ...(selection.reasoning ? { reasoning: selection.reasoning } : {}),
        ungrounded: selection.ungrounded
          .filter((path) => path === call.name || path.startsWith(prefix))
          .map((path) => (path.startsWith(prefix) ? path.slice(prefix.length) : path)),
        withheld,
        readOnly: tool.annotations?.readOnlyHint === true,
      };
    };

    const proposals = [
      ...selection.calls.map((call) => toProposal(call, false)),
      ...selection.suppressed.map((call) => toProposal(call, true)),
    ].filter((proposal): proposal is SuggestProposal => proposal !== undefined);

    if (proposals.length === 0) {
      notes.push('The model found no candidate that fits the request; pick one yourself or rephrase.');
      result.runBlockedBy = 'no proposal';
      return result;
    }

    const [proposal, ...followUps] = proposals;
    result.proposal = proposal;
    result.followUps = followUps;
    notes.push(
      'Proposed by a small local model: check the tool and arguments before relying on them. Its confidence has been observed to stay high on wrong choices.'
    );

    const minConfidence = options.minConfidence ?? DEFAULT_RUN_CONFIDENCE;
    if (proposal.withheld) {
      result.runBlockedBy = 'the model withheld the call as uncertain';
    } else if (!proposal.readOnly) {
      result.runBlockedBy = 'the tool does not declare readOnlyHint';
    } else if (proposal.confidence === null || proposal.confidence < minConfidence) {
      result.runBlockedBy = `confidence ${proposal.confidence ?? 'unknown'} is below ${minConfidence}`;
    } else if (proposal.ungrounded.length > 0) {
      result.runBlockedBy = `arguments not found in the request: ${proposal.ungrounded.join(', ')}`;
    } else if (followUps.length > 0) {
      result.runBlockedBy = 'the request maps to more than one call';
    } else {
      result.runnable = true;
    }
    return result;
  }
}
