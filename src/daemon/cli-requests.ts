import { createHash } from 'crypto';
import { DEFAULT_PAYLOAD_THRESHOLD } from '../cli/payload-interceptor.js';
import { matchesIgnorePattern } from '../config/loader.js';
import { runCallScript, type CallScriptStep } from '../mcp/call-script.js';
import { VOLATILE_ENV, type BackendPool, type ClientContext } from '../mcp/backend-pool.js';
import { callToolWithAuthRecovery } from '../mcp/tool-call-executor.js';
import type { LocalModel } from '../models/local-model.js';
import type { ModelRegistry } from '../models/model-registry.js';
import { ClientView } from '../proxy/client-view.js';
import type { ProxyServices } from '../proxy/view.js';
import { ToolSearch } from '../search/tool-search.js';
import { UsageLog } from '../search/usage-log.js';
import { CallSuggester } from '../services/call-suggester.js';
import { auditCompression } from '../services/compression-audit.js';
import type { DisplayPolicy } from '../services/compression-cache.js';
import { CompressionSampler } from '../services/compression-sampler.js';
import {
  applyReview,
  nextBatch,
  reviewProposals,
  type DescribeMode,
} from '../services/description-rewrite.js';
import { openAiSamplingHost } from '../services/openai-compressor.js';
import { SessionManager } from '../services/session-manager.js';
import { readShapeSpec, shapeAndStore, shapeCompletedCall } from '../services/shaped-call.js';
import { StatsService } from '../services/stats-service.js';
import type { IPCRequest, IPCResponse, RequestContext } from '../types/index.js';
import { stableJson } from '../utils/stable-json.js';

/** A CLI view no command has used for this long is closed. */
export const CLI_VIEW_IDLE_MS = 10 * 60_000;

/**
 * One shell's view of the daemon: the configuration its directory and
 * environment produce, with the search state its commands build up.
 */
export class CliView {
  readonly usage: UsageLog;
  readonly search: ToolSearch;
  readonly stats: StatsService;
  private readonly sessions: SessionManager;

  constructor(
    readonly view: ClientView,
    services: ProxyServices,
    private readonly models: Pick<ModelRegistry, 'get'>
  ) {
    this.usage = new UsageLog(
      services.usageLogFile,
      () => view.config()?.search?.learnFromUsage === true
    );
    this.search = new ToolSearch(view.catalog, services.compressionCache, {
      usage: this.usage,
      semantic: {
        score: (query, tools) =>
          this.model()?.embeddings?.score(query, tools) ?? Promise.resolve(undefined),
      },
    });
    this.sessions = new SessionManager(services.logger);
    this.stats = new StatsService(
      services.logger,
      view.backends,
      services.compressionCache,
      this.sessions,
      () => view.config()
    );
  }

  model(): LocalModel | undefined {
    return this.models.get(this.view.config()?.model);
  }

  threshold(): number {
    return this.view.config()?.cli?.payloadThreshold ?? DEFAULT_PAYLOAD_THRESHOLD;
  }

  policy(): DisplayPolicy {
    const config = this.view.config();
    return {
      noCompressPatterns: config?.noCompressPatterns ?? [],
      fallbackBehavior: config?.compressionFallbackBehavior ?? 'original',
    };
  }

  close(): void {
    this.sessions.destroy();
    this.view.close();
  }
}

/**
 * CLI views by the directory and environment a command ran in.
 *
 * Commands from the same shell reuse one view, keeping its tool snapshot and
 * search history warm; a view nobody has used for a while is closed, and its
 * backends stop once nothing else holds them.
 */
export class CliViews {
  private readonly views = new Map<string, { view: CliView; lastUsed: number }>();
  private sweeper: ReturnType<typeof setInterval> | undefined;

  constructor(
    private readonly create: (context: ClientContext) => CliView,
    private readonly options: { idleMs?: number; now?: () => number } = {}
  ) {}

  get size(): number {
    return this.views.size;
  }

  /** The view for this directory and environment, created on first use. */
  get(context: RequestContext): CliView {
    const env = Object.fromEntries(
      Object.entries(context.env).filter(([name]) => !matchesIgnorePattern(name, VOLATILE_ENV))
    );
    const key = createHash('sha256').update(stableJson({ cwd: context.cwd, env })).digest('hex');
    const now = this.now();
    let entry = this.views.get(key);
    if (!entry) {
      entry = {
        view: this.create({ id: `cli-${key.slice(0, 12)}`, cwd: context.cwd, env: context.env }),
        lastUsed: now,
      };
      this.views.set(key, entry);
      this.startSweeping();
    }
    entry.lastUsed = now;
    return entry.view;
  }

