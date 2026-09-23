import { describe, it, expect, jest, afterEach } from '@jest/globals';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { CreateMessageRequestSchema, type CallToolResult, type Tool } from '@modelcontextprotocol/sdk/types.js';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { Logger } from 'pino';
import type { ConfigResult } from '../../src/config/loader.js';
import { PayloadStore } from '../../src/cli/payload-interceptor.js';
import { ToolCatalog } from '../../src/mcp/tool-catalog.js';
import type { LocalModel } from '../../src/models/local-model.js';
import { ProxySession } from '../../src/proxy/session.js';
import { lastGoodConfig } from '../../src/proxy/view.js';
import { CompressionCache } from '../../src/services/compression-cache.js';
import type { CompressionPersistence } from '../../src/services/compression-persistence.js';
import { fakeBackends, tool, type FakeResponder } from '../helpers/fake-backends.js';

const P = 'mcp-compression-proxy__';

function makeLogger(): Logger {
  return { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() } as unknown as Logger;
}

function textOf(result: unknown): string {
  return ((result as CallToolResult).content ?? [])
    .map((item) => (item.type === 'text' ? item.text : ''))
    .join('\n');
}

const SERVERS: Record<string, Tool[]> = {
  fs: [
    tool('read_file', 'Read the complete contents of one file from disk.'),
    tool('write_file', 'Write a file to disk.', { title: 'Write', annotations: { destructiveHint: true } }),
  ],
  web: [tool('fetch', 'Fetch a URL.')],
};

interface StartOptions {
  servers?: Record<string, Tool[]>;
  config?: Partial<NonNullable<ConfigResult>>;
  exclude?: string[];
  respond?: FakeResponder;
  pageSize?: number;
  sampling?: (prompt: string) => string;
  model?: LocalModel;
  persistence?: Partial<Record<'load' | 'save' | 'clear', () => Promise<unknown>>>;
  /** The client has no configuration at all. */
  noConfig?: boolean;
}

