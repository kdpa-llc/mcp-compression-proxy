import type { Logger } from 'pino';
import { createConfigLoader, type ConfigResult } from '../config/loader.js';
import type { BackendPool, ClientContext, PooledBackends } from '../mcp/backend-pool.js';
import { ToolCatalog } from '../mcp/tool-catalog.js';
import type { ModelRegistry } from '../models/model-registry.js';
import { lastGoodConfig, type ProxyView } from './view.js';

export interface ClientViewOptions {
  /** How long a tool snapshot is reused; see ToolCatalog. */
  catalogTtlMs?: number;
  /** How often the client's config files are checked for edits. */
  watchIntervalMs?: number;
  /** Read the config some other way; by default it comes from the client's directory and environment. */
  loadConfig?: () => ConfigResult;
}

/**
 * A client's view over a backend pool: the configuration its own directory
 * and environment produce, its backends under the names that configuration
 * uses, and its tool snapshot. Edits to its config files are applied while
 * it is open.
 */
export class ClientView implements ProxyView {
  readonly config: () => ConfigResult;
  readonly backends: PooledBackends;
  readonly catalog: ToolCatalog;
  readonly cwd: string;
  /** Settles once the backends have connected or failed to; never rejects. */
  readonly ready: Promise<void>;

  constructor(
    pool: BackendPool,
    models: Pick<ModelRegistry, 'authConfirmer'>,
    logger: Logger,
    readonly context: ClientContext,
    options: ClientViewOptions = {}
  ) {
    this.cwd = context.cwd;
    this.config = lastGoodConfig(
      options.loadConfig ?? createConfigLoader({ cwd: context.cwd, env: context.env }),
      logger
    );
    this.backends = pool.client(context, {
      authConfirmer: () => models.authConfirmer(this.config()?.model),
    });
    this.catalog = new ToolCatalog(this.backends, logger, options.catalogTtlMs ?? 3000);
    this.ready = this.backends
      .apply(this.config())
      .catch((error) => logger.error({ error }, 'Error during backend server initialization'))
      .then(() => this.backends.watch(this.config, options.watchIntervalMs));
  }

  /** Let go of the backends; they stop once no other view holds them. */
  close(): void {
    this.backends.release();
  }
}
