import { afterEach, describe, expect, it, jest } from '@jest/globals';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import type { Logger } from 'pino';
import { PayloadStore } from '../../src/cli/payload-interceptor.js';
import { CliRequests, type CliView, type CliViews } from '../../src/daemon/cli-requests.js';
import { runCallScript } from '../../src/mcp/call-script.js';
import { MetaTools, META_TOOLS } from '../../src/native/meta-tools.js';
import type { ModelBackend } from '../../src/models/types.js';
import type { ProxyServices } from '../../src/proxy/view.js';
import { shapeAndStore } from '../../src/services/shaped-call.js';
import { fakeBackends, tool, type FakeResponder } from '../helpers/fake-backends.js';

interface CompletedShape {
  execution: 'completed';
  source?: { id: string; chars: number };
  shapedPayload?: { id: string };
  originalOutput?: string;
  warning?: string;
  data?: unknown;
  meta: { method: string };
}

const directories: string[] = [];
const stores: PayloadStore[] = [];
function store(): PayloadStore {
  // Only this explicit repository-local test directory is touched.
  const parent = join(process.cwd(), '.model1-test-tmp');
  mkdirSync(parent, { recursive: true });
  const directory = mkdtempSync(join(parent, 'case-'));
  directories.push(directory);
  const payloads = new PayloadStore({ directory: join(directory, 'payloads') });
  stores.push(payloads);
  return payloads;
}
afterEach(() => {
  jest.restoreAllMocks();
  stores.splice(0).forEach((payloads) => payloads.destroy());
  directories.splice(0).forEach((directory) => rmSync(directory, { recursive: true, force: true }));
});
const logger = { debug() {}, info() {}, warn() {}, error() {} } as unknown as Logger;
const badModel = {
  embed: async () => [],
  extract: async () => {
    throw new Error('synthetic model unavailable');
  },
} as unknown as ModelBackend;

function cli(
  options: {
    output?: string;
    respond?: FakeResponder;
    model?: () => ModelBackend | undefined;
    threshold?: number;
  } = {}
) {
  const payloadStore = store();
  const backends = fakeBackends(
    { orders: [tool('create')] },
    {
      respond:
        options.respond ??
        (() => ({
          content: [{ type: 'text', text: options.output ?? 'Created order SYNTHETIC' }],
        })),
    }
  );
  const view = {
    view: { ready: Promise.resolve(), backends },
    usage: { recordSelection() {} },
    threshold: () => options.threshold ?? 10_000,
    model: () => {
      const backend = options.model?.();
      return backend ? { backend } : undefined;
    },
  } as unknown as CliView;
  const handler = new CliRequests({
    views: { get: () => view } as unknown as CliViews,
    services: { logger, payloadStore } as ProxyServices,
    fallbackContext: { cwd: process.cwd(), env: {} },
    status: () => ({}),
  });
  return {
    payloadStore,
    backends,
    call: (params: Record<string, unknown>) =>
      handler.handle({
        id: 'synthetic',
        method: 'call',
        params: { server: 'orders', tool: 'create', ...params },
      }),
  };
}

function native(
  options: {
    output?: string;
    isError?: boolean;
    model?: () => ModelBackend | undefined;
    throws?: boolean;
  } = {}
) {
  const payloadStore = store();
  const executeText = jest.fn(async () => {
    if (options.throws) throw new Error('synthetic backend failed');
    return { output: options.output ?? 'Created order SYNTHETIC', isError: options.isError };
  });
  const deps = {
    executeText,
    payloadStore,
    model: options.model ?? (() => undefined),
    threshold: () => 10_000,
    callBackend: jest.fn(async (): Promise<CallToolResult> => ({
      content: [{ type: 'text', text: 'unshaped' }],
    })),
  } as unknown as ConstructorParameters<typeof MetaTools>[0];
  const meta = new MetaTools(deps);
  return {
    payloadStore,
    executeText,
    call: (params: Record<string, unknown>) =>
      meta.call(META_TOOLS.callTool, { server: 'orders', tool: 'create', ...params }),
  };
}
function nativeShape(result: CallToolResult): CompletedShape {
  const content = result.content.find((item) => item.type === 'text');
  return JSON.parse(content && content.type === 'text' ? content.text : '') as CompletedShape;
}
function cliShape(result: Awaited<ReturnType<CliRequests['handle']>>): CompletedShape {
  expect(result.error).toBeUndefined();
  return (result.result as { shaped: CompletedShape }).shaped;
}

