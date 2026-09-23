import type { Logger } from 'pino';
import type { ConfigResult } from '../config/loader.js';
import type { BackendAccess } from '../mcp/backend-access.js';
import type { ToolCatalog } from '../mcp/tool-catalog.js';
import type { PayloadStore } from '../cli/payload-interceptor.js';
import type { CompressionCache } from '../services/compression-cache.js';
import type { ModelRegistry } from '../models/model-registry.js';

/**
 * One client's view of the proxy: its own configuration and its backends by
 * the names that configuration uses.
 *
 * The standalone proxy has exactly one. A daemon has one per distinct client
 * configuration, each over the same shared pool of backend connections.
 */
export interface ProxyView {
  /** This client's configuration, or null when it has none. */
  config(): ConfigResult;
  backends: BackendAccess;
  /** The tool snapshot for these backends; sessions on the same view share it. */
  catalog: ToolCatalog;
  /** The client's working directory: relative file arguments resolve here. */
  cwd: string;
}

/** What every session shares, whichever client it serves. */
export interface ProxyServices {
  logger: Logger;
  payloadStore: PayloadStore;
  compressionCache: CompressionCache;
  models: Pick<ModelRegistry, 'get'>;
  /** File that search learning appends to; see UsageLog. */
  usageLogFile: string;
}

/**
 * A config reader that keeps serving the last configuration that loaded.
 *
 * An editor saving servers.json leaves invalid JSON on disk for a moment.
 * Reading it then must not fail the tools/list or tool call in flight; the
 * previous configuration stays in force until the file is valid again.
 */
export function lastGoodConfig(load: () => ConfigResult, logger: Logger): () => ConfigResult {
  let last: ConfigResult = null;
  let lastError: string | undefined;
  return () => {
    try {
      last = load();
      lastError = undefined;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message !== lastError) {
        logger.warn({ error: message }, 'Config could not be read; keeping the previous one');
        lastError = message;
      }
    }
    return last;
  };
}
