import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
  type ListToolsResult,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js';
import { readFileSync, writeFileSync } from 'fs';
import { resolve } from 'path';
import { matchesIgnorePattern } from '../config/loader.js';
import { DEFAULT_PAYLOAD_THRESHOLD } from '../cli/payload-interceptor.js';
import { runCallScript, type CallScriptStep } from '../mcp/call-script.js';
import type { CatalogTool } from '../mcp/tool-catalog.js';
import { callToolWithAuthRecovery } from '../mcp/tool-call-executor.js';
import type { LocalModel } from '../models/local-model.js';
import { LAZY_KEPT_MANAGEMENT_TOOLS, MetaTools } from '../native/meta-tools.js';
import { ToolSearch } from '../search/tool-search.js';
import { UsageLog } from '../search/usage-log.js';
import type { DisplayPolicy } from '../services/compression-cache.js';
import { CompressionSampler } from '../services/compression-sampler.js';
import { openAiSamplingHost } from '../services/openai-compressor.js';
import { SessionManager } from '../services/session-manager.js';
import { shapeAndStore } from '../services/shaped-call.js';
import { StatsService } from '../services/stats-service.js';
import { SERVER_NAME, VERSION } from '../version.js';
import { managementTools } from './management-tools.js';
import type { ProxyServices, ProxyView } from './view.js';

/** Tools returned per `tools/list` page when the client does not stop early. */
export const DEFAULT_TOOLS_PAGE_SIZE = 100;

const PREFIX = 'mcp-compression-proxy__';

type ToolArgs = Record<string, unknown>;

function text(message: string, isError = false): CallToolResult {
  return { content: [{ type: 'text', text: message }], ...(isError ? { isError: true } : {}) };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Unknown error';
}

/** A tool error carrying whatever was thrown, Error or not. */
function thrown(error: unknown): CallToolResult {
  return text(error instanceof Error ? error.message : String(error), true);
}

function toolResultText(result: CallToolResult): string {
  return result.content
    .flatMap((item) => (item.type === 'text' && item.text ? [item.text] : []))
    .join('\n');
}

/**
 * Decode a pagination cursor into an offset.
 *
 * Cursors are opaque to the client but are just offsets here - each session
 * serves one client, so there is nothing to tamper-proof against. Returns
 * `undefined` for a cursor that cannot be honoured, which the caller reports
 * rather than treating as "start over". The SDK has already checked that it
 * is a string.
 */
function parseCursor(cursor: string | undefined): number | undefined {
  if (cursor === undefined) return 0;

  const offset = Number.parseInt(cursor, 10);
  return Number.isInteger(offset) && offset >= 0 && String(offset) === cursor ? offset : undefined;
}

export interface ProxySessionOptions {
  /** Tools per `tools/list` page; a test can lower it to force pagination. */
  toolsPageSize?: number;
}

/**
 * One MCP client's session with the proxy: the tools it is shown, the calls
 * it makes, and its expanded-tool state.
 *
 * Everything the client configures comes from its view; everything that can
 * be shared - compression cache, payloads, local models - from the services.
 * The standalone proxy runs one session over stdio. A daemon runs one per
 * attached client, so this class holds no process-wide state of its own.
 */
export class ProxySession {
  readonly server: Server;
  private readonly sessions: SessionManager;
  private currentSessionId: string | undefined;
  private readonly stats: StatsService;
  private readonly sampler: CompressionSampler;
  private readonly usage: UsageLog;
  private readonly search: ToolSearch;
  private readonly metaTools: MetaTools;
  private readonly pageSize: number;

