import { describe, it, expect, jest } from '@jest/globals';
import type { Logger } from 'pino';
import { tmpdir } from 'os';
import { ModelRegistry, stableJson } from '../../src/models/model-registry.js';
import type { LocalModel, createLocalModel } from '../../src/models/local-model.js';
import { NeedleBridge } from '../../src/models/needle-bridge.js';

type Create = typeof createLocalModel;

const logger = { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() } as unknown as Logger;

describe('stableJson', () => {
  it('ignores key order at every level but keeps array order', () => {
    expect(stableJson({ b: 1, a: { d: 2, c: [3, 1] } })).toBe(stableJson({ a: { c: [3, 1], d: 2 }, b: 1 }));
    expect(stableJson([1, 2])).not.toBe(stableJson([2, 1]));
  });
});

describe('ModelRegistry', () => {
  function fakeModel(): LocalModel {
    const close = jest.fn(async () => undefined);
    return { backend: { close }, config: { provider: 'needle' } } as unknown as LocalModel;
  }

  it('creates a model per distinct model section and shares it between equal ones', () => {
    const create = jest.fn<Create>(() => fakeModel());
    const registry = new ModelRegistry({ bridgeScript: 'bridge.py', stateDir: tmpdir(), logger, create });

    expect(registry.get(undefined)).toBeUndefined();
    const first = registry.get({ provider: 'needle', command: 'python3', timeout: 5 });
    expect(registry.get({ timeout: 5, command: 'python3', provider: 'needle' })).toBe(first);
    expect(registry.get({ provider: 'needle', command: '/venv/bin/python' })).not.toBe(first);
    expect(create).toHaveBeenCalledTimes(2);
    expect(create).toHaveBeenCalledWith(
      { provider: 'needle', command: 'python3', timeout: 5 },
      { bridgeScript: 'bridge.py', stateDir: tmpdir(), logger }
    );
  });

  it('does not remember a section the factory declined', () => {
    const create = jest.fn<Create>(() => undefined);
    const registry = new ModelRegistry({ bridgeScript: 'bridge.py', stateDir: tmpdir(), logger, create });
    expect(registry.get({ provider: 'needle' })).toBeUndefined();
    registry.get({ provider: 'needle' });
    expect(create).toHaveBeenCalledTimes(2);
  });

  it('closes every model, even when one fails to', async () => {
    const models = [fakeModel(), fakeModel()];
    (models[0].backend.close as jest.Mock<() => Promise<void>>).mockRejectedValue(new Error('stuck'));
    const create = jest.fn<Create>(() => models.shift() as LocalModel);
    const registry = new ModelRegistry({ bridgeScript: 'bridge.py', stateDir: tmpdir(), logger, create });
    const a = registry.get({ provider: 'needle', timeout: 1 }) as LocalModel;
    const b = registry.get({ provider: 'needle', timeout: 2 }) as LocalModel;

    await registry.closeAll();
    expect(a.backend.close).toHaveBeenCalled();
    expect(b.backend.close).toHaveBeenCalled();

    // Closed models are forgotten: the next request builds a new one.
    models.push(fakeModel());
    expect(registry.get({ provider: 'needle', timeout: 1 })).not.toBe(a);
  });

  it('builds the real bridge by default, without starting it', async () => {
    const registry = new ModelRegistry({ bridgeScript: 'bridge.py', stateDir: tmpdir(), logger });
    const model = registry.get({ provider: 'needle', semanticSearch: false });
    expect(model?.backend).toBeInstanceOf(NeedleBridge);
    await registry.closeAll();
  });
});
