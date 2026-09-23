import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { Logger } from 'pino';
import { NeedleBridge } from '../../src/models/needle-bridge.js';
import {
  EmbeddingIndex,
  MIN_VECTORS_TO_CENTER,
  centerFor,
  centeredCosine,
  embeddingText,
  meanVector,
} from '../../src/models/embedding-index.js';
import { createLocalModel } from '../../src/models/local-model.js';
import type { ModelBackend } from '../../src/models/types.js';
import type { CatalogTool } from '../../src/mcp/tool-catalog.js';

const FAKE_BRIDGE = join(process.cwd(), 'tests/__mocks__/fake-model-bridge.js');

function makeLogger(): Logger {
  return {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  } as unknown as Logger;
}

function bridge(env: Record<string, string> = {}, extra: Record<string, number> = {}) {
  return new NeedleBridge(
    { provider: 'needle', command: process.execPath, env, timeout: 5, ...extra },
    FAKE_BRIDGE,
    makeLogger()
  );
}

function tool(serverName: string, toolName: string, description: string): CatalogTool {
  return { serverName, toolName, description, inputSchema: { type: 'object' } };
}

describe('NeedleBridge', () => {
  const open: NeedleBridge[] = [];
  const track = (instance: NeedleBridge) => {
    open.push(instance);
    return instance;
  };

  afterEach(async () => {
    await Promise.all(open.splice(0).map((instance) => instance.close()));
  });

  it('embeds, selects and extracts over the JSON-lines protocol', async () => {
    const model = track(bridge());

    const vectors = await model.embed(['list the directory', 'send an email']);
    expect(vectors).toHaveLength(2);
    expect(vectors[0]).toBeInstanceOf(Float32Array);
    expect(vectors[0]).toHaveLength(64);
    expect(await model.embed([])).toEqual([]);

    const selection = await model.selectTool('list directory path=/tmp', [
      { name: 'fs__list_directory', description: 'List', parameters: { type: 'object' } },
    ]);
    expect(selection.calls).toEqual([
      { name: 'fs__list_directory', arguments: { path: '/tmp' } },
    ]);
    expect(selection.confidence).toBe(0.93);
    expect(selection.reasoning).toBe('matched fs__list_directory');

    const extraction = await model.extract('number: 42\ntitle: Login fails', {
      name: 'issue',
      description: 'An issue',
      parameters: {
        type: 'object',
        properties: { number: { type: 'integer' }, title: { type: 'string' } },
      },
    });
    expect(extraction.value).toEqual({ number: 42, title: 'Login fails' });
    expect(extraction.withheld).toBe(false);
  });

  it('turns a bridge error into a rejected request and keeps serving', async () => {
    const model = track(bridge());
    await expect(
      (model as unknown as { request: (m: string, p: object) => Promise<unknown> }).request('nope', {})
    ).rejects.toThrow('Local model error: unknown method: nope');
    expect(await model.embed(['still alive'])).toHaveLength(1);
  });

  it('reports a fatal start once and then fails fast without respawning', async () => {
    const spawnSpy = jest.fn(
      (await import('child_process')).spawn
    ) as unknown as typeof import('child_process').spawn;
    const model = track(
      new NeedleBridge(
        { provider: 'needle', command: process.execPath, env: { FAKE_BRIDGE_MODE: 'fatal' } },
        FAKE_BRIDGE,
        makeLogger(),
        spawnSpy
      )
    );

    await expect(model.embed(['x'])).rejects.toThrow('cannot import needle (fake)');
    await expect(model.embed(['x'])).rejects.toThrow('Local model unavailable');
    expect(spawnSpy).toHaveBeenCalledTimes(1);
    expect(model.unavailableReason()).toContain('cannot import needle');
  });

  it('reports a missing interpreter as unavailable', async () => {
    const model = track(
      new NeedleBridge(
        { provider: 'needle', command: '/nonexistent/python3' },
        FAKE_BRIDGE,
        makeLogger()
      )
    );
    await expect(model.embed(['x'])).rejects.toThrow('Local model unavailable');
  });

  it('rejects pending work when the bridge dies, and restarts on the next request', async () => {
    const model = track(bridge({ FAKE_BRIDGE_MODE: 'crash-on-request' }));
    await expect(model.embed(['x'])).rejects.toThrow('Local model bridge exited');
    // A crash after a good start is not a start failure: the next call respawns.
    expect(model.unavailableReason()).toBeUndefined();
    await expect(model.embed(['x'])).rejects.toThrow('Local model bridge exited');
  });

  it('times out a request the bridge never answers', async () => {
    const model = track(bridge({ FAKE_BRIDGE_MODE: 'silent' }, { timeout: 1 }));
    await expect(model.embed(['x'])).rejects.toThrow('timed out after 1s');
  });

  it('stops the process after the idle timeout and starts it again on demand', async () => {
    const model = track(bridge({}, { idleTimeout: 0.2 }));
    await model.embed(['x']);
    const first = (model as unknown as { child?: { pid?: number } }).child?.pid;
    expect(first).toBeDefined();

    await new Promise((resolve) => setTimeout(resolve, 500));
    expect((model as unknown as { child?: unknown }).child).toBeUndefined();

    await model.embed(['y']);
    expect((model as unknown as { child?: { pid?: number } }).child?.pid).not.toBe(first);
  });

  it('refuses work after close', async () => {
    const model = bridge();
    await model.close();
    await expect(model.embed(['x'])).rejects.toThrow('closed');
  });
});