  constructor(
    private readonly view: ProxyView,
    private readonly services: ProxyServices,
    options: ProxySessionOptions = {}
  ) {
    const { logger, compressionCache, payloadStore } = services;

    this.server = new Server({ name: SERVER_NAME, version: VERSION }, { capabilities: { tools: {} } });
    this.sessions = new SessionManager(logger);
    this.stats = new StatsService(logger, view.backends, compressionCache, this.sessions, () =>
      view.config()
    );
    // Compresses via the client's own LLM when it supports sampling.
    this.sampler = new CompressionSampler(logger, {
      getClientCapabilities: () => this.server.getClientCapabilities(),
      createMessage: (params) => this.server.createMessage(params),
    });
    this.usage = new UsageLog(
      services.usageLogFile,
      () => view.config()?.search?.learnFromUsage === true
    );
    this.search = new ToolSearch(view.catalog, compressionCache, {
      usage: this.usage,
      semantic: {
        score: (query, tools) =>
          this.model()?.embeddings?.score(query, tools) ?? Promise.resolve(undefined),
      },
    });
    this.metaTools = new MetaTools({
      catalog: view.catalog,
      search: this.search,
      usage: this.usage,
      compression: {
        getCompressedDescription: (server, tool, original) =>
          compressionCache.getCompressedDescription(server, tool, original),
        applySchemaDescriptions: <T>(server: string, tool: string, schema: T, original?: string) =>
          compressionCache.applySchemaDescriptions(server, tool, schema, original, this.displayPolicy()),
        invalidate: (server, tool) => compressionCache.invalidate(server, tool),
        saveToDisk: () => compressionCache.saveToDisk(),
      },
      payloadStore,
      threshold: () => this.payloadThreshold(),
      model: () => this.model()?.backend,
      embedder: () => this.model()?.embeddings,
      callBackend: (server, tool, args) => this.callAggregated(server, tool, args),
      executeText: async (server, tool, args) => {
        const executed = await this.executeBackendTool(server, tool, args);
        return { output: executed.output, isError: executed.result.isError };
      },
    });
    // Anything unparseable or non-positive falls back rather than producing an
    // empty page forever.
    const pageSize = options.toolsPageSize ?? DEFAULT_TOOLS_PAGE_SIZE;
    this.pageSize = Number.isInteger(pageSize) && pageSize > 0 ? pageSize : DEFAULT_TOOLS_PAGE_SIZE;

    this.server.setRequestHandler(ListToolsRequestSchema, (request) =>
      this.listTools(request.params?.cursor)
    );
    this.server.setRequestHandler(CallToolRequestSchema, (request) =>
      this.callTool(request.params.name, (request.params.arguments ?? {}) as ToolArgs)
    );
  }

  connect(transport: Transport): Promise<void> {
    return this.server.connect(transport);
  }

  /** Close the client connection and drop this session's state. Backends stay up. */
  async close(): Promise<void> {
    this.sessions.destroy();
    try {
      await this.server.close();
    } catch (error) {
      this.services.logger.debug({ error }, 'Error while closing a session transport');
    }
  }

  /**
   * Index tool embeddings ahead of the first search. Lazy exposure searches on
   * every discovery, so the first one should not pay for the whole catalog.
   */
  warmSearch(): void {
    const embeddings = this.model()?.embeddings;
    if (!embeddings || this.view.config()?.toolExposure !== 'lazy') return;
    this.view.catalog
      .list()
      .then((tools) => embeddings.warm(tools))
      .catch((error) =>
        this.services.logger.warn({ error: String(error) }, 'Could not index tool embeddings')
      );
  }

  private model(): LocalModel | undefined {
    return this.services.models.get(this.view.config()?.model);
  }

  private payloadThreshold(): number {
    return this.view.config()?.cli?.payloadThreshold ?? DEFAULT_PAYLOAD_THRESHOLD;
  }

  private displayPolicy(): DisplayPolicy {
    const config = this.view.config();
    return {
      noCompressPatterns: config?.noCompressPatterns ?? [],
      fallbackBehavior: config?.compressionFallbackBehavior ?? 'original',
    };
  }

  private async executeBackendTool(
    serverName: string,
    toolName: string,
    args: ToolArgs
  ): Promise<{ result: CallToolResult; output: string }> {
    const result = await callToolWithAuthRecovery(
      this.view.backends,
      this.services.logger,
      serverName,
      toolName,
      args
    );
    return { result, output: toolResultText(result) };
  }

  /**
   * A backend call as a client sees it: excluded tools refused, large results
   * replaced by a payload reference.
   */
  private async callAggregated(
    serverName: string,
    toolName: string,
    args: ToolArgs
  ): Promise<CallToolResult> {
    try {
      const executed = await this.executeBackendTool(serverName, toolName, args);
      const captured = this.services.payloadStore.capture(executed.output, this.payloadThreshold());
      if (!captured.reference) {
        return executed.result;
      }
      return {
        content: [{ type: 'text', text: captured.output }],
        isError: executed.result.isError,
        structuredContent: { payload: captured.reference },
      };
    } catch (error) {
      this.services.logger.error({ serverName, toolName, error }, 'Tool call failed');
      return text(`Error calling tool: ${errorMessage(error)}`, true);
    }
  }