  /** Close views idle for longer than the limit. */
  sweep(): void {
    const limit = this.options.idleMs ?? CLI_VIEW_IDLE_MS;
    for (const [key, entry] of this.views) {
      if (this.now() - entry.lastUsed >= limit) {
        this.views.delete(key);
        entry.view.close();
      }
    }
    if (this.views.size === 0 && this.sweeper) {
      clearInterval(this.sweeper);
      this.sweeper = undefined;
    }
  }

  closeAll(): void {
    for (const entry of this.views.values()) entry.view.close();
    this.views.clear();
    if (this.sweeper) clearInterval(this.sweeper);
    this.sweeper = undefined;
  }

  private now(): number {
    return (this.options.now ?? Date.now)();
  }

  private startSweeping(): void {
    if (this.sweeper) return;
    const limit = this.options.idleMs ?? CLI_VIEW_IDLE_MS;
    this.sweeper = setInterval(() => this.sweep(), Math.max(1000, Math.floor(limit / 2)));
    // Housekeeping must never be what keeps the process alive.
    this.sweeper.unref?.();
  }
}

/** Build a CLI view over a pool: config from the context, a 15 s tool snapshot. */
export function cliViewFactory(
  pool: BackendPool,
  services: ProxyServices,
  models: ModelRegistry
): (context: ClientContext) => CliView {
  return (context) =>
    new CliView(
      // CLI commands arrive seconds apart; each would otherwise list every
      // backend again.
      new ClientView(pool, models, services.logger, context, { catalogTtlMs: 15_000 }),
      services,
      models
    );
}

function failure(id: string, error: unknown): IPCResponse {
  return { id, error: { code: -1, message: error instanceof Error ? error.message : 'Unknown error' } };
}

/**
 * The mcp-cli request protocol, answered from the view of the shell each
 * request came from. A request without a context - from an older mcp-cli -
 * is answered from the daemon's own directory and environment.
 */
export class CliRequests {
  constructor(
    private readonly options: {
      views: CliViews;
      services: ProxyServices;
      /** Used for a request that carries no context of its own. */
      fallbackContext: RequestContext;
      /** The daemon-status answer. */
      status: () => Record<string, unknown>;
    }
  ) {}

  async handle(request: IPCRequest): Promise<IPCResponse> {
    const { id, method, params } = request;
    const status = method === 'daemon-status' ? this.options.status() : undefined;
    // A liveness ping must stay cheap: no view, no backends started for it.
    if (status && params?.ping === true) {
      return { id, result: status };
    }

    const cli = this.options.views.get(request.context ?? this.options.fallbackContext);
    await cli.view.ready;
    if (status) {
      // The servers of the shell that asked; the whole pool is in `backends`.
      const servers = cli.view.backends.getServerStatuses();
      return {
        id,
        result: {
          ...status,
          servers,
          connectedServers: servers.filter((server) => server.connected).length,
          totalServers: servers.length,
        },
      };
    }
    try {
      const result = await this.dispatch(cli, method, params ?? {});
      return 'error' in result ? { id, error: result.error } : { id, result: result.result };
    } catch (error) {
      this.options.services.logger.error(
        { method, error: error instanceof Error ? error.message : 'Unknown error' },
        'Request handler error'
      );
      return failure(id, error);
    }
  }

