import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'fs';
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
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

describe('NeedleBridge process edges', () => {
  /** A child process driven by the test: write lines to its stdout by hand. */
  function fakeChild(options: { stdout?: boolean } = {}) {
    const child = new EventEmitter() as EventEmitter & {
      stdin: PassThrough;
      stdout?: PassThrough;
      stderr: PassThrough;
      kill: jest.Mock;
      ref: jest.Mock;
      unref: jest.Mock;
      written: string[];
    };
    child.stdin = new PassThrough();
    child.stdout = options.stdout === false ? undefined : new PassThrough();
    child.stderr = new PassThrough();
    child.kill = jest.fn();
    child.ref = jest.fn();
    child.unref = jest.fn();
    child.written = [];
    child.stdin.on('data', (chunk: Buffer) => child.written.push(...chunk.toString().trim().split('\n')));
    return child;
  }

  function bridgeWith(child: ReturnType<typeof fakeChild> | (() => never), config: Record<string, unknown> = {}) {
    const spawnFn = jest.fn(typeof child === 'function' ? child : () => child);
    const model = new NeedleBridge(
      { provider: 'needle', timeout: 5, ...config },
      '/bundled/needle_bridge.py',
      makeLogger(),
      spawnFn as never
    );
    return { model, spawnFn };
  }

  const say = (child: ReturnType<typeof fakeChild>, message: unknown) =>
    child.stdout?.write(`${JSON.stringify(message)}\n`);
  const tick = () => new Promise((resolve) => setImmediate(resolve));

  it('runs python3 on the bundled script by default, with telemetry off', async () => {
    const child = fakeChild();
    const { model, spawnFn } = bridgeWith(child, { idleTimeout: 0 });
    const pending = model.embed(['x']);
    say(child, { hello: 'ignored before ready' });
    say(child, { ready: true });
    await tick();

    const [command, args, options] = spawnFn.mock.calls[0] as unknown as [string, string[], { env: Record<string, string> }];
    expect(command).toBe('python3');
    expect(args).toEqual(['/bundled/needle_bridge.py']);
    expect(options.env).toMatchObject({ NEEDLE_TELEMETRY: '0', DO_NOT_TRACK: '1' });

    const request = JSON.parse(child.written[0]);
    say(child, { id: 999, result: {} }); // unknown id: ignored
    say(child, { id: request.id, result: { vectors: [] } });
    await expect(pending).resolves.toEqual([]);
    await model.close();
  });

  it('reports a spawn that throws, Error or not', async () => {
    const thrown = bridgeWith(() => {
      throw new Error('EACCES');
    });
    await expect(thrown.model.embed(['x'])).rejects.toThrow('Local model unavailable: EACCES');

    const odd = bridgeWith(() => {
      throw 'spawn failed';
    });
    await expect(odd.model.embed(['x'])).rejects.toThrow('Local model unavailable: spawn failed');
  });

  it('fails a child that has no stdout', async () => {
    const { model } = bridgeWith(fakeChild({ stdout: false }));
    await expect(model.embed(['x'])).rejects.toThrow('bridge has no stdout');
  });

  it('gives up on a model that never finishes loading', async () => {
    jest.useFakeTimers();
    try {
      const { model } = bridgeWith(fakeChild());
      const pending = model.embed(['x']);
      const assertion = expect(pending).rejects.toThrow('timed out loading the model');
      await jest.advanceTimersByTimeAsync(120_000);
      await assertion;
    } finally {
      jest.useRealTimers();
    }
  });

  it('reports a bridge error without a message, and keeps the process for concurrent work', async () => {
    const child = fakeChild();
    const { model } = bridgeWith(child, { idleTimeout: 0 });
    const first = model.embed(['a']);
    say(child, { ready: true });
    await tick();
    const second = model.embed(['b']);
    await tick();

    const [one, two] = child.written.map((line) => JSON.parse(line).id);
    say(child, { id: one, error: {} });
    await expect(first).rejects.toThrow('Local model error: unknown');
    // One request still in flight: the process stays referenced.
    expect(child.unref).not.toHaveBeenCalled();

    say(child, { id: two, result: { vectors: [] } });
    await expect(second).resolves.toEqual([]);
    expect(child.unref).toHaveBeenCalled();
    await model.close();
  });

  it('rejects work still in flight when closed', async () => {
    const child = fakeChild();
    const { model } = bridgeWith(child);
    const pending = model.embed(['x']);
    say(child, { ready: true });
    await tick();

    await model.close();
    await expect(pending).rejects.toThrow('Model bridge is closed');
    expect(child.kill).toHaveBeenCalled();
  });
});

describe('EmbeddingIndex edges', () => {
  const tools = [
    tool('fs', 'list_directory', 'List a directory.'),
    tool('mail', 'send_email', 'Send an email.'),
  ];
  const vector = () => new Float32Array([1, 0]);

  it('ignores a cache from another format version', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'embeddings-'));
    try {
      const cacheFile = join(dir, 'embeddings.json');
      writeFileSync(cacheFile, JSON.stringify({ version: 2, vectors: { abc: 'AAAA' } }));
      const embed = jest.fn(async (texts: string[]) => texts.map(vector));
      await new EmbeddingIndex({ embed }, makeLogger(), cacheFile).score('list', tools);
      // Both tools and the query had to be embedded: nothing came from the file.
      expect(embed.mock.calls.flatMap(([texts]) => texts)).toHaveLength(3);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps working when the cache cannot be written', async () => {
    const logger = makeLogger();
    const embed = jest.fn(async (texts: string[]) => texts.map(vector));
    const index = new EmbeddingIndex({ embed }, logger, '/nonexistent/dir/embeddings.json');
    expect(await index.score('list', tools)).toBeDefined();
    expect(logger.debug).toHaveBeenCalledWith(expect.anything(), 'Could not persist embedding cache');
  });

  it('answers nothing when the model returns too few vectors', async () => {
    const short = new EmbeddingIndex({ embed: jest.fn(async () => []) }, makeLogger());
    expect(await short.score('list', tools)).toBeUndefined();

    let calls = 0;
    const noQuery = new EmbeddingIndex(
      { embed: jest.fn(async (texts: string[]) => (calls++ === 0 ? texts.map(vector) : [])) },
      makeLogger()
    );
    expect(await noQuery.score('list', tools)).toBeUndefined();
  });

  it('takes the mean of no vectors as an empty vector', () => {
    expect(meanVector([])).toHaveLength(0);
  });
});