  /**
   * Every tool from every backend, once, with excluded tools already dropped:
   * every consumer of this snapshot - the compression tools included - must
   * agree on which tools exist, or the proxy asks the model to spend calls
   * compressing tools it will never advertise.
   */
  private backendTools(): Promise<CatalogTool[]> {
    return this.view.catalog.list();
  }

  /**
   * Whether a tool still needs compressing: never compressed, or compressed
   * from a description the backend has since changed.
   */
  private needsCompression(tool: CatalogTool): boolean {
    const cache = this.services.compressionCache;
    return (
      !cache.hasCompressed(tool.serverName, tool.toolName, tool.description) ||
      cache.isStale(tool.serverName, tool.toolName, tool.description)
    );
  }

  /** List backend tools plus the proxy's own, as this client's config asks. */
  private async listTools(cursor: string | undefined): Promise<ListToolsResult> {
    const { logger, compressionCache } = this.services;
    logger.debug('Handling tools/list request');

    // Fetch backend tools first so the management tools can advertise live
    // coverage numbers derived from this same snapshot.
    const backendTools = await this.backendTools();
    const liveStats = this.stats.formatCoverage(this.stats.computeCoverage(backendTools));
    const policy = this.displayPolicy();

    const aggregatedTools: Tool[] = backendTools.map((tool) => {
      const isExpanded = this.sessions.isToolExpanded(
        this.currentSessionId,
        tool.serverName,
        tool.toolName
      );

      // title and annotations pass through: clients use hints such as
      // readOnlyHint to decide what may run without asking. outputSchema does
      // not - a result over the payload threshold is replaced by a payload
      // reference, which would fail the client's validation against it.
      return {
        name: `${tool.serverName}__${tool.toolName}`,
        description: compressionCache.getDescription(
          tool.serverName,
          tool.toolName,
          tool.description,
          isExpanded,
          policy
        ),
        inputSchema: isExpanded
          ? tool.inputSchema
          : compressionCache.applySchemaDescriptions(
              tool.serverName,
              tool.toolName,
              tool.inputSchema,
              tool.description,
              policy
            ),
        ...(tool.title !== undefined ? { title: tool.title } : {}),
        ...(tool.annotations !== undefined ? { annotations: tool.annotations } : {}),
      };
    });

    const config = this.view.config();
    const management = managementTools(liveStats);
    // Lazy exposure lists a few discovery tools instead of every backend
    // schema; pinnedTools keeps chosen backend tools listed directly.
    const allTools =
      config?.toolExposure === 'lazy'
        ? [
            ...this.metaTools.definitions('lazy'),
            ...management.filter((tool) => LAZY_KEPT_MANAGEMENT_TOOLS.includes(tool.name)),
            ...aggregatedTools.filter((tool) =>
              matchesIgnorePattern(tool.name, config.pinnedTools ?? [])
            ),
          ]
        : [...management, ...this.metaTools.definitions('full'), ...aggregatedTools];

    // Backend tools are already filtered; this also lets excludeTools hide the
    // proxy's own management tools.
    const excludePatterns = this.view.backends.getExcludePatterns();
    const filteredTools = allTools.filter((tool) => !matchesIgnorePattern(tool.name, excludePatterns));

    logger.debug(
      { count: filteredTools.length, excluded: allTools.length - filteredTools.length },
      'Returning tools'
    );

    // Paginate over the post-exclude list: a cursor pointing into the unfiltered
    // set would drift as patterns change, and would leak excluded tools at the
    // page boundaries.
    const offset = parseCursor(cursor);
    if (offset === undefined) {
      return {
        tools: [],
        // The spec has no error channel here, so an unusable cursor returns
        // nothing rather than silently restarting from the top - a caller
        // looping on nextCursor would otherwise never terminate.
        _meta: { error: `Invalid cursor: ${String(cursor)}` },
      };
    }

    const page = filteredTools.slice(offset, offset + this.pageSize);
    const nextOffset = offset + page.length;
    return {
      tools: page,
      ...(nextOffset < filteredTools.length ? { nextCursor: String(nextOffset) } : {}),
    };
  }