  private async dispatch(
    cli: CliView,
    method: IPCRequest['method'],
    params: Record<string, unknown>
  ): Promise<{ result: unknown } | { error: { code: number; message: string } }> {
    const { compressionCache, payloadStore } = this.options.services;
    const { view } = cli;

    switch (method) {
      case 'tools': {
        const tools = (await view.catalog.list()).map((tool) => ({
          server: tool.serverName,
          tool: tool.toolName,
          description: shortDescription(
            compressionCache.getCompressedDescription(tool.serverName, tool.toolName, tool.description) ||
              tool.description ||
              ''
          ),
        }));
        return { result: { tools, count: tools.length } };
      }

      case 'search': {
        const requested = Number(params.limit);
        const limit =
          Number.isInteger(requested) && requested > 0 ? requested : view.config()?.search?.limit;
        const found = await cli.search.search(String(params.query || ''), limit);
        return {
          result: {
            tools: found.hits,
            count: found.hits.length,
            total: found.total,
            signals: found.signals,
          },
        };
      }

      case 'search-quality':
        return {
          result: { enabled: view.config()?.search?.learnFromUsage === true, ...cli.usage.quality() },
        };

      case 'info': {
        const serverName = String(params.server || '');
        const toolName = String(params.tool || '');
        const tool = await view.catalog.find(serverName, toolName);
        if (!tool) {
          return { error: { code: -1, message: `Tool '${toolName}' not found on server '${serverName}'` } };
        }
        cli.usage.recordSelection(serverName, toolName);
        return {
          result: {
            name: tool.toolName,
            server: serverName,
            description: tool.description || '',
            inputSchema: compressionCache.applySchemaDescriptions(
              serverName,
              tool.toolName,
              tool.inputSchema,
              tool.description,
              cli.policy()
            ),
            ...(tool.title !== undefined ? { title: tool.title } : {}),
            ...(tool.annotations !== undefined ? { annotations: tool.annotations } : {}),
          },
        };
      }

      case 'call': {
        const serverName = String(params.server || '');
        const toolName = String(params.tool || '');
        const args = (params.arguments || {}) as Record<string, unknown>;
        const spec = readShapeSpec(params);
        if (!view.backends.isToolExcluded(serverName, toolName)) {
          cli.usage.recordSelection(serverName, toolName);
        }
        const { output, isError } = await this.executeText(cli, serverName, toolName, args);
        if (spec && !isError) {
          const shaped = await shapeCompletedCall(output, payloadStore, () =>
            shapeAndStore(output, spec, payloadStore, cli.threshold(), cli.model()?.backend)
          );
          return { result: { output: '', isError, payload: shaped.source, shaped } };
        }
        const captured = payloadStore.capture(output, cli.threshold());
        return { result: { output: captured.output, isError, payload: captured.reference } };
      }

      case 'payload-shape': {
        const spec = readShapeSpec(params);
        if (!spec) {
          return { error: { code: -1, message: 'Pass want and/or where to shape an output' } };
        }
        const content = payloadStore.read(String(params.id || ''), { all: true }).content;
        return {
          result: await shapeAndStore(content, spec, payloadStore, cli.threshold(), cli.model()?.backend),
        };
      }

      case 'suggest': {
        const suggestion = await new CallSuggester(cli.search, view.catalog, cli.model()?.backend).suggest(
          String(params.request || ''),
          { candidates: Number(params.candidates) || undefined }
        );
        if (params.run !== true || !suggestion.runnable || !suggestion.proposal) {
          return { result: { suggestion } };
        }
        const { server, tool, arguments: args } = suggestion.proposal;
        cli.usage.recordSelection(server, tool);
        const { output, isError } = await this.executeText(cli, server, tool, args);
        const captured = payloadStore.capture(output, cli.threshold());
        return {
          result: { suggestion, ran: { output: captured.output, isError, payload: captured.reference } },
        };
      }

      case 'audit': {
        // Audits compare the whole catalog; the embeddings cache spares
        // re-embedding every unchanged description each time.
        const model = cli.model();
        const audit = await auditCompression(
          await view.catalog.list(),
          compressionCache,
          model?.embeddings ?? model?.backend
        );
        let requeued = 0;
        if (params.requeue === true) {
          for (const finding of audit.confusable) {
            const slash = finding.tool.indexOf('/');
            if (compressionCache.invalidate(finding.tool.slice(0, slash), finding.tool.slice(slash + 1))) {
              requeued++;
            }
          }
          if (requeued > 0) await compressionCache.saveToDisk();
        }
        return { result: { ...audit, requeued } };
      }

      case 'describe':
        return this.describe(cli, params);

      case 'compress':
        return this.compress(cli, params);

      case 'payload-read':
        return {
          result: payloadStore.read(String(params.id || ''), {
            offset: params.offset as number | undefined,
            length: params.length as number | undefined,
            all: params.all as boolean | undefined,
          }),
        };

      case 'payload-find':
        return {
          result: payloadStore.find(String(params.id || ''), String(params.query || ''), {
            caseSensitive: params.caseSensitive as boolean | undefined,
            maxMatches: params.maxMatches as number | undefined,
            contextChars: params.contextChars as number | undefined,
          }),
        };

      case 'script': {
        if (!Array.isArray(params.steps)) {
          return { error: { code: -1, message: 'Script steps must be an array' } };
        }
        const threshold = cli.threshold();
        return {
          result: await runCallScript(
            params.steps as CallScriptStep[],
            (server, tool, args) => this.executeText(cli, server, tool, args),
            payloadStore,
            threshold,
            (output, spec) => shapeAndStore(output, spec, payloadStore, threshold, cli.model()?.backend)
          ),
        };
      }

      case 'stats':
        return {
          result: await cli.stats.getStats({
            serverName: params.serverName as string | undefined,
            detailLevel: (params.detailLevel as 'summary' | 'full') || 'summary',
          }),
        };

      default:
        return { error: { code: -1, message: `Unknown method: ${method}` } };
    }
  }

