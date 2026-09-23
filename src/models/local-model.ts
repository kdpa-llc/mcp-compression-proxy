import { join } from 'path';
import type { Logger } from 'pino';
import type { ModelConfig } from '../config/schema.js';
import { EmbeddingIndex } from './embedding-index.js';
import { NeedleBridge } from './needle-bridge.js';
import type { ModelBackend } from './types.js';

/** The optional local model and the services built on it. */
export interface LocalModel {
  backend: ModelBackend;
  config: ModelConfig;
  /** Absent when `semanticSearch` is false. */
  embeddings?: EmbeddingIndex;
}

/**
 * Build the local model from the `model` config section, or undefined when
 * none is configured - every caller handles both.
 *
 * `bridgeScript` comes from the entry point: only it can resolve the bundled
 * python/needle_bridge.py relative to its own compiled location.
 */
export function createLocalModel(
  config: ModelConfig | undefined,
  options: { bridgeScript: string; stateDir: string; logger: Logger; backend?: ModelBackend }
): LocalModel | undefined {
  if (!config) return undefined;

  const backend =
    options.backend ?? new NeedleBridge(config, options.bridgeScript, options.logger);
  const embeddings =
    config.semanticSearch === false
      ? undefined
      : new EmbeddingIndex(backend, options.logger, join(options.stateDir, 'embeddings.json'));

  return { backend, config, ...(embeddings ? { embeddings } : {}) };
}