  /** Call a management tool, a discovery tool, or a backend tool. */
  private async callTool(name: string, args: ToolArgs): Promise<CallToolResult> {
    this.services.logger.debug({ tool: name, args }, 'Handling tools/call request');

    // Exclusion applies to the public name too, before a management tool or
    // wrapper can change state or dispatch a separately allowed backend tool.
    if (matchesIgnorePattern(name, this.view.backends.getExcludePatterns())) {
      return text(`Tool '${name}' is excluded by the excludeTools configuration`, true);
    }

    if (this.metaTools.handles(name)) {
      return this.metaTools.call(name, args);
    }

    const management = this.managementHandler(name);
    if (management) {
      return management(args);
    }

    // Tool name format: "serverName__toolName". Split on the first separator
    // only - backend tools are free to have "__" in their own names.
    const separatorIndex = name.indexOf('__');
    if (separatorIndex <= 0 || separatorIndex + 2 >= name.length) {
      return text(
        `Error: Invalid tool name format. Expected "serverName__toolName", got "${name}"`,
        true
      );
    }

    return this.callAggregated(name.slice(0, separatorIndex), name.slice(separatorIndex + 2), args);
  }

  private managementHandler(name: string): ((args: ToolArgs) => Promise<CallToolResult>) | undefined {
    switch (name) {
      case `${PREFIX}create_session`:
        return async () => this.createSession();
      case `${PREFIX}delete_session`:
        return async (args) => this.deleteSession(args);
      case `${PREFIX}set_session`:
        return async (args) => this.setSession(args);
      case `${PREFIX}clear_compressed_tools_cache`:
        return () => this.clearCache();
      case `${PREFIX}get_uncompressed_tools`:
        return (args) => this.getUncompressedTools(args);
      case `${PREFIX}cache_compressed_tools`:
        return (args) => this.cacheCompressedTools(args);
      case `${PREFIX}invalidate_tool_cache`:
        return (args) => this.invalidateToolCache(args);
      case `${PREFIX}expand_tool`:
        return async (args) => this.expandTool(args);
      case `${PREFIX}collapse_tool`:
        return async (args) => this.collapseTool(args);
      case `${PREFIX}compress_via_sampling`:
        return (args) => this.compressViaSampling(args);
      case `${PREFIX}stats`:
        return (args) => this.getStats(args);
      case `${PREFIX}read_output`:
        return async (args) => this.readOutput(args);
      case `${PREFIX}find_output`:
        return async (args) => this.findOutput(args);
      case `${PREFIX}run_script`:
        return (args) => this.runScript(args);
      default:
        return undefined;
    }
  }

  private createSession(): CallToolResult {
    const sessionId = this.sessions.createSession();
    this.currentSessionId = sessionId;
    return text(
      `Session created: ${sessionId}\n\nThis session is now active. Tools expanded in this session will show full descriptions.`
    );
  }

  private deleteSession(args: ToolArgs): CallToolResult {
    const { sessionId } = args as { sessionId: string };
    const deleted = this.sessions.deleteSession(sessionId);
    if (this.currentSessionId === sessionId) {
      this.currentSessionId = undefined;
    }
    return text(
      deleted ? `Session ${sessionId} deleted successfully.` : `Session ${sessionId} not found.`
    );
  }

  private setSession(args: ToolArgs): CallToolResult {
    const { sessionId } = args as { sessionId: string };
    if (!this.sessions.hasSession(sessionId)) {
      return text(
        `Error: Session ${sessionId} not found. Create a session first with mcp-compression-proxy__create_session.`,
        true
      );
    }
    this.currentSessionId = sessionId;
    return text(`Active session set to: ${sessionId}`);
  }

  private async clearCache(): Promise<CallToolResult> {
    try {
      await this.services.compressionCache.clearAll();
      this.services.logger.info('Compression cache cleared');
      return text('Successfully cleared all cached compressed tool descriptions.');
    } catch (error) {
      this.services.logger.error({ error }, 'Failed to clear cache');
      return text(`Error clearing cache: ${errorMessage(error)}`, true);
    }
  }