  /** Run a backend tool and join its text content. */
  private async executeText(
    cli: CliView,
    serverName: string,
    toolName: string,
    args: Record<string, unknown>
  ): Promise<{ output: string; isError?: boolean }> {
    const result = await callToolWithAuthRecovery(
      cli.view.backends,
      this.options.services.logger,
      serverName,
      toolName,
      args
    );
    const output = (result.content as Array<{ type: string; text?: string }>)
      .flatMap((item) => (item.type === 'text' && item.text ? [item.text] : []))
      .join('\n');
    return { output, isError: result.isError };
  }

  private async describe(
    cli: CliView,
    params: Record<string, unknown>
  ): Promise<{ result: unknown } | { error: { code: number; message: string } }> {
    const { compressionCache } = this.options.services;
    const action = String(params.action || '');
    const mode: DescribeMode = params.mode === 'compress' ? 'compress' : 'rewrite';
    const tools = await cli.view.catalog.list();

    if (action === 'next') {
      return {
        result: nextBatch(tools, compressionCache, {
          mode,
          limit: Number(params.limit) || undefined,
          server: typeof params.server === 'string' ? params.server : undefined,
          tool: typeof params.tool === 'string' ? params.tool : undefined,
          all: params.all === true,
        }),
      };
    }

    if (action === 'review' || action === 'apply') {
      const model = cli.model();
      const review = await reviewProposals(params.proposals, tools, compressionCache, {
        mode,
        model: model?.embeddings ?? model?.backend,
      });
      if (action === 'review') return { result: review };
      const outcome = applyReview(review, tools, compressionCache);
      if (outcome.applied.length > 0) await compressionCache.saveToDisk();
      return { result: { ...review, ...outcome } };
    }

    if (action === 'revert') {
      const targets =
        params.all === true
          ? compressionCache.getCacheEntries().map((entry) => `${entry.serverName}/${entry.toolName}`)
          : [String(params.tool || '')];
      const reverted = targets.filter((key) => {
        const slash = key.indexOf('/');
        return slash > 0 && compressionCache.invalidate(key.slice(0, slash), key.slice(slash + 1));
      });
      if (reverted.length > 0) await compressionCache.saveToDisk();
      return { result: { reverted } };
    }

    return { error: { code: -1, message: `Unknown describe action: ${action}` } };
  }

  private async compress(
    cli: CliView,
    params: Record<string, unknown>
  ): Promise<{ result: unknown } | { error: { code: number; message: string } }> {
    const { compressionCache, logger } = this.options.services;
    const compressor = cli.view.config()?.compressor;
    if (!compressor) {
      return {
        error: {
          code: -1,
          message:
            'No compressor configured. Add "compressor": { "url": "http://localhost:11434/v1", "model": "..." } to servers.json.',
        },
      };
    }
    const limit = Math.min(Math.max(Number(params.limit) || 25, 1), 100);
    const tools = await cli.view.catalog.list();
    const needsWork = (tool: (typeof tools)[number]) =>
      !compressionCache.hasCompressed(tool.serverName, tool.toolName, tool.description) ||
      compressionCache.isStale(tool.serverName, tool.toolName, tool.description);

    const pending = tools.filter(needsWork).slice(0, limit);
    const sampler = new CompressionSampler(logger, openAiSamplingHost(compressor));
    const { descriptions, batchesAttempted, batchesFailed } = await sampler.compress(pending);
    const originals = new Map(tools.map((tool) => [`${tool.serverName}:${tool.toolName}`, tool.description]));
    for (const entry of descriptions) {
      compressionCache.saveCompressed(
        entry.serverName,
        entry.toolName,
        entry.description,
        originals.get(`${entry.serverName}:${entry.toolName}`)
      );
    }
    if (descriptions.length > 0) await compressionCache.saveToDisk();
    return {
      result: {
        compressed: descriptions.length,
        attempted: pending.length,
        batchesAttempted,
        batchesFailed,
        remaining: tools.filter(needsWork).length,
      },
    };
  }
}

/** A compressed or original description cut to ~60 chars for listings. */
function shortDescription(description: string): string {
  return description.length > 60 ? description.slice(0, 57) + '...' : description;
}