describe('completed shaped calls preserve backend outcomes', () => {
  it.each([{ missing: { id: 'strung' } }, { items: [] }, { id: 17 }, { id: '||' }, null])(
    'rejects every invalid nested shape before any CLI or native backend effect: %j',
    async (want) => {
      const c = cli({ output: '{}' });
      const n = native({ output: '{}' });
      expect((await c.call({ want })).error).toBeDefined();
      expect(c.backends.calls).toHaveLength(0);
      expect((await n.call({ want })).isError).toBe(true);
      expect(n.executeText).not.toHaveBeenCalled();
    }
  );

  it('returns completed plus the full source when model extraction fails in the actual CLI path', async () => {
    const c = cli({ model: () => badModel });
    const shaped = cliShape(await c.call({ want: { id: 'string' } }));
    expect(c.backends.calls).toHaveLength(1);
    expect(shaped.execution).toBe('completed');
    expect(shaped.warning).toContain('synthetic model unavailable');
    expect(c.payloadStore.read(shaped.source!.id, { all: true }).content).toBe(
      'Created order SYNTHETIC'
    );
  });

  it('recovers a model getter failure after the actual backend completed', async () => {
    const c = cli({
      model: () => {
        throw new Error('synthetic model configuration failure');
      },
    });
    const shaped = cliShape(await c.call({ want: { id: 'string' } }));
    expect(c.backends.calls).toHaveLength(1);
    expect(shaped.execution).toBe('completed');
    expect(shaped.warning).toContain('synthetic model configuration failure');
    expect(c.payloadStore.read(shaped.source!.id, { all: true }).content).toBe(
      'Created order SYNTHETIC'
    );
  });

  it('returns the complete original inline if source storage is unavailable', async () => {
    const c = cli({ output: 'Created order SYNTHETIC' });
    jest.spyOn(c.payloadStore, 'capture').mockImplementation(() => {
      throw new Error('synthetic disk full');
    });
    const shaped = cliShape(await c.call({ want: { id: 'string' } }));
    expect(c.backends.calls).toHaveLength(1);
    expect(shaped.execution).toBe('completed');
    expect(shaped.originalOutput).toBe('Created order SYNTHETIC');
    expect(shaped.warning).toContain('synthetic disk full');
    expect(shaped.source).toBeUndefined();
  });

  it('uses the full inline original when a failed write leaves a partial payload', async () => {
    const output = 'Created order SYNTHETIC with complete details';
    const c = cli({ output });
    const capture = c.payloadStore.capture.bind(c.payloadStore);
    let calls = 0;
    jest.spyOn(c.payloadStore, 'capture').mockImplementation((text, threshold) => {
      const captured = capture(text, threshold);
      if (++calls === 1) {
        writeFileSync(captured.reference!.path, 'partial synthetic output');
        throw new Error('synthetic partial write');
      }
      return captured;
    });
    const shaped = cliShape(await c.call({ want: { id: 'string' } }));
    expect(c.backends.calls).toHaveLength(1);
    expect(shaped.execution).toBe('completed');
    expect(shaped.originalOutput).toBe(output);
    expect(shaped.source).toBeUndefined();
  });

  it('recovers the original when storing the shaped answer fails', async () => {
    const output = JSON.stringify({ id: 'SYNTHETIC-' + 'x'.repeat(200), other: true });
    const c = cli({ output, threshold: 20 });
    const capture = c.payloadStore.capture.bind(c.payloadStore);
    let calls = 0;
    jest.spyOn(c.payloadStore, 'capture').mockImplementation((text, threshold) => {
      if (++calls === 2) throw new Error('synthetic shaped storage failed');
      return capture(text, threshold);
    });
    const shaped = cliShape(await c.call({ want: { id: 'string' } }));
    expect(c.backends.calls).toHaveLength(1);
    expect(shaped.execution).toBe('completed');
    expect(shaped.warning).toContain('synthetic shaped storage failed');
    expect(c.payloadStore.read(shaped.source!.id, { all: true }).content).toBe(output);
  });

  it('returns completed/source instead of isError for native post-call model failures', async () => {
    const n = native({ model: () => badModel });
    const result = await n.call({ want: { id: 'string' } });
    expect(result.isError).not.toBe(true);
    const shaped = nativeShape(result);
    expect(n.executeText).toHaveBeenCalledTimes(1);
    expect(shaped.execution).toBe('completed');
    expect(shaped.warning).toContain('synthetic model unavailable');
    expect(n.payloadStore.read(shaped.source!.id, { all: true }).content).toBe(
      'Created order SYNTHETIC'
    );
  });

  it('keeps backend error results and thrown backend failures as errors', async () => {
    const c = cli({
      respond: () => ({ content: [{ type: 'text', text: 'backend denied' }], isError: true }),
    });
    const response = await c.call({ want: { id: 'string' } });
    expect(response.result).toMatchObject({ output: 'backend denied', isError: true });
    expect(response.result).not.toHaveProperty('shaped');
    const thrown = cli({
      respond: () => {
        throw new Error('synthetic backend failed');
      },
    });
    expect((await thrown.call({ want: { id: 'string' } })).error?.message).toContain(
      'synthetic backend failed'
    );
    const n = native({ output: 'backend denied', isError: true });
    expect((await n.call({ want: { id: 'string' } })).isError).toBe(true);
    const nt = native({ throws: true });
    expect((await nt.call({ want: { id: 'string' } })).isError).toBe(true);
  });

  it('preserves JSON-encoded shapes through CLI, native and scripts', async () => {
    const output = '[{"id":"SYNTHETIC","extra":7}]';
    const want = '  [{"id":"string"}]  ';
    const c = cli({ output });
    const n = native({ output });
    expect(cliShape(await c.call({ want })).data).toEqual([{ id: 'SYNTHETIC' }]);
    expect(nativeShape(await n.call({ want })).data).toEqual([{ id: 'SYNTHETIC' }]);
    expect(c.backends.calls).toHaveLength(1);
    expect(n.executeText).toHaveBeenCalledTimes(1);
    const payloads = store();
    const execute = jest.fn(async () => ({ output }));
    const result = await runCallScript(
      [{ id: 'one', server: 'orders', tool: 'read', want }],
      execute,
      payloads,
      10_000,
      (text, spec) => shapeAndStore(text, spec, payloads, 10_000)
    );
    expect(result.steps[0].shaped?.data).toEqual([{ id: 'SYNTHETIC' }]);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(await shapeAndStore(output, { want }, payloads, 10_000)).not.toHaveProperty('execution');
  });

  it.each(['[{"id":"string"}', '{"missing":{"id":"strung"}}'])(
    'rejects malformed or invalid encoded shapes before CLI/native/script effects: %s',
    async (want) => {
      const c = cli({ output: '{}' });
      const n = native({ output: '{}' });
      expect((await c.call({ want })).error).toBeDefined();
      expect(c.backends.calls).toHaveLength(0);
      expect((await n.call({ want })).isError).toBe(true);
      expect(n.executeText).not.toHaveBeenCalled();
      const execute = jest.fn(async () => ({ output: '{}' }));
      await expect(
        runCallScript(
          [
            { id: 'one', server: 'orders', tool: 'create' },
            { id: 'two', server: 'orders', tool: 'create', want },
          ],
          execute,
          store()
        )
      ).rejects.toThrow();
      expect(execute).not.toHaveBeenCalled();
    }
  );

  it('preserves valid projection and source pagination', async () => {
    const output = JSON.stringify({ id: 'SYNTHETIC', other: 7 });
    const c = cli({ output });
    const shaped = cliShape(await c.call({ want: { id: 'string' } }));
    expect(shaped.data).toEqual({ id: 'SYNTHETIC' });
    expect(shaped.warning).toBeUndefined();
    expect(shaped.meta.method).toBe('projection');
    expect(c.payloadStore.read(shaped.source!.id, { offset: 0, length: 5 }).content).toBe(
      output.slice(0, 5)
    );
    const n = native({ output });
    expect(nativeShape(await n.call({ want: { id: 'string' } })).data).toEqual({ id: 'SYNTHETIC' });
  });

  it('preserves large shaped payload handles', async () => {
    const output = JSON.stringify({ id: 'SYNTHETIC-' + 'x'.repeat(200), other: true });
    const c = cli({ output, threshold: 20 });
    const shaped = cliShape(await c.call({ want: { id: 'string' } }));
    expect(shaped.warning).toBeUndefined();
    expect(
      JSON.parse(c.payloadStore.read(shaped.shapedPayload!.id, { all: true }).content)
    ).toEqual({ id: 'SYNTHETIC-' + 'x'.repeat(200) });
    expect(c.payloadStore.read(shaped.source!.id, { all: true }).content).toBe(output);
  });

  it('validates all script shapes before the first backend effect', async () => {
    const payloads = store();
    const execute = jest.fn(async () => ({ output: '{}' }));
    await expect(
      runCallScript(
        [
          { id: 'one', server: 'orders', tool: 'create' },
          { id: 'two', server: 'orders', tool: 'create', want: { id: 'strung' } },
        ],
        execute,
        payloads
      )
    ).rejects.toThrow('Unknown type');
    expect(execute).not.toHaveBeenCalled();
  });

  it('keeps a completed script step and full references when later shaping fails', async () => {
    const payloads = store();
    const execute = jest.fn(
      async (_server: string, _tool: string, _args: Record<string, unknown>) => ({
        output: JSON.stringify({ id: 'SYNTHETIC', other: 7 }),
      })
    );
    const result = await runCallScript(
      [
        { id: 'one', server: 'orders', tool: 'create', want: { id: 'string' } },
        { id: 'two', server: 'orders', tool: 'read', arguments: { id: { $ref: 'one#/id' } } },
      ],
      execute,
      payloads,
      10_000,
      async () => {
        throw new Error('synthetic shaping failed');
      }
    );
    expect(result.stoppedAt).toBeUndefined();
    expect(result.steps).toHaveLength(2);
    expect(result.steps[0].isError).not.toBe(true);
    const shaped = result.steps[0].shaped as unknown as CompletedShape;
    expect(shaped.execution).toBe('completed');
    expect(shaped.warning).toContain('synthetic shaping failed');
    expect(JSON.parse(payloads.read(shaped.source!.id, { all: true }).content).id).toBe(
      'SYNTHETIC'
    );
    expect(execute.mock.calls[1][2]).toEqual({ id: 'SYNTHETIC' });
  });

  it('keeps successful script shaping and backend stop semantics', async () => {
    const payloads = store();
    const execute = jest.fn(async (_server: string, toolName: string) => ({
      output: toolName === 'deny' ? 'backend denied' : '{"id":"SYNTHETIC","extra":7}',
      isError: toolName === 'deny',
    }));
    const result = await runCallScript(
      [
        { id: 'one', server: 'orders', tool: 'create', want: { id: 'string' } },
        { id: 'two', server: 'orders', tool: 'deny', want: { id: 'string' } },
        { id: 'three', server: 'orders', tool: 'never' },
      ],
      execute,
      payloads,
      10_000,
      (output, spec) => shapeAndStore(output, spec, payloads, 10_000)
    );
    expect(result.steps[0].shaped?.data).toEqual({ id: 'SYNTHETIC' });
    expect(result.steps[1]).toMatchObject({ isError: true, output: 'backend denied' });
    expect(result.stoppedAt).toBe('two');
    expect(execute).toHaveBeenCalledTimes(2);
  });
});