  private async getUncompressedTools(args: ToolArgs): Promise<CallToolResult> {
    const { limit = 25, outputFile } = args as { limit?: number; outputFile?: string };
    const actualLimit = Math.min(Math.max(limit, 1), 100);

    const backendTools = await this.backendTools();
    const liveStats = this.stats.formatCoverage(this.stats.computeCoverage(backendTools));

    // Stale entries rejoin the queue alongside never-compressed ones, so a
    // backend that rewrites a description is picked up by the existing
    // compress -> cache loop without the caller learning a new concept.
    const allUncompressedTools = backendTools
      .filter((tool) => this.needsCompression(tool))
      .map((tool) => ({
        serverName: tool.serverName,
        toolName: tool.toolName,
        description: tool.description || '',
      }));

    const toolsToCompress = allUncompressedTools.slice(0, actualLimit);
    const remaining = Math.max(0, allUncompressedTools.length - actualLimit);
    const next =
      remaining > 0
        ? '\n\nThen call mcp-compression-proxy__get_uncompressed_tools again to get the next batch.'
        : '';

    if (outputFile) {
      // Relative to the client's directory, not the process's: a daemon's
      // working directory is wherever it happened to be started.
      try {
        const filePath = resolve(this.view.cwd, outputFile);
        writeFileSync(filePath, JSON.stringify(toolsToCompress, null, 2), 'utf-8');
        this.services.logger.info({ filePath, count: toolsToCompress.length }, 'Wrote tools to file');
        return text(
          `Found ${allUncompressedTools.length} tools without compressed descriptions.\n\nWrote ${toolsToCompress.length} tools to file: ${filePath}\n\nRemaining uncached tools: ${remaining}\n\n${liveStats}\n\nAfter compressing the descriptions in the file, call mcp-compression-proxy__cache_compressed_tools with inputFile parameter.${next}`
        );
      } catch (error) {
        this.services.logger.error({ outputFile, error }, 'Failed to write tools to file');
        return text(`Error writing tools to file: ${errorMessage(error)}`, true);
      }
    }

    return text(
      `Found ${allUncompressedTools.length} tools without compressed descriptions.\n\nReturning ${toolsToCompress.length} tools for compression (limit: ${actualLimit}).\n\nRemaining uncached tools: ${remaining}\n\n${liveStats}\n\nTools to compress:\n\n${JSON.stringify(toolsToCompress, null, 2)}\n\nAfter compressing these descriptions, call mcp-compression-proxy__cache_compressed_tools with the results.${next}`
    );
  }

  private async cacheCompressedTools(args: ToolArgs): Promise<CallToolResult> {
    const { descriptions, inputFile } = args as {
      descriptions?: Array<{ serverName: string; toolName: string; description: string }>;
      inputFile?: string;
    };

    // Validate that exactly one parameter is provided. The "neither" case is
    // handled by the final else below, which lets the compiler narrow
    // `descriptions` instead of needing a non-null assertion.
    if (descriptions && inputFile) {
      return text('Error: Cannot provide both descriptions and inputFile. Choose one method.', true);
    }

    let toolsToCache: Array<{ serverName: string; toolName: string; description: string }>;

    if (inputFile) {
      try {
        const filePath = resolve(this.view.cwd, inputFile);
        toolsToCache = JSON.parse(readFileSync(filePath, 'utf-8'));
        if (!Array.isArray(toolsToCache)) {
          return text('Error: File must contain a JSON array of tools.', true);
        }
        this.services.logger.info({ filePath, count: toolsToCache.length }, 'Read tools from file');
      } catch (error) {
        this.services.logger.error({ inputFile, error }, 'Failed to read tools from file');
        return text(`Error reading tools from file: ${errorMessage(error)}`, true);
      }
    } else if (descriptions) {
      toolsToCache = descriptions;
    } else {
      return text('Error: Must provide either descriptions array or inputFile path.', true);
    }

    if (toolsToCache.length > 100) {
      return text(
        `Error: Cannot cache more than 100 tools at once. Received ${toolsToCache.length} tools.`,
        true
      );
    }

    // Snapshot every backend tool once. Looking the original description up per
    // tool would issue one listTools round-trip per entry (up to 100 per call).
    const cache = this.services.compressionCache;
    const backendTools = await this.backendTools();
    const originalsByKey = new Map(
      backendTools.map((tool) => [`${tool.serverName}:${tool.toolName}`, tool.description])
    );
    const coverageBefore = this.stats.computeCoverage(backendTools);

    for (const { serverName, toolName, description } of toolsToCache) {
      cache.saveCompressed(serverName, toolName, description, originalsByKey.get(`${serverName}:${toolName}`));
    }

    // Recompute against the same snapshot to report before/after coverage
    const coverageAfter = this.stats.computeCoverage(backendTools);
    const remainingTools = coverageAfter.uncompressedTools;

    try {
      await cache.saveToDisk();
      this.services.logger.info('Compression cache persisted to disk');
    } catch (error) {
      this.services.logger.error({ error }, 'Failed to persist cache to disk');
    }

    const sourceInfo = inputFile ? `from file: ${inputFile}` : 'from descriptions parameter';
    return text(
      `Cached ${toolsToCache.length} compressed tool descriptions successfully ${sourceInfo}.\n\nCoverage: ${coverageBefore.compressedTools}/${coverageBefore.totalTools} (${coverageBefore.coveragePercent}%) → ${coverageAfter.compressedTools}/${coverageAfter.totalTools} (${coverageAfter.coveragePercent}%)\nEstimated tokens saved: ~${coverageAfter.estimatedTokensSaved} (was ~${coverageBefore.estimatedTokensSaved})\n\n${remainingTools > 0 ? `Remaining tools to compress: ${remainingTools}\n\nCall mcp-compression-proxy__get_uncompressed_tools to continue with the next batch.` : 'All tools have been compressed! 🎉'}`
    );
  }

