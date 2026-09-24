import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { Logger } from 'pino';
import { PayloadStore } from '../../src/cli/payload-interceptor.js';
import type { BackendAccess } from '../../src/mcp/backend-access.js';
import { ToolCatalog } from '../../src/mcp/tool-catalog.js';
import { callToolWithAuthRecovery, ToolExcludedError } from '../../src/mcp/tool-call-executor.js';
import { ProxySession } from '../../src/proxy/session.js';
import { CompressionCache } from '../../src/services/compression-cache.js';
import type { CompressionPersistence } from '../../src/services/compression-persistence.js';
import { SessionManager } from '../../src/services/session-manager.js';
import { fakeBackends, tool } from '../helpers/fake-backends.js';

const logger = { debug() {}, info() {}, warn() {}, error() {} } as unknown as Logger;
const prefix = 'mcp-compression-proxy__';
const authFailure: CallToolResult = {
  isError: true,
  content: [{ type: 'text', text: 'auth failed' }],
};
const success: CallToolResult = {
  content: [{ type: 'text', text: 'read result' }],
  structuredContent: { value: 42 },
};

describe('call policy at dispatch', () => {
  const cleanups: Array<() => Promise<void> | void> = [];
  afterEach(async () => {
    try {
      for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
    } finally {
      jest.restoreAllMocks();
    }
  });

  async function session(exclude: string[]) {
    const dir = mkdtempSync(join(tmpdir(), 'proxy-call-policy-'));
    const persistence = {
      load: jest.fn(async () => new Map()),
      save: jest.fn(async () => undefined),
      clear: jest.fn(async () => undefined),
      getCacheFilePath: () => join(dir, 'cache.json'),
    };
    const cache = new CompressionCache(logger, persistence as unknown as CompressionPersistence);
    cache.saveCompressed('fixture', 'read', 'short', 'Read a fixture.');
    const payloads = new PayloadStore({ directory: join(dir, 'payloads') });
    const backends = fakeBackends(
      { fixture: [tool('read', 'Read a fixture.')] },
      {
        exclude,
        respond: () => success,
      }
    );
    const getModel = jest.fn(() => undefined);
    const proxy = new ProxySession(
      {
        config: () => ({ servers: [], excludePatterns: exclude, noCompressPatterns: [] }),
        backends,
        catalog: new ToolCatalog(backends, logger, 0),
        cwd: dir,
      },
      {
        logger,
        payloadStore: payloads,
        compressionCache: cache,
        models: { get: getModel },
        usageLogFile: join(dir, 'usage.jsonl'),
      }
    );
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'policy-fixture', version: '1.0.0' }, { capabilities: {} });
    cleanups.push(async () => {
      await client.close();
      await proxy.close();
      payloads.destroy();
      rmSync(dir, { recursive: true, force: true });
    });
    await proxy.connect(serverSide);
    await client.connect(clientSide);
    const call = (name: string, args: Record<string, unknown> = {}) =>
      client.callTool({ name, arguments: args }) as Promise<CallToolResult>;
    return { client, call, cache, persistence, backends, getModel };
  }

  it.each([
    ['call_tool', { server: 'fixture', tool: 'read' }],
    ['suggest_tool', { request: 'read a fixture', run: true }],
    ['create_session', {}],
    ['clear_compressed_tools_cache', {}],
  ] as Array<[string, Record<string, unknown>]>)(
    'refuses excluded %s without backend, model or state effects',
    async (toolName, args) => {
      const name = `${prefix}${toolName}`;
      const createSession = jest.spyOn(SessionManager.prototype, 'createSession');
      const fixture = await session([name]);
      expect((await fixture.client.listTools()).tools.map((t) => t.name)).not.toContain(name);
      const result = await fixture.call(name, args);
      expect(result.isError).toBe(true);
      expect(result.content).toEqual([{ type: 'text', text: expect.stringContaining('excluded') }]);
      expect(fixture.backends.calls).toEqual([]);
      expect(fixture.getModel).not.toHaveBeenCalled();
      expect(createSession).not.toHaveBeenCalled();
      expect(fixture.persistence.save).not.toHaveBeenCalled();
      expect(fixture.persistence.clear).not.toHaveBeenCalled();
      expect(fixture.cache.getCompressedDescription('fixture', 'read')).toBe('short');
    }
  );

  it('keeps backend target exclusions effective through direct and wrapper calls', async () => {
    const fixture = await session(['fixture__read']);
    for (const result of [
      await fixture.call('fixture__read'),
      await fixture.call(`${prefix}call_tool`, { server: 'fixture', tool: 'read' }),
    ]) {
      expect(result.isError).toBe(true);
      expect(result.content).toEqual([{ type: 'text', text: expect.stringContaining('excluded') }]);
    }
    expect(fixture.backends.calls).toEqual([]);
  });

  it('preserves allowed direct and wrapper results, including structured content', async () => {
    const fixture = await session([]);
    expect(await fixture.call('fixture__read', { path: 'direct' })).toEqual(success);
    expect(
      await fixture.call(`${prefix}call_tool`, {
        server: 'fixture',
        tool: 'read',
        arguments: { path: 'wrapped' },
      })
    ).toEqual(success);
    expect(fixture.backends.calls.map((c) => c.args.path)).toEqual(['direct', 'wrapped']);
  });

  function executor(retrySafe = true) {
    let excluded = false;
    let retryAllowed = retrySafe;
    const callTool = jest.fn<() => Promise<CallToolResult>>().mockResolvedValue(success);
    const invalidate = jest.fn();
    const markFailure = jest.fn();
    let acquire: () => Promise<void> = async () => undefined;
    const access: BackendAccess = {
      getConfiguredServerNames: () => ['fixture'],
      getExcludePatterns: () => (excluded ? ['fixture__read'] : []),
      isToolExcluded: () => excluded,
      getAuthRecoveryPolicy: () => ({
        authErrorPatterns: ['auth failed'],
        authRetryTools: retryAllowed ? ['read'] : [],
      }),
      getAuthFailureConfirmer: () => undefined,
      getServerStatuses: () => [],
      async withClient(_server, operation) {
        await acquire();
        return operation({
          client: { callTool } as unknown as Client,
          generation: 1,
          invalidate,
          markFailure,
        });
      },
    };
    return {
      access,
      callTool,
      invalidate,
      markFailure,
      exclude: () => {
        excluded = true;
      },
      revokeRetry: () => {
        retryAllowed = false;
      },
      onAcquire: (fn: () => Promise<void>) => {
        acquire = fn;
      },
    };
  }

  it('refuses a tool excluded while its client acquisition is pending', async () => {
    const fixture = executor();
    let release: () => void = () => undefined;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    fixture.onAcquire(() => pending);
    const call = callToolWithAuthRecovery(fixture.access, logger, 'fixture', 'read', {});
    fixture.exclude();
    release();
    await expect(call).rejects.toBeInstanceOf(ToolExcludedError);
    expect(fixture.callTool).not.toHaveBeenCalled();
    expect(fixture.invalidate).not.toHaveBeenCalled();
    expect(fixture.markFailure).not.toHaveBeenCalled();
  });

  it('refuses replay when exclusion activates after the auth-failed response', async () => {
    const fixture = executor();
    fixture.callTool.mockImplementationOnce(async () => {
      fixture.exclude();
      return authFailure;
    });
    await expect(
      callToolWithAuthRecovery(fixture.access, logger, 'fixture', 'read', {})
    ).rejects.toBeInstanceOf(ToolExcludedError);
    expect(fixture.callTool).toHaveBeenCalledTimes(1);
    expect(fixture.invalidate).toHaveBeenCalledTimes(1);
    expect(fixture.markFailure).not.toHaveBeenCalled();
  });

  it('still retries an allowed auth failure once and returns the recovered result', async () => {
    const fixture = executor();
    fixture.callTool.mockResolvedValueOnce(authFailure);
    expect(await callToolWithAuthRecovery(fixture.access, logger, 'fixture', 'read', {})).toEqual(
      success
    );
    expect(fixture.callTool).toHaveBeenCalledTimes(2);
    expect(fixture.invalidate).toHaveBeenCalledTimes(1);
  });

  it.each(['result', 'error'])(
    'preserves the original auth %s when replay permission is removed during the first call',
    async (kind) => {
      const fixture = executor();
      const originalError = new Error('auth failed: first call');
      let started: () => void = () => undefined;
      let release: () => void = () => undefined;
      const inFlight = new Promise<void>((resolve) => {
        started = resolve;
      });
      const pending = new Promise<void>((resolve) => {
        release = resolve;
      });
      fixture.callTool.mockImplementationOnce(async () => {
        started();
        await pending;
        if (kind === 'error') throw originalError;
        return authFailure;
      });
      const call = callToolWithAuthRecovery(fixture.access, logger, 'fixture', 'read', {}).then(
        (value) => ({ value }),
        (error) => ({ error })
      );
      await inFlight;
      fixture.revokeRetry();
      release();
      expect(await call).toEqual(
        kind === 'error' ? { error: originalError } : { value: authFailure }
      );
      expect(fixture.callTool).toHaveBeenCalledTimes(1);
      expect(fixture.invalidate).toHaveBeenCalledTimes(1);
    }
  );

  it.each(['result', 'error'])(
    'preserves the original auth %s when replay permission is removed during retry acquisition',
    async (kind) => {
      const fixture = executor();
      const originalError = new Error('auth failed: first call');
      let acquiringRetry: () => void = () => undefined;
      let release: () => void = () => undefined;
      const acquired = new Promise<void>((resolve) => {
        acquiringRetry = resolve;
      });
      const pending = new Promise<void>((resolve) => {
        release = resolve;
      });
      fixture.callTool.mockImplementationOnce(async () => {
        if (kind === 'error') throw originalError;
        return authFailure;
      });
      fixture.onAcquire(async () => {
        if (fixture.callTool.mock.calls.length === 1) {
          acquiringRetry();
          await pending;
        }
      });
      const call = callToolWithAuthRecovery(fixture.access, logger, 'fixture', 'read', {}).then(
        (value) => ({ value }),
        (error) => ({ error })
      );
      await acquired;
      fixture.revokeRetry();
      release();
      expect(await call).toEqual(
        kind === 'error' ? { error: originalError } : { value: authFailure }
      );
      expect(fixture.callTool).toHaveBeenCalledTimes(1);
      expect(fixture.invalidate).toHaveBeenCalledTimes(1);
    }
  );

  it('never retries an allowed tool more than once', async () => {
    const fixture = executor();
    fixture.callTool.mockResolvedValue(authFailure);
    expect(await callToolWithAuthRecovery(fixture.access, logger, 'fixture', 'read', {})).toEqual(
      authFailure
    );
    expect(fixture.callTool).toHaveBeenCalledTimes(2);
    expect(fixture.invalidate).toHaveBeenCalledTimes(2);
  });

  it('does not replay a tool outside the explicit retry allowlist', async () => {
    const fixture = executor(false);
    fixture.callTool.mockResolvedValue(authFailure);
    expect(await callToolWithAuthRecovery(fixture.access, logger, 'fixture', 'read', {})).toEqual(
      authFailure
    );
    expect(fixture.callTool).toHaveBeenCalledTimes(1);
    expect(fixture.invalidate).toHaveBeenCalledTimes(1);
  });
});
