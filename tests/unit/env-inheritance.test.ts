import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { MCPClientManager } from '../../src/mcp/client-manager.js';
import type { MCPServerConfig } from '../../src/types/index.js';
import type { Logger } from 'pino';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';

jest.mock('@modelcontextprotocol/sdk/client/index.js');
jest.mock('@modelcontextprotocol/sdk/client/stdio.js');

/**
 * Environment passed to spawned backend servers (#24).
 *
 * The stdio transport only inherits a small safe list on its own, so anything
 * else the user exported has to be forwarded here or it never reaches the
 * child - which is how a valid token turns into a downstream 401.
 */
describe('backend server environment', () => {
  let clientManager: MCPClientManager;
  let mockClient: jest.Mocked<Client>;
  const savedEnv = { ...process.env };

  /** The env object handed to the transport for the most recent connect. */
  async function envForConfig(
    config: Partial<MCPServerConfig>,
    defaultInheritEnv?: boolean | string[]
  ): Promise<Record<string, string> | undefined> {
    const { StdioClientTransport } = await import(
      '@modelcontextprotocol/sdk/client/stdio.js'
    );
    (StdioClientTransport as unknown as jest.Mock).mockClear();

    await clientManager.initializeServers(
      [{ name: 'srv', command: 'cmd', ...config }],
      undefined,
      defaultInheritEnv
    );

    const call = (StdioClientTransport as unknown as jest.Mock).mock.calls[0];
    return (call?.[0] as { env?: Record<string, string> })?.env;
  }

  beforeEach(async () => {
    jest.clearAllMocks();

    const mockLogger = {
      debug: jest.fn(),
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    } as unknown as Logger;

    mockClient = {
      connect: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
      close: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
    } as unknown as jest.Mocked<Client>;

    const { Client: ClientCtor } = await import(
      '@modelcontextprotocol/sdk/client/index.js'
    );
    (ClientCtor as unknown as jest.Mock).mockImplementation(() => mockClient);

    clientManager = new MCPClientManager(mockLogger);

    process.env.PROXY_TEST_TOKEN = 'from-ambient-env';
    process.env.PROXY_TEST_OTHER = 'also-ambient';
  });

  afterEach(() => {
    process.env = { ...savedEnv };
  });

  it('forwards ambient variables the config never mentions', async () => {
    // The bug in #24: JIRA_BASE_URL was exported but absent from `env`,
    // so the backend started without it.
    const env = await envForConfig({ env: { EXPLICIT: 'value' } });

    expect(env?.PROXY_TEST_TOKEN).toBe('from-ambient-env');
    expect(env?.EXPLICIT).toBe('value');
  });

  it('lets explicit env entries win over inherited ones', async () => {
    const env = await envForConfig({ env: { PROXY_TEST_TOKEN: 'override' } });

    expect(env?.PROXY_TEST_TOKEN).toBe('override');
  });

  it('defers to the transport safe list when inheritEnv is false', async () => {
    const env = await envForConfig({
      env: { EXPLICIT: 'value' },
      inheritEnv: false,
    });

    expect(env?.PROXY_TEST_TOKEN).toBeUndefined();
    expect(env?.EXPLICIT).toBe('value');
  });

  it('forwards only the named variables when inheritEnv is an allowlist', async () => {
    const env = await envForConfig({ inheritEnv: ['PROXY_TEST_TOKEN'] });

    expect(env?.PROXY_TEST_TOKEN).toBe('from-ambient-env');
    expect(env?.PROXY_TEST_OTHER).toBeUndefined();
  });

  it('ignores allowlisted variables that are not set', async () => {
    const env = await envForConfig({ inheritEnv: ['PROXY_TEST_ABSENT'] });

    expect(env).not.toHaveProperty('PROXY_TEST_ABSENT');
  });

  it('applies the top-level default when the server does not override', async () => {
    const env = await envForConfig({}, ['PROXY_TEST_TOKEN']);

    expect(env?.PROXY_TEST_TOKEN).toBe('from-ambient-env');
    expect(env?.PROXY_TEST_OTHER).toBeUndefined();
  });

  it('lets a server override the top-level default', async () => {
    const env = await envForConfig({ inheritEnv: false }, true);

    expect(env?.PROXY_TEST_TOKEN).toBeUndefined();
  });

  it('does not forward exported shell functions', async () => {
    process.env.PROXY_TEST_FN = '() { echo pwned; }';

    const env = await envForConfig({});

    expect(env).not.toHaveProperty('PROXY_TEST_FN');
  });
});