  private async invalidateToolCache(args: ToolArgs): Promise<CallToolResult> {
    const { serverName, toolName } = args as { serverName: string; toolName: string };
    const cache = this.services.compressionCache;

    if (!cache.invalidate(serverName, toolName)) {
      return text(`No cached compression found for ${serverName}:${toolName}. Nothing to invalidate.`);
    }

    try {
      await cache.saveToDisk();
    } catch (error) {
      this.services.logger.error(
        { error, serverName, toolName },
        'Failed to persist cache after invalidation'
      );
      return text(
        `Invalidated ${serverName}:${toolName} in memory, but persisting the cache failed: ${errorMessage(error)}. The entry will come back on restart.`,
        true
      );
    }

    return text(
      `Invalidated the cached compression for ${serverName}:${toolName}.\n\nIt will be offered again by mcp-compression-proxy__get_uncompressed_tools.`
    );
  }

  private expandTool(args: ToolArgs): CallToolResult {
    const { serverName, toolName } = args as { serverName: string; toolName: string };
    const cache = this.services.compressionCache;

    if (!this.currentSessionId) {
      return text(
        'Error: No active session. Create a session first with mcp-compression-proxy__create_session.',
        true
      );
    }
    if (!cache.hasCompressed(serverName, toolName)) {
      return text(`Error: No compressed description found for ${serverName}:${toolName}`, true);
    }

    this.sessions.expandTool(this.currentSessionId, serverName, toolName);
    const original = cache.getOriginalDescription(serverName, toolName);
    const compressed = cache.getCompressedDescription(serverName, toolName);
    return text(
      `Tool ${serverName}:${toolName} expanded in session ${this.currentSessionId}.\n\nOriginal: ${original}\nCompressed: ${compressed}`
    );
  }

  private collapseTool(args: ToolArgs): CallToolResult {
    const { serverName, toolName } = args as { serverName: string; toolName: string };
    if (!this.currentSessionId) {
      return text('Error: No active session.', true);
    }
    this.sessions.collapseTool(this.currentSessionId, serverName, toolName);
    return text(`Tool ${serverName}:${toolName} collapsed in session ${this.currentSessionId}.`);
  }

