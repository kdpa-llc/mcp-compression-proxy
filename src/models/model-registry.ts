import type { Logger } from 'pino';
import type { ModelConfig } from '../config/schema.js';
import { createLocalModel, type LocalModel } from './local-model.js';

/** JSON with object keys sorted, so equal settings written in another order match. */
export function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, entry: unknown) =>
    entry !== null && typeof entry === 'object' && !Array.isArray(entry)
      ? Object.fromEntries(
          Object.entries(entry as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : 1))
        )
      : entry
  );
}

/**
 * Local models by the `model` section that asked for them.
 *
 * Clients whose configs describe the same model share one bridge process, so
 * a daemon serving five sessions runs one Needle, not five. A model is created
 * on first use and stops its own process when idle; `closeAll` ends them all.
 */
export class ModelRegistry {
  private readonly models = new Map<string, LocalModel>();

  constructor(
    private readonly options: {
      bridgeScript: string;
      stateDir: string;
      logger: Logger;
      create?: typeof createLocalModel;
    }
  ) {}

  get(config: ModelConfig | undefined): LocalModel | undefined {
    if (!config) return undefined;
    const key = stableJson(config);
    const existing = this.models.get(key);
    if (existing) return existing;

    const create = this.options.create ?? createLocalModel;
    const model = create(config, {
      bridgeScript: this.options.bridgeScript,
      stateDir: this.options.stateDir,
      logger: this.options.logger,
    });
    if (model) this.models.set(key, model);
    return model;
  }

  async closeAll(): Promise<void> {
    const models = [...this.models.values()];
    this.models.clear();
    await Promise.allSettled(models.map((model) => model.backend.close()));
  }
}
