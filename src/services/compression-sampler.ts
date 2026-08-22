import type { Logger } from 'pino';
import type { ObservedTool } from './stats-service.js';

/** A compressed description ready to be cached. */
export type SampledDescription = {
  serverName: string;
  toolName: string;
  description: string;
};

/** Minimal shape of the SDK's createMessage result that we depend on. */
export type SamplingResult = {
  content?: { type?: string; text?: string } | Array<{ type?: string; text?: string }>;
};

/** The subset of the MCP server surface this needs, so it can be tested. */
export type SamplingHost = {
  /** Client capabilities from the initialize handshake, if connected. */
  getClientCapabilities(): { sampling?: unknown } | undefined;
  /** Ask the host LLM to complete a prompt. */
  createMessage(params: {
    messages: Array<{ role: 'user'; content: { type: 'text'; text: string } }>;
    maxTokens: number;
    systemPrompt?: string;
  }): Promise<SamplingResult>;
};

const SYSTEM_PROMPT = [
  'You compress MCP tool descriptions to reduce context consumption.',
  'For each tool you are given, write a much shorter description that still states',
  'what the tool does and when to use it, so a model can choose it correctly.',
  'Keep any detail that distinguishes the tool from a similar one. Drop examples,',
  'parameter lists, and restatements of the schema.',
  'Reply with ONLY a JSON array, no prose and no code fence, shaped like:',
  '[{"serverName":"...","toolName":"...","description":"..."}]',
].join(' ');

/** Default tools per sampling request - large enough to be efficient, small
 *  enough that the reply fits comfortably in maxTokens. */
const DEFAULT_BATCH_SIZE = 10;
const TOKENS_PER_TOOL = 120;

/**
 * Compresses tool descriptions using the *host's* LLM via `sampling/createMessage`.
 *
 * This makes compression free and zero-config on clients that support
 * sampling: no separate API key, no second model to configure. Clients that
 * do not advertise the capability keep the existing agent-driven flow, where
 * the caller compresses descriptions itself and posts them back.
 */
export class CompressionSampler {
  private logger: Logger;
  private host: SamplingHost;
  private batchSize: number;

  constructor(logger: Logger, host: SamplingHost, batchSize = DEFAULT_BATCH_SIZE) {
    this.logger = logger;
    this.host = host;
    this.batchSize = Math.max(1, batchSize);
  }

  /**
   * Whether the connected client advertised the `sampling` capability.
   *
   * Cursor supports it; Claude Desktop and Cline did not at the time of
   * writing, so this must never be assumed.
   */
  isSupported(): boolean {
    try {
      return this.host.getClientCapabilities()?.sampling !== undefined;
    } catch {
      return false;
    }
  }

  /** Split tools into request-sized batches. */
  private batch(tools: ObservedTool[]): ObservedTool[][] {
    const batches: ObservedTool[][] = [];
    for (let i = 0; i < tools.length; i += this.batchSize) {
      batches.push(tools.slice(i, i + this.batchSize));
    }
    return batches;
  }

  /**
   * Pull the text out of a sampling result, which the SDK may return as a
   * single content block or an array of them.
   */
  private extractText(result: SamplingResult): string {
    const content = result?.content;
    if (!content) return '';

    if (Array.isArray(content)) {
      return content
        .filter((part) => part?.type === 'text' && typeof part.text === 'string')
        .map((part) => part.text)
        .join('');
    }

    return typeof content.text === 'string' ? content.text : '';
  }

  /**
   * Parse the model's reply into descriptions.
   *
   * Models wrap JSON in prose or a code fence often enough that requiring a
   * clean array would fail routinely, so the outermost array is extracted
   * before parsing. Entries that are malformed or name a tool that was not
   * requested are dropped rather than poisoning the cache.
   */
  private parse(text: string, requested: ObservedTool[]): SampledDescription[] {
    const start = text.indexOf('[');
    const end = text.lastIndexOf(']');
    if (start === -1 || end === -1 || end < start) {
      this.logger.warn({ reply: text.slice(0, 200) }, 'Sampling reply contained no JSON array');
      return [];
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(text.slice(start, end + 1));
    } catch (error) {
      this.logger.warn(
        { error: error instanceof Error ? error.message : 'Unknown error' },
        'Sampling reply was not valid JSON'
      );
      return [];
    }

    if (!Array.isArray(parsed)) return [];

    const allowed = new Set(requested.map((t) => `${t.serverName}:${t.toolName}`));
    const results: SampledDescription[] = [];

    for (const entry of parsed) {
      if (!entry || typeof entry !== 'object') continue;
      const { serverName, toolName, description } = entry as Record<string, unknown>;

      if (
        typeof serverName !== 'string' ||
        typeof toolName !== 'string' ||
        typeof description !== 'string' ||
        description.trim() === ''
      ) {
        continue;
      }

      // Only accept tools we actually asked about - a hallucinated name would
      // otherwise be cached and shown to the model later.
      if (!allowed.has(`${serverName}:${toolName}`)) {
        this.logger.warn({ serverName, toolName }, 'Sampling returned an unrequested tool');
        continue;
      }

      results.push({ serverName, toolName, description: description.trim() });
    }

    return results;
  }

  /** Build the user prompt for one batch. */
  private buildPrompt(tools: ObservedTool[]): string {
    const payload = tools.map((tool) => ({
      serverName: tool.serverName,
      toolName: tool.toolName,
      description: tool.description ?? '',
    }));

    return `Compress these ${tools.length} MCP tool descriptions:\n\n${JSON.stringify(payload, null, 2)}`;
  }

  /**
   * Compress the given tools via the host LLM.
   *
   * Batches are sent sequentially: each one is a round-trip through the host,
   * which may prompt a human to approve it, so firing them in parallel would
   * bury the user in approval dialogs.
   */
  async compress(tools: ObservedTool[]): Promise<{
    descriptions: SampledDescription[];
    batchesAttempted: number;
    batchesFailed: number;
  }> {
    if (tools.length === 0) {
      return { descriptions: [], batchesAttempted: 0, batchesFailed: 0 };
    }

    const batches = this.batch(tools);
    const descriptions: SampledDescription[] = [];
    let batchesFailed = 0;

    for (const [index, batchTools] of batches.entries()) {
      try {
        this.logger.debug(
          { batch: index + 1, of: batches.length, tools: batchTools.length },
          'Requesting compression from host LLM'
        );

        const result = await this.host.createMessage({
          messages: [
            {
              role: 'user',
              content: { type: 'text', text: this.buildPrompt(batchTools) },
            },
          ],
          maxTokens: batchTools.length * TOKENS_PER_TOOL,
          systemPrompt: SYSTEM_PROMPT,
        });

        const batchDescriptions = this.parse(this.extractText(result), batchTools);
        if (batchDescriptions.length === 0) {
          batchesFailed += 1;
        }
        descriptions.push(...batchDescriptions);
      } catch (error) {
        // A host may reject the request outright - the user can decline a
        // sampling prompt. Keep whatever earlier batches produced.
        batchesFailed += 1;
        this.logger.warn(
          {
            batch: index + 1,
            error: error instanceof Error ? error.message : 'Unknown error',
          },
          'Sampling request failed'
        );
      }
    }

    return { descriptions, batchesAttempted: batches.length, batchesFailed };
  }
}