  private async compressViaSampling(args: ToolArgs): Promise<CallToolResult> {
    const { limit = 25 } = args as { limit?: number };
    const actualLimit = Math.min(Math.max(limit, 1), 100);
    const { logger, compressionCache } = this.services;

    // Prefer the client's own model; fall back to a configured compressor
    // endpoint, since sampling is deprecated and many clients never had it.
    const compressor = this.view.config()?.compressor;
    const sampler = this.sampler.isSupported()
      ? this.sampler
      : compressor
        ? new CompressionSampler(logger, openAiSamplingHost(compressor))
        : undefined;

    if (!sampler) {
      return text(
        'Error: This client does not support MCP sampling, so the proxy cannot borrow its LLM, and no "compressor" endpoint is configured in servers.json.\n\nConfigure one (any OpenAI-compatible /chat/completions, e.g. Ollama at http://localhost:11434/v1), or use the manual flow: call mcp-compression-proxy__get_uncompressed_tools, compress the descriptions yourself, then post them back with mcp-compression-proxy__cache_compressed_tools.',
        true
      );
    }

    const backendTools = await this.backendTools();
    const coverageBefore = this.stats.computeCoverage(backendTools);
    const uncompressed = backendTools.filter((tool) => this.needsCompression(tool)).slice(0, actualLimit);

    if (uncompressed.length === 0) {
      return text(
        `Nothing to compress - all ${coverageBefore.totalTools} tools already have compressed descriptions.\n\n${this.stats.formatCoverage(coverageBefore)}`
      );
    }

    const { descriptions, batchesAttempted, batchesFailed } = await sampler.compress(uncompressed);

    for (const entry of descriptions) {
      const original = backendTools.find(
        (tool) => tool.serverName === entry.serverName && tool.toolName === entry.toolName
      )?.description;
      compressionCache.saveCompressed(entry.serverName, entry.toolName, entry.description, original);
    }

    if (descriptions.length > 0) {
      try {
        await compressionCache.saveToDisk();
      } catch (error) {
        logger.error({ error }, 'Failed to persist sampled compressions to disk');
      }
    }

    const coverageAfter = this.stats.computeCoverage(backendTools);
    const failureNote =
      batchesFailed > 0
        ? `\n\n${batchesFailed} of ${batchesAttempted} sampling batches produced no usable result. Re-run to retry them, or fall back to the manual flow.`
        : '';
    const source = sampler === this.sampler ? "this client's LLM" : `the configured compressor (${compressor?.model})`;

    return text(
      `Compressed ${descriptions.length} of ${uncompressed.length} tools using ${source}.\n\nCoverage: ${coverageBefore.compressedTools}/${coverageBefore.totalTools} (${coverageBefore.coveragePercent}%) → ${coverageAfter.compressedTools}/${coverageAfter.totalTools} (${coverageAfter.coveragePercent}%)\nEstimated tokens saved: ~${coverageAfter.estimatedTokensSaved}${failureNote}\n\n${
        coverageAfter.uncompressedTools > 0
          ? `Remaining: ${coverageAfter.uncompressedTools}. Call this tool again for the next batch.`
          : 'All tools have been compressed! 🎉'
      }`
    );
  }

  private async getStats(args: ToolArgs): Promise<CallToolResult> {
    const { serverName, detailLevel } = args as {
      serverName?: string;
      detailLevel?: 'summary' | 'full';
    };
    try {
      const stats = await this.stats.getStats({ serverName, detailLevel });
      return text(JSON.stringify(stats, null, 2));
    } catch (error) {
      this.services.logger.error({ error, serverName }, 'Failed to compute stats');
      return text(`Error generating stats: ${errorMessage(error)}`, true);
    }
  }

  private readOutput(args: ToolArgs): CallToolResult {
    const { id, offset, length, all } = args as {
      id: string;
      offset?: number;
      length?: number;
      all?: boolean;
    };
    try {
      return text(JSON.stringify(this.services.payloadStore.read(id, { offset, length, all }), null, 2));
    } catch (error) {
      return thrown(error);
    }
  }

  private findOutput(args: ToolArgs): CallToolResult {
    const { id, query, caseSensitive, maxMatches, contextChars } = args as {
      id: string;
      query: string;
      caseSensitive?: boolean;
      maxMatches?: number;
      contextChars?: number;
    };
    try {
      const result = this.services.payloadStore.find(id, query, {
        caseSensitive,
        maxMatches,
        contextChars,
      });
      return text(JSON.stringify(result, null, 2));
    } catch (error) {
      return thrown(error);
    }
  }

  private async runScript(args: ToolArgs): Promise<CallToolResult> {
    const { steps } = args as { steps: CallScriptStep[] };
    const { payloadStore } = this.services;
    try {
      const threshold = this.payloadThreshold();
      const result = await runCallScript(
        steps,
        async (serverName, toolName, stepArgs) => {
          const executed = await this.executeBackendTool(serverName, toolName, stepArgs);
          return { output: executed.output, isError: executed.result.isError };
        },
        payloadStore,
        threshold,
        (output, spec) => shapeAndStore(output, spec, payloadStore, threshold, this.model()?.backend)
      );
      return text(JSON.stringify(result, null, 2));
    } catch (error) {
      return thrown(error);
    }
  }
}