describe('EmbeddingIndex', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'embeddings-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  /** A deterministic model: one dimension per known word, plus a shared offset. */
  function wordModel() {
    const vocabulary = ['folder', 'directory', 'list', 'email', 'send', 'person', 'remember', 'graph'];
    const embed = jest.fn(async (texts: string[]) =>
      texts.map((text) => {
        const vector = new Float32Array(vocabulary.length + 1);
        vocabulary.forEach((word, index) => {
          if (text.toLowerCase().includes(word)) vector[index] = 1;
        });
        vector[vocabulary.length] = 5; // the shared direction centering removes
        return vector;
      })
    );
    return { embed };
  }

  const tools = [
    tool('fs', 'list_directory', 'List a directory or folder.'),
    tool('mail', 'send_email', 'Send an email.'),
    tool('memory', 'create_entities', 'Remember facts about a person in a graph.'),
  ];

  it('embeds descriptions, falling back to the tool name', () => {
    expect(embeddingText(tools[0])).toBe('List a directory or folder.');
    expect(embeddingText({ toolName: 'get_file_info', description: '  ' })).toBe('get file info');
  });

  it('centers vectors so a shared direction does not dominate', () => {
    const a = new Float32Array([1, 0, 5]);
    const b = new Float32Array([0, 1, 5]);
    const mean = meanVector([a, b]);
    expect(centeredCosine(a, b, new Float32Array(3))).toBeGreaterThan(0.9);
    expect(centeredCosine(a, b, mean)).toBeLessThan(0);
    expect(centeredCosine(a, a, a)).toBe(0);
  });

  it('only subtracts a mean computed from enough vectors', () => {
    const few = [new Float32Array([1, 2]), new Float32Array([3, 4])];
    expect(Array.from(centerFor(few))).toEqual([0, 0]);

    const many = Array.from({ length: MIN_VECTORS_TO_CENTER }, () => new Float32Array([2, 4]));
    expect(Array.from(centerFor(many))).toEqual([2, 4]);
    expect(centerFor([])).toHaveLength(0);
  });

  it('scores tools against a query and caches vectors on disk', async () => {
    const model = wordModel();
    const cacheFile = join(dir, 'embeddings.json');
    const index = new EmbeddingIndex(model, makeLogger(), cacheFile);

    const scores = await index.score('remember this person', tools);
    const best = [...scores!].sort((x, y) => y[1] - x[1])[0][0];
    expect(best).toBe('memory/create_entities');
    expect(statSync(cacheFile).mode & 0o777).toBe(0o600);

    // A second index reads the cache: only the query is embedded.
    const reloaded = wordModel();
    await new EmbeddingIndex(reloaded, makeLogger(), cacheFile).score('send mail', tools);
    expect(reloaded.embed).toHaveBeenCalledTimes(1);
    expect(reloaded.embed).toHaveBeenCalledWith(['send mail']);
  });

  it('answers lexically while a large catalog indexes in the background', async () => {
    const model = wordModel();
    const index = new EmbeddingIndex(model, makeLogger());
    const many = Array.from({ length: 60 }, (_unused, i) => tool('s', `t${i}`, `tool number ${i}`));

    expect(await index.score('list folder', many)).toBeUndefined();
    await index.warm(many); // joins the indexing already running
    expect(await index.score('list folder', many)).toBeDefined();
    await expect(index.warm(many)).resolves.toBeUndefined();
  });

  it('keeps search lexical when embedding fails', async () => {
    const logger = makeLogger();
    const failing = { embed: jest.fn(async () => Promise.reject(new Error('down'))) };
    const index = new EmbeddingIndex(failing, logger);
    const many = Array.from({ length: 60 }, (_unused, i) => tool('s', `t${i}`, `tool ${i}`));

    await index.warm(many);
    expect(logger.warn).toHaveBeenCalled();
    await expect(index.score('q', tools)).rejects.toThrow('down');
  });

  it('ignores a corrupt cache file and returns nothing for empty input', async () => {
    const cacheFile = join(dir, 'embeddings.json');
    writeFileSync(cacheFile, '{not json');
    const index = new EmbeddingIndex(wordModel(), makeLogger(), cacheFile);

    expect(await index.score('   ', tools)).toBeUndefined();
    expect(await index.score('list', [])).toBeUndefined();
    expect(await index.score('list folder', tools)).toBeDefined();
  });

  it('works with the real bridge protocol end to end', async () => {
    const model = bridge();
    try {
      const index = new EmbeddingIndex(model, makeLogger());
      const scores = await index.score('send an email to bob', tools);
      const best = [...scores!].sort((x, y) => y[1] - x[1])[0][0];
      expect(best).toBe('mail/send_email');
    } finally {
      await model.close();
    }
  });
});

describe('createLocalModel', () => {
  it('returns nothing without a model section', () => {
    expect(
      createLocalModel(undefined, { bridgeScript: 'x', stateDir: '/tmp', logger: makeLogger() })
    ).toBeUndefined();
  });

  it('builds the bridge and, unless disabled, the embedding index', () => {
    const backend = { name: 'stub' } as unknown as ModelBackend;
    const withSearch = createLocalModel(
      { provider: 'needle' },
      { bridgeScript: 'x', stateDir: '/tmp', logger: makeLogger(), backend }
    );
    expect(withSearch?.backend).toBe(backend);
    expect(withSearch?.embeddings).toBeInstanceOf(EmbeddingIndex);

    const withoutSearch = createLocalModel(
      { provider: 'needle', semanticSearch: false },
      { bridgeScript: 'x', stateDir: '/tmp', logger: makeLogger() }
    );
    expect(withoutSearch?.backend).toBeInstanceOf(NeedleBridge);
    expect(withoutSearch?.embeddings).toBeUndefined();
  });
});