describe('ProxySession', () => {
  const cleanups: Array<() => Promise<void> | void> = [];
  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  });

  async function start(options: StartOptions = {}) {
    const dir = mkdtempSync(join(tmpdir(), 'proxy-session-'));
    const logger = makeLogger();
    const persistence = {
      load: jest.fn(async () => new Map()),
      save: jest.fn(async () => undefined),
      clear: jest.fn(async () => undefined),
      getCacheFilePath: () => join(dir, 'cache.json'),
      ...options.persistence,
    } as unknown as CompressionPersistence;
    const cache = new CompressionCache(logger, persistence);
    const payloads = new PayloadStore({ directory: join(dir, 'payloads') });
    const backends = fakeBackends(options.servers ?? SERVERS, {
      exclude: options.exclude,
      respond: options.respond,
    });
    let config: ConfigResult = options.noConfig
      ? null
      : {
          servers: [],
          excludePatterns: options.exclude ?? [],
          noCompressPatterns: [],
          ...options.config,
        };
    const session = new ProxySession(
      { config: () => config, backends, catalog: new ToolCatalog(backends, logger, 0), cwd: dir },
      {
        logger,
        payloadStore: payloads,
        compressionCache: cache,
        models: { get: () => options.model },
        usageLogFile: join(dir, 'usage.jsonl'),
      },
      { toolsPageSize: options.pageSize }
    );

    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    const client = new Client(
      { name: 'test', version: '1.0.0' },
      { capabilities: options.sampling ? { sampling: {} } : {} }
    );
    if (options.sampling) {
      const reply = options.sampling;
      client.setRequestHandler(CreateMessageRequestSchema, async (request) => ({
        role: 'assistant',
        model: 'test-model',
        content: {
          type: 'text',
          text: reply(JSON.stringify(request.params.messages)),
        },
      }));
    }
    await session.connect(serverSide);
    await client.connect(clientSide);

    cleanups.push(async () => {
      await client.close();
      await session.close();
      payloads.destroy();
      rmSync(dir, { recursive: true, force: true });
    });

    const call = (name: string, args: Record<string, unknown> = {}) =>
      client.callTool({ name, arguments: args }) as Promise<CallToolResult>;
    const setConfig = (next: Partial<NonNullable<ConfigResult>>) => {
      config = { ...(config as NonNullable<ConfigResult>), ...next };
    };
    return { client, session, cache, payloads, backends, dir, persistence, logger, call, setConfig };
  }

  describe('tools/list', () => {
    it('lists management, wrapper and backend tools with compressed descriptions and metadata', async () => {
      const { client, cache } = await start();
      cache.saveCompressed('fs', 'read_file', 'Read one file.', 'Read the complete contents of one file from disk.', {
        parameters: { path: 'File to read' },
      });

      const { tools } = await client.listTools();
      const byName = new Map(tools.map((entry) => [entry.name, entry]));

      expect(byName.get(`${P}get_uncompressed_tools`)?.description).toContain('1/3');
      expect(byName.has(`${P}call_tool`)).toBe(true);
      expect(byName.get('fs__read_file')?.description).toBe('Read one file.');
      expect(
        (byName.get('fs__read_file')?.inputSchema.properties as Record<string, { description: string }>).path
          .description
      ).toBe('File to read');
      expect(byName.get('fs__write_file')).toMatchObject({
        description: 'Write a file to disk.',
        title: 'Write',
        annotations: { destructiveHint: true },
      });
    });

    it("applies this client's noCompress patterns and blank fallback", async () => {
      const { client, cache } = await start({
        config: { noCompressPatterns: ['fs__read_*'], compressionFallbackBehavior: 'blank' },
      });
      cache.saveCompressed('fs', 'read_file', 'Read one file.', 'Read the complete contents of one file from disk.');

      const { tools } = await client.listTools();
      const byName = new Map(tools.map((entry) => [entry.name, entry.description]));
      expect(byName.get('fs__read_file')).toBe('Read the complete contents of one file from disk.');
      expect(byName.get('web__fetch')).toBe('');
    });

    it('hides excluded backend and management tools', async () => {
      const { client } = await start({ exclude: ['fs__write_*', `${P}stats`] });
      const names = (await client.listTools()).tools.map((entry) => entry.name);
      expect(names).not.toContain('fs__write_file');
      expect(names).not.toContain(`${P}stats`);
      expect(names).toContain('fs__read_file');
    });

    it('lists only discovery tools and pinned tools in lazy exposure', async () => {
      const { client } = await start({ config: { toolExposure: 'lazy', pinnedTools: ['web__*'] } });
      const names = (await client.listTools()).tools.map((entry) => entry.name);
      expect(names).toEqual(
        expect.arrayContaining([`${P}search_tools`, `${P}get_tool`, `${P}read_output`, 'web__fetch'])
      );
      expect(names).not.toContain('fs__read_file');
      expect(names).not.toContain(`${P}get_uncompressed_tools`);
    });

    it('pages with cursors and refuses a cursor it did not issue', async () => {
      const { client } = await start({ pageSize: 5 });
      const first = await client.listTools();
      expect(first.tools).toHaveLength(5);
      expect(first.nextCursor).toBe('5');

      const seen = [...first.tools];
      let cursor = first.nextCursor;
      while (cursor) {
        const page = await client.listTools({ cursor });
        seen.push(...page.tools);
        cursor = page.nextCursor;
      }
      expect(new Set(seen.map((entry) => entry.name)).size).toBe(seen.length);
      expect(seen.map((entry) => entry.name)).toContain('web__fetch');

      const invalid = await client.listTools({ cursor: 'nope' });
      expect(invalid.tools).toEqual([]);
      expect(invalid._meta).toEqual({ error: 'Invalid cursor: nope' });
    });
  });

  describe('tool calls', () => {
    it('calls a backend tool and splits its name on the first separator only', async () => {
      const { call, backends } = await start({ servers: { fs: [tool('a__b', 'x')] } });
      expect(textOf(await call('fs__a__b', { path: '/tmp' }))).toBe('ran fs/a__b');
      expect(backends.calls).toEqual([{ server: 'fs', tool: 'a__b', args: { path: '/tmp' } }]);
    });

    it('replaces a large result with a payload reference', async () => {
      const big = 'x'.repeat(200);
      const { call, payloads } = await start({
        config: { cli: { payloadThreshold: 50 } },
        respond: () => ({ content: [{ type: 'text', text: big }] }),
      });
      const result = await call('web__fetch', {});
      const payload = (result.structuredContent as { payload: { id: string } }).payload;
      expect(textOf(result)).toContain('Payload ID');
      expect(payloads.read(payload.id, { all: true }).content).toBe(big);
    });

    it('reports failures, excluded tools and malformed names as tool errors', async () => {
      const { call } = await start({
        exclude: ['fs__write_file'],
        respond: () => {
          throw new Error('backend down');
        },
      });
      const failed = await call('web__fetch');
      expect(failed.isError).toBe(true);
      expect(textOf(failed)).toBe('Error calling tool: backend down');

      expect(textOf(await call('fs__write_file'))).toContain('excluded');
      const malformed = await call('no-separator');
      expect(malformed.isError).toBe(true);
      expect(textOf(malformed)).toContain('Invalid tool name format');
    });

    it('routes the wrapper tools', async () => {
      const { call } = await start();
      const found = JSON.parse(textOf(await call(`${P}search_tools`, { query: 'fetch url' })));
      expect(found.tools[0]).toMatchObject({ server: 'web', tool: 'fetch' });
    });
  });

  describe('expanded-tool sessions', () => {
    it('creates, expands, collapses, switches and deletes sessions', async () => {
      const { client, call, cache } = await start();
      cache.saveCompressed('fs', 'read_file', 'Read one file.', 'Read the complete contents of one file from disk.');

      expect((await call(`${P}expand_tool`, { serverName: 'fs', toolName: 'read_file' })).isError).toBe(true);
      expect((await call(`${P}collapse_tool`, { serverName: 'fs', toolName: 'read_file' })).isError).toBe(true);

      const created = textOf(await call(`${P}create_session`));
      const sessionId = /Session created: (\S+)/.exec(created)?.[1] as string;
      expect(sessionId).toBeDefined();

      expect((await call(`${P}expand_tool`, { serverName: 'web', toolName: 'fetch' })).isError).toBe(true);
      expect(textOf(await call(`${P}expand_tool`, { serverName: 'fs', toolName: 'read_file' }))).toContain(
        'Compressed: Read one file.'
      );
      const listed = (await client.listTools()).tools.find((entry) => entry.name === 'fs__read_file');
      expect(listed?.description).toBe('Read the complete contents of one file from disk.');

      expect(textOf(await call(`${P}collapse_tool`, { serverName: 'fs', toolName: 'read_file' }))).toContain(
        'collapsed'
      );
      expect((await call(`${P}set_session`, { sessionId: 'missing' })).isError).toBe(true);
      expect(textOf(await call(`${P}set_session`, { sessionId }))).toContain(sessionId);
      expect(textOf(await call(`${P}delete_session`, { sessionId }))).toContain('deleted successfully');
      expect(textOf(await call(`${P}delete_session`, { sessionId }))).toContain('not found');
      expect((await call(`${P}expand_tool`, { serverName: 'fs', toolName: 'read_file' })).isError).toBe(true);
    });
  });

  describe('compression workflow', () => {
    it('hands out uncompressed tools as text or in a file relative to the client', async () => {
      const { call, dir } = await start();
      const listed = textOf(await call(`${P}get_uncompressed_tools`, { limit: 1 }));
      expect(listed).toContain('Found 3 tools');
      expect(listed).toContain('Remaining uncached tools: 2');
      expect(listed).toContain('get the next batch');

      const written = textOf(await call(`${P}get_uncompressed_tools`, { outputFile: 'todo.json' }));
      expect(written).toContain(join(dir, 'todo.json'));
      expect(JSON.parse(readFileSync(join(dir, 'todo.json'), 'utf-8'))).toHaveLength(3);

      const failed = await call(`${P}get_uncompressed_tools`, { outputFile: 'missing/dir/todo.json' });
      expect(failed.isError).toBe(true);
    });

    it('caches compressions from arguments or a file, and validates the input', async () => {
      const { call, dir, cache, persistence } = await start();
      const entry = { serverName: 'fs', toolName: 'read_file', description: 'Read one file.' };

      const cached = textOf(await call(`${P}cache_compressed_tools`, { descriptions: [entry] }));
      expect(cached).toContain('Coverage: 0/3 (0%) → 1/3');
      expect(cache.getEntry('fs', 'read_file')?.original).toBe('Read the complete contents of one file from disk.');
      expect(persistence.save).toHaveBeenCalled();

      writeFileSync(
        join(dir, 'done.json'),
        JSON.stringify([
          { serverName: 'fs', toolName: 'write_file', description: 'Write a file.' },
          { serverName: 'web', toolName: 'fetch', description: 'Fetch.' },
        ])
      );
      expect(textOf(await call(`${P}cache_compressed_tools`, { inputFile: 'done.json' }))).toContain(
        'All tools have been compressed'
      );

      writeFileSync(join(dir, 'object.json'), '{}');
      const errors = await Promise.all([
        call(`${P}cache_compressed_tools`, { descriptions: [entry], inputFile: 'done.json' }),
        call(`${P}cache_compressed_tools`, {}),
        call(`${P}cache_compressed_tools`, { inputFile: 'object.json' }),
        call(`${P}cache_compressed_tools`, { inputFile: 'absent.json' }),
        call(`${P}cache_compressed_tools`, { descriptions: Array(101).fill(entry) }),
      ]);
      expect(errors.map((result) => result.isError)).toEqual([true, true, true, true, true]);
    });

    it('keeps going when the cache cannot be saved', async () => {
      const { call } = await start({ persistence: { save: async () => Promise.reject(new Error('disk full')) } });
      const result = await call(`${P}cache_compressed_tools`, {
        descriptions: [{ serverName: 'fs', toolName: 'read_file', description: 'Read.' }],
      });
      expect(result.isError).toBeUndefined();
    });

    it('invalidates one compression, and reports a failed save', async () => {
      const { call, cache } = await start();
      expect(textOf(await call(`${P}invalidate_tool_cache`, { serverName: 'fs', toolName: 'read_file' }))).toContain(
        'Nothing to invalidate'
      );
      cache.saveCompressed('fs', 'read_file', 'Read.', 'x');
      expect(textOf(await call(`${P}invalidate_tool_cache`, { serverName: 'fs', toolName: 'read_file' }))).toContain(
        'offered again'
      );

      const failing = await start({ persistence: { save: async () => Promise.reject(new Error('disk full')) } });
      failing.cache.saveCompressed('fs', 'read_file', 'Read.', 'x');
      const result = await failing.call(`${P}invalidate_tool_cache`, { serverName: 'fs', toolName: 'read_file' });
      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain('disk full');
    });

    it('clears the cache, and reports a failure to', async () => {
      const { call } = await start();
      expect(textOf(await call(`${P}clear_compressed_tools_cache`))).toContain('Successfully cleared');

      const failing = await start({ persistence: { clear: async () => Promise.reject(new Error('locked')) } });
      const result = await failing.call(`${P}clear_compressed_tools_cache`);
      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain('locked');
    });

    it("compresses through the client's own model when it supports sampling", async () => {
      const { call, cache } = await start({
        sampling: () =>
          JSON.stringify([
            { serverName: 'fs', toolName: 'read_file', description: 'Read one file.' },
            { serverName: 'fs', toolName: 'write_file', description: 'Write a file.' },
            { serverName: 'web', toolName: 'fetch', description: 'Fetch a URL.' },
          ]),
      });
      const result = textOf(await call(`${P}compress_via_sampling`, {}));
      expect(result).toContain("using this client's LLM");
      expect(result).toContain('All tools have been compressed');
      expect(cache.getCompressedDescription('fs', 'read_file')).toBe('Read one file.');

      expect(textOf(await call(`${P}compress_via_sampling`, {}))).toContain('Nothing to compress');
    });

    it('reports batches the model could not compress', async () => {
      const { call } = await start({ sampling: () => 'no json here' });
      const result = textOf(await call(`${P}compress_via_sampling`, { limit: 1 }));
      expect(result).toContain('1 of 1 sampling batches produced no usable result');
      expect(result).toContain('Remaining: 3');
    });

    it('explains the alternatives when there is no sampling and no compressor', async () => {
      const { call } = await start();
      const result = await call(`${P}compress_via_sampling`, {});
      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain('no "compressor" endpoint');
    });

    it('uses the configured compressor when the client cannot sample', async () => {
      const fetchMock = jest.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response(JSON.stringify({ choices: [{ message: { content: '[]' } }] }), { status: 200 })
      );
      try {
        const { call } = await start({ config: { compressor: { url: 'http://localhost:1/v1', model: 'tiny' } } });
        const result = textOf(await call(`${P}compress_via_sampling`, {}));
        expect(result).toContain('the configured compressor (tiny)');
        expect(fetchMock).toHaveBeenCalled();
      } finally {
        fetchMock.mockRestore();
      }
    });
  });

  describe('stats, payloads and scripts', () => {
    it('reports stats, and an error for an unknown server', async () => {
      const { call } = await start();
      const stats = JSON.parse(textOf(await call(`${P}stats`, {})));
      expect(stats.summary.toolsTotal).toBe(3);
      const unknown = await call(`${P}stats`, { serverName: 'nope' });
      expect(unknown.isError).toBe(true);
    });

    it('reads and searches saved outputs', async () => {
      const { call, payloads } = await start();
      const saved = payloads.capture('alpha beta gamma'.repeat(10), 10).reference as { id: string };

      const read = JSON.parse(textOf(await call(`${P}read_output`, { id: saved.id, length: 5 })));
      expect(read.content).toBe('alpha');
      const found = JSON.parse(textOf(await call(`${P}find_output`, { id: saved.id, query: 'gamma' })));
      expect(found.matches.length).toBeGreaterThan(0);

      expect((await call(`${P}read_output`, { id: 'missing' })).isError).toBe(true);
      expect((await call(`${P}find_output`, { id: 'missing', query: 'x' })).isError).toBe(true);
    });

    it('runs a script, shaping a step that asks for it', async () => {
      const { call } = await start({
        respond: (_server, name) => ({
          content: [{ type: 'text', text: name === 'fetch' ? '{"items":[{"id":1,"x":2}]}' : 'ok' }],
        }),
      });
      const result = JSON.parse(
        textOf(
          await call(`${P}run_script`, {
            steps: [
              { id: 'a', server: 'web', tool: 'fetch', want: { items: [{ id: 'integer' }] } },
              { id: 'b', server: 'fs', tool: 'read_file', arguments: { path: { $ref: 'a#/items/0/x' } } },
            ],
          })
        )
      );
      expect(JSON.parse(result.steps[0].output)).toEqual({ items: [{ id: 1 }] });
      expect(result.steps[1].output).toBe('ok');

      const invalid = await call(`${P}run_script`, { steps: 'nope' });
      expect(invalid.isError).toBe(true);
    });
  });

  describe('search warm-up', () => {
    type Warm = (tools: unknown[]) => Promise<void>;
    function modelWith(warm: jest.Mock<Warm>) {
      return { backend: {}, config: { provider: 'needle' }, embeddings: { warm } } as unknown as LocalModel;
    }

    it('indexes embeddings ahead of time in lazy exposure only', async () => {
      const warm = jest.fn<Warm>(async () => undefined);
      const lazy = await start({ model: modelWith(warm), config: { toolExposure: 'lazy' } });
      lazy.session.warmSearch();
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(warm).toHaveBeenCalledWith(expect.arrayContaining([expect.objectContaining({ toolName: 'fetch' })]));

      const idle = jest.fn<Warm>(async () => undefined);
      const full = await start({ model: modelWith(idle) });
      full.session.warmSearch();
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(idle).not.toHaveBeenCalled();

      const none = await start({ config: { toolExposure: 'lazy' } });
      expect(() => none.session.warmSearch()).not.toThrow();
    });

    it('logs a failed warm-up instead of throwing', async () => {
      const warm = jest.fn<Warm>(async () => Promise.reject(new Error('bridge down')));
      const { session, logger } = await start({ model: modelWith(warm), config: { toolExposure: 'lazy' } });
      session.warmSearch();
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(logger.warn).toHaveBeenCalledWith({ error: 'Error: bridge down' }, 'Could not index tool embeddings');
    });
  });

  describe('wrapper tools', () => {
    it("serve this session's view: schemas, calls, shaping, saved outputs and the audit", async () => {
      const { call, cache, persistence } = await start({
        respond: (_server, name) => ({
          content: [{ type: 'text', text: name === 'fetch' ? '{"items":[{"id":1,"title":"login"}]}' : 'done' }],
        }),
      });
      cache.saveCompressed('fs', 'read_file', 'Read.', 'Read the complete contents of one file from disk.', {
        parameters: { path: 'File to read' },
      });

      const described = JSON.parse(textOf(await call(`${P}get_tool`, { server: 'fs', tool: 'read_file' })));
      expect(described.inputSchema.properties.path.description).toBe('File to read');

      expect(textOf(await call(`${P}call_tool`, { server: 'fs', tool: 'read_file' }))).toBe('done');
      const shaped = JSON.parse(
        textOf(await call(`${P}call_tool`, { server: 'web', tool: 'fetch', want: { items: [{ id: 'integer' }] } }))
      );
      expect(shaped.data).toEqual({ items: [{ id: 1 }] });

      const reshaped = JSON.parse(textOf(await call(`${P}shape_output`, { id: shaped.source.id, where: 'login' })));
      expect(reshaped.data).toEqual([{ id: 1, title: 'login' }]);

      cache.saveCompressed('web', 'fetch', 'Read the complete contents of one file from disk.', 'Fetch a URL.');
      const audit = JSON.parse(textOf(await call(`${P}audit_compression`, { requeue: true })));
      expect(audit.requeued).toBeGreaterThan(0);
      expect(persistence.save).toHaveBeenCalled();
      expect(cache.hasCompressed('web', 'fetch')).toBe(false);
    });
  });

  describe('edges', () => {
    it('works with no configuration at all', async () => {
      const { client, cache } = await start({ noConfig: true });
      cache.saveCompressed('fs', 'read_file', 'Read.', 'x');
      const listed = (await client.listTools()).tools.find((entry) => entry.name === 'fs__read_file');
      expect(listed?.description).toBe('Read.');
    });

    it('lists no backend tool directly in lazy exposure without pinned tools', async () => {
      const { client } = await start({ config: { toolExposure: 'lazy' } });
      const names = (await client.listTools()).tools.map((entry) => entry.name);
      expect(names.some((name) => !name.startsWith(P))).toBe(false);
    });

    it('accepts a call with no arguments, and offers undescribed tools for compression', async () => {
      const { client, call } = await start({ servers: { bare: [tool('blank')] } });
      const created = await client.callTool({ name: `${P}create_session` });
      expect(textOf(created)).toContain('Session created');
      expect(textOf(await call(`${P}get_uncompressed_tools`))).toContain('"description": ""');
    });

    it('joins only the text parts of a result', async () => {
      const { call } = await start({
        respond: () => ({
          content: [
            { type: 'image', data: 'AAAA', mimeType: 'image/png' },
            { type: 'text', text: '' },
            { type: 'text', text: 'hello' },
          ],
        }),
      });
      const result = JSON.parse(
        textOf(await call(`${P}run_script`, { steps: [{ id: 'a', server: 'web', tool: 'fetch' }] }))
      );
      expect(result.steps[0].output).toBe('hello');
    });

    it('logs a failure to persist sampled compressions', async () => {
      const { call, logger } = await start({
        sampling: () => JSON.stringify([{ serverName: 'web', toolName: 'fetch', description: 'Fetch.' }]),
        persistence: { save: async () => Promise.reject(new Error('disk full')) },
      });
      expect(textOf(await call(`${P}compress_via_sampling`, {}))).toContain('Compressed 1 of 3');
      expect(logger.error).toHaveBeenCalledWith(expect.anything(), 'Failed to persist sampled compressions to disk');
    });

    it('reports something thrown that is not an Error', async () => {
      const { call, payloads } = await start();
      jest.spyOn(payloads, 'read').mockImplementation(() => {
        throw 'payload store offline';
      });
      const result = await call(`${P}read_output`, { id: 'x' });
      expect(result.isError).toBe(true);
      expect(textOf(result)).toBe('payload store offline');
    });

    it('falls back to the default page size, and logs a transport that fails to close', async () => {
      const logger = makeLogger();
      const backends = fakeBackends({ many: Array.from({ length: 120 }, (_unused, index) => tool(`t${index}`, 'x')) });
      const payloads = new PayloadStore();
      const session = new ProxySession(
        {
          config: () => null,
          backends,
          catalog: new ToolCatalog(backends, logger, 0),
          cwd: tmpdir(),
        },
        {
          logger,
          payloadStore: payloads,
          compressionCache: new CompressionCache(logger, {
            load: async () => new Map(),
          } as unknown as CompressionPersistence),
          models: { get: () => undefined },
          usageLogFile: join(tmpdir(), 'unused-usage.jsonl'),
        }
      );
      const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
      const client = new Client({ name: 'test', version: '1.0.0' }, { capabilities: {} });
      await session.connect(serverSide);
      await client.connect(clientSide);
      try {
        const page = await client.listTools();
        expect(page.tools).toHaveLength(100);
        expect(page.nextCursor).toBe('100');
      } finally {
        await client.close();
        jest.spyOn(session.server, 'close').mockRejectedValue(new Error('already closed'));
        await session.close();
        payloads.destroy();
      }
      expect(logger.debug).toHaveBeenCalledWith(expect.anything(), 'Error while closing a session transport');
    });

    it('ignores a page size that is not a positive integer', async () => {
      const { client } = await start({ pageSize: Number.NaN });
      expect((await client.listTools()).nextCursor).toBeUndefined();
    });

    it('survives closing twice', async () => {
      const { session } = await start();
      await session.close();
      await expect(session.close()).resolves.toBeUndefined();
    });
  });
});

describe('lastGoodConfig', () => {
  it('keeps the last configuration that loaded while the file is invalid, logging each new error once', () => {
    const logger = makeLogger();
    const good = { servers: [], excludePatterns: [], noCompressPatterns: [] };
    const results: Array<ConfigResult | Error> = [null, good, new Error('Invalid JSON'), new Error('Invalid JSON'), good];
    const config = lastGoodConfig(() => {
      const next = results.shift() as ConfigResult | Error;
      if (next instanceof Error) throw next;
      return next;
    }, logger);

    expect(config()).toBeNull();
    expect(config()).toBe(good);
    expect(config()).toBe(good);
    expect(config()).toBe(good);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(config()).toBe(good);
  });

  it('reports a thrown non-Error', () => {
    const logger = makeLogger();
    const config = lastGoodConfig(() => {
      throw 'nope';
    }, logger);
    expect(config()).toBeNull();
    expect(logger.warn).toHaveBeenCalledWith({ error: 'nope' }, expect.any(String));
  });
});
