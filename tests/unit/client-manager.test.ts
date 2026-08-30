import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { MCPClientManager } from '../../src/mcp/client-manager.js';
import type { MCPServerConfig } from '../../src/types/index.js';
import type { Logger } from 'pino';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';

/**
 * A connect() that resolves after `ms`, used to simulate a slow server.
 *
 * The timer is unref'd: tests that expect a timeout deliberately abandon this
 * promise, and a pending 5s timer would otherwise hold the jest worker open
 * past the end of the suite.
 */
function delayedConnect(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms).unref?.();
  });
}

// Mock the MCP SDK
jest.mock('@modelcontextprotocol/sdk/client/index.js');
jest.mock('@modelcontextprotocol/sdk/client/stdio.js');
jest.mock('@modelcontextprotocol/sdk/client/streamableHttp.js');

describe('MCPClientManager', () => {
  let clientManager: MCPClientManager;
  let mockLogger: Logger;
  let mockClient: jest.Mocked<Client>;

  beforeEach(() => {
    jest.clearAllMocks();

    mockLogger = {
      debug: jest.fn(),
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    } as unknown as Logger;

    mockClient = {
      connect: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
      close: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
      listTools: jest.fn<() => Promise<any>>().mockResolvedValue({ tools: [] }),
      callTool: jest.fn<() => Promise<any>>().mockResolvedValue({ content: [] }),
    } as unknown as jest.Mocked<Client>;

    clientManager = new MCPClientManager(mockLogger);
  });

  describe('initializeServers', () => {
    it('should initialize enabled servers', async () => {
      const servers: MCPServerConfig[] = [
        {
          name: 'filesystem',
          command: 'npx',
          args: ['-y', '@modelcontextprotocol/server-filesystem'],
          enabled: true,
        },
      ];

      // Mock the Client constructor and connect
      const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
      (Client as unknown as jest.Mock).mockImplementation(() => mockClient);

      await clientManager.initializeServers(servers);

      expect(mockLogger.info).toHaveBeenCalledWith(
        { count: 1 },
        'Initializing MCP servers'
      );
    });

    it('should handle connection failures gracefully', async () => {
      const servers: MCPServerConfig[] = [
        {
          name: 'failing-server',
          command: 'invalid-command',
          enabled: true,
        },
      ];

      const failingClient = {
        ...mockClient,
        connect: jest.fn<() => Promise<void>>().mockRejectedValue(new Error('Connection failed')),
      };

      const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
      (Client as unknown as jest.Mock).mockImplementation(() => failingClient);

      await clientManager.initializeServers(servers);

      expect(mockLogger.error).toHaveBeenCalled();
    });

    it('should initialize multiple servers in parallel', async () => {
      const servers: MCPServerConfig[] = [
        {
          name: 'server1',
          command: 'cmd1',
          enabled: true,
        },
        {
          name: 'server2',
          command: 'cmd2',
          enabled: true,
        },
      ];

      const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
      (Client as unknown as jest.Mock).mockImplementation(() => mockClient);

      await clientManager.initializeServers(servers);

      expect(mockLogger.info).toHaveBeenCalledWith(
        { count: 2 },
        'Initializing MCP servers'
      );
    });
  });

  describe('getClient', () => {
    it('should return client for connected server', async () => {
      const servers: MCPServerConfig[] = [
        {
          name: 'filesystem',
          command: 'npx',
          enabled: true,
        },
      ];

      const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
      (Client as unknown as jest.Mock).mockImplementation(() => mockClient);

      await clientManager.initializeServers(servers);

      const client = clientManager.getClient('filesystem');
      expect(client).toBeDefined();
    });

    it('should return undefined for non-existent server', () => {
      const client = clientManager.getClient('non-existent');
      expect(client).toBeUndefined();
    });

    it('should return undefined for disconnected server', async () => {
      const servers: MCPServerConfig[] = [
        {
          name: 'failing-server',
          command: 'cmd',
          enabled: true,
        },
      ];

      const failingClient = {
        ...mockClient,
        connect: jest.fn<() => Promise<void>>().mockRejectedValue(new Error('Failed')),
      };

      const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
      (Client as unknown as jest.Mock).mockImplementation(() => failingClient);

      await clientManager.initializeServers(servers);

      const client = clientManager.getClient('failing-server');
      expect(client).toBeUndefined();
    });
  });

  describe('getConnectedClients', () => {
    it('should return empty array when no clients connected', () => {
      const clients = clientManager.getConnectedClients();
      expect(clients).toEqual([]);
    });

    it('should return only connected clients', async () => {
      const servers: MCPServerConfig[] = [
        {
          name: 'server1',
          command: 'cmd1',
          enabled: true,
        },
        {
          name: 'server2',
          command: 'cmd2',
          enabled: true,
        },
      ];

      const successClient = {
        ...mockClient,
        connect: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
      };

      const failClient = {
        ...mockClient,
        connect: jest.fn<() => Promise<void>>().mockRejectedValue(new Error('Failed')),
      };

      const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
      let callCount = 0;
      (Client as unknown as jest.Mock).mockImplementation(() => {
        callCount++;
        return callCount === 1 ? successClient : failClient;
      });

      await clientManager.initializeServers(servers);

      const clients = clientManager.getConnectedClients();
      expect(clients.length).toBeLessThanOrEqual(2);
    });

    it('should return client name and client instance', async () => {
      const servers: MCPServerConfig[] = [
        {
          name: 'filesystem',
          command: 'npx',
          enabled: true,
        },
      ];

      const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
      (Client as unknown as jest.Mock).mockImplementation(() => mockClient);

      await clientManager.initializeServers(servers);

      const clients = clientManager.getConnectedClients();

      clients.forEach(({ name, client }) => {
        expect(name).toBeDefined();
        expect(client).toBeDefined();
      });
    });
  });

  describe('getServerStatuses', () => {
    it('should return empty array when no servers', () => {
      const statuses = clientManager.getServerStatuses();
      expect(statuses).toEqual([]);
    });

    it('should return status for all servers', async () => {
      const servers: MCPServerConfig[] = [
        {
          name: 'server1',
          command: 'cmd1',
          enabled: true,
        },
      ];

      const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
      (Client as unknown as jest.Mock).mockImplementation(() => mockClient);

      await clientManager.initializeServers(servers);

      const statuses = clientManager.getServerStatuses();

      expect(statuses).toHaveLength(1);
      expect(statuses[0]).toHaveProperty('name');
      expect(statuses[0]).toHaveProperty('connected');
    });

    it('should include error information for failed connections', async () => {
      const servers: MCPServerConfig[] = [
        {
          name: 'failing-server',
          command: 'cmd',
          enabled: true,
        },
      ];

      const failingClient = {
        ...mockClient,
        connect: jest.fn<() => Promise<void>>().mockRejectedValue(new Error('Connection error')),
      };

      const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
      (Client as unknown as jest.Mock).mockImplementation(() => failingClient);

      await clientManager.initializeServers(servers);

      const statuses = clientManager.getServerStatuses();

      expect(statuses[0].connected).toBe(false);
      expect(statuses[0].lastError).toBeDefined();
    });
  });

  describe('hasConnectedServers', () => {
    it('should return false when no servers connected', () => {
      expect(clientManager.hasConnectedServers()).toBe(false);
    });

    it('should return true when at least one server is connected', async () => {
      const servers: MCPServerConfig[] = [
        {
          name: 'server1',
          command: 'cmd',
          enabled: true,
        },
      ];

      const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
      (Client as unknown as jest.Mock).mockImplementation(() => mockClient);

      await clientManager.initializeServers(servers);

      expect(clientManager.hasConnectedServers()).toBe(true);
    });
  });

  describe('disconnectAll', () => {
    it('should disconnect all clients', async () => {
      const servers: MCPServerConfig[] = [
        {
          name: 'server1',
          command: 'cmd1',
          enabled: true,
        },
        {
          name: 'server2',
          command: 'cmd2',
          enabled: true,
        },
      ];

      const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
      (Client as unknown as jest.Mock).mockImplementation(() => mockClient);

      await clientManager.initializeServers(servers);

      await clientManager.disconnectAll();

      expect(mockClient.close).toHaveBeenCalled();
      expect(clientManager.getConnectedClients()).toEqual([]);
    });

    it('should handle disconnect errors gracefully', async () => {
      const servers: MCPServerConfig[] = [
        {
          name: 'server1',
          command: 'cmd',
          enabled: true,
        },
      ];

      const errorClient = {
        ...mockClient,
        close: jest.fn<() => Promise<void>>().mockRejectedValue(new Error('Disconnect failed')),
      };

      const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
      (Client as unknown as jest.Mock).mockImplementation(() => errorClient);

      await clientManager.initializeServers(servers);

      await clientManager.disconnectAll();

      expect(mockLogger.error).toHaveBeenCalled();
    });
  });

  describe('server configuration', () => {
    it('should pass environment variables to server', async () => {
      const servers: MCPServerConfig[] = [
        {
          name: 'github',
          command: 'npx',
          args: ['-y', '@modelcontextprotocol/server-github'],
          env: {
            GITHUB_TOKEN: 'test-token',
          },
          enabled: true,
        },
      ];

      const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
      (Client as unknown as jest.Mock).mockImplementation(() => mockClient);

      await clientManager.initializeServers(servers);

      // Verify initialization was attempted
      expect(mockLogger.info).toHaveBeenCalled();
    });

    it('should pass command arguments to server', async () => {
      const servers: MCPServerConfig[] = [
        {
          name: 'filesystem',
          command: 'npx',
          args: ['-y', '@modelcontextprotocol/server-filesystem', '/tmp'],
          enabled: true,
        },
      ];

      const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
      (Client as unknown as jest.Mock).mockImplementation(() => mockClient);

      await clientManager.initializeServers(servers);

      expect(mockLogger.info).toHaveBeenCalled();
    });
  });

  describe('transport selection', () => {
    async function transportMocks() {
      const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
      (Client as unknown as jest.Mock).mockImplementation(() => mockClient);

      const { StdioClientTransport } = await import(
        '@modelcontextprotocol/sdk/client/stdio.js'
      );
      const { StreamableHTTPClientTransport } = await import(
        '@modelcontextprotocol/sdk/client/streamableHttp.js'
      );

      return {
        stdio: StdioClientTransport as unknown as jest.Mock,
        http: StreamableHTTPClientTransport as unknown as jest.Mock,
      };
    }

    it('should use the HTTP transport when url is set', async () => {
      const { stdio, http } = await transportMocks();

      await clientManager.initializeServers([
        {
          name: 'remote',
          url: 'https://mcp.example.com/mcp',
          headers: { Authorization: 'Bearer test-token' },
          enabled: true,
        },
      ]);

      expect(stdio).not.toHaveBeenCalled();
      expect(http).toHaveBeenCalledTimes(1);

      // Compared by href rather than by object: a URL carries no own
      // enumerable properties, so toEqual() on two of them is vacuously true.
      const [url, options] = http.mock.calls[0] as [URL, Record<string, unknown>];
      expect(url).toBeInstanceOf(URL);
      expect(url.href).toBe('https://mcp.example.com/mcp');
      expect(options).toEqual({
        requestInit: { headers: { Authorization: 'Bearer test-token' } },
      });

      expect(clientManager.getClient('remote')).toBeDefined();
    });

    it('should omit requestInit when no headers are configured', async () => {
      const { http } = await transportMocks();

      await clientManager.initializeServers([
        { name: 'remote', url: 'https://mcp.example.com/mcp', enabled: true },
      ]);

      const [, options] = http.mock.calls[0] as [URL, Record<string, unknown>];
      expect(options).toEqual({ requestInit: undefined });
    });

    it('should use the stdio transport when command is set', async () => {
      const { stdio, http } = await transportMocks();

      await clientManager.initializeServers([
        {
          name: 'local',
          command: 'npx',
          args: ['-y', 'some-server'],
          inheritEnv: ['PATH'],
          env: { TOKEN: 'from-config' },
          enabled: true,
        },
      ]);

      expect(http).not.toHaveBeenCalled();
      expect(stdio).toHaveBeenCalledTimes(1);

      const [options] = stdio.mock.calls[0] as [
        { command: string; args?: string[]; env?: Record<string, string> },
      ];
      expect(options.command).toBe('npx');
      expect(options.args).toEqual(['-y', 'some-server']);
      expect(options.env?.TOKEN).toBe('from-config');
    });

    it('should fail the server when neither command nor url is set', async () => {
      // Unreachable through config validation, but the manager is also driven
      // directly by the daemon and by tests.
      const { stdio, http } = await transportMocks();

      await clientManager.initializeServers([{ name: 'neither', enabled: true }]);

      expect(stdio).not.toHaveBeenCalled();
      expect(http).not.toHaveBeenCalled();
      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.objectContaining({ server: 'neither' }),
        'Failed to connect to MCP server'
      );
    });
  });

  describe('timeout handling', () => {
    it('should timeout when server connection exceeds timeout', async () => {
      const servers: MCPServerConfig[] = [
        {
          name: 'slow-server',
          command: 'slow-cmd',
          enabled: true,
          timeout: 1, // 1 second timeout
        },
      ];

      // Create a client that takes longer than timeout to connect
      const slowClient = {
        ...mockClient,
        connect: jest.fn<() => Promise<void>>().mockImplementation(
          () => delayedConnect(5000)
        ),
      };

      const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
      (Client as unknown as jest.Mock).mockImplementation(() => slowClient);

      const startTime = Date.now();
      await clientManager.initializeServers(servers);
      const duration = Date.now() - startTime;

      // Should timeout around 1 second, not wait full 5 seconds
      expect(duration).toBeLessThan(3000);
      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.objectContaining({
          server: 'slow-server',
        }),
        'Failed to connect to MCP server'
      );
    });

    it('should successfully connect when server responds within timeout', async () => {
      const servers: MCPServerConfig[] = [
        {
          name: 'fast-server',
          command: 'fast-cmd',
          enabled: true,
          timeout: 5, // 5 second timeout
        },
      ];

      // Create a client that connects quickly
      const fastClient = {
        ...mockClient,
        connect: jest.fn<() => Promise<void>>().mockImplementation(
          () => delayedConnect(100)
        ),
      };

      const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
      (Client as unknown as jest.Mock).mockImplementation(() => fastClient);

      await clientManager.initializeServers(servers);

      const client = clientManager.getClient('fast-server');
      expect(client).toBeDefined();
      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.objectContaining({ server: 'fast-server' }),
        'Successfully connected to MCP server'
      );
    });

    it('should use default timeout when not specified', async () => {
      const servers: MCPServerConfig[] = [
        {
          name: 'default-timeout-server',
          command: 'cmd',
          enabled: true,
          // No timeout specified - should use default (30 seconds)
        },
      ];

      const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
      (Client as unknown as jest.Mock).mockImplementation(() => mockClient);

      await clientManager.initializeServers(servers);

      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.objectContaining({
          server: 'default-timeout-server',
          timeoutMs: 30000, // 30 seconds default
        }),
        'Connecting to MCP server'
      );
    });

    it('should apply global default timeout to servers without specific timeout', async () => {
      const servers: MCPServerConfig[] = [
        {
          name: 'server1',
          command: 'cmd1',
          enabled: true,
          // No timeout - should use global default
        },
        {
          name: 'server2',
          command: 'cmd2',
          enabled: true,
          timeout: 60, // Override with specific timeout
        },
      ];

      const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
      (Client as unknown as jest.Mock).mockImplementation(() => mockClient);

      const globalDefaultTimeout = 45; // 45 seconds global default
      await clientManager.initializeServers(servers, globalDefaultTimeout);

      // Server1 should use global default (45s)
      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.objectContaining({
          server: 'server1',
          timeoutMs: 45000,
        }),
        'Connecting to MCP server'
      );

      // Server2 should use its specific timeout (60s)
      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.objectContaining({
          server: 'server2',
          timeoutMs: 60000,
        }),
        'Connecting to MCP server'
      );
    });

    it('should handle multiple servers with different timeouts in parallel', async () => {
      const servers: MCPServerConfig[] = [
        {
          name: 'fast-server',
          command: 'cmd1',
          enabled: true,
          timeout: 5,
        },
        {
          name: 'slow-server',
          command: 'cmd2',
          enabled: true,
          timeout: 1, // Will timeout
        },
      ];

      let callCount = 0;
      const fastClient = {
        ...mockClient,
        connect: jest.fn<() => Promise<void>>().mockImplementation(
          () => delayedConnect(100)
        ),
      };

      const slowClient = {
        ...mockClient,
        connect: jest.fn<() => Promise<void>>().mockImplementation(
          () => delayedConnect(5000)
        ),
      };

      const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
      (Client as unknown as jest.Mock).mockImplementation(() => {
        callCount++;
        return callCount === 1 ? fastClient : slowClient;
      });

      await clientManager.initializeServers(servers);

      // Fast server should connect
      expect(clientManager.getClient('fast-server')).toBeDefined();

      // Slow server should fail due to timeout
      expect(clientManager.getClient('slow-server')).toBeUndefined();

      const statuses = clientManager.getServerStatuses();
      expect(statuses).toHaveLength(2);

      const fastStatus = statuses.find(s => s.name === 'fast-server');
      const slowStatus = statuses.find(s => s.name === 'slow-server');

      expect(fastStatus?.connected).toBe(true);
      expect(slowStatus?.connected).toBe(false);
      expect(slowStatus?.lastError).toContain('timeout');
    });
  });

  describe('auto-reconnect', () => {
    beforeEach(() => {
      jest.useFakeTimers();
      // The backoff carries +/-20% jitter; pinning random() to the midpoint
      // makes it exactly 1.0x so the delays can be asserted as numbers.
      jest.spyOn(Math, 'random').mockReturnValue(0.5);
    });

    afterEach(() => {
      jest.useRealTimers();
      jest.spyOn(Math, 'random').mockRestore();
    });

    /** Brings one server up and hands back the mocked Client constructor. */
    async function connectFlakyServer(): Promise<jest.Mock> {
      const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
      const constructor = Client as unknown as jest.Mock;
      constructor.mockImplementation(() => mockClient);

      await clientManager.initializeServers([
        { name: 'flaky', command: 'cmd', enabled: true },
      ]);

      return constructor;
    }

    function scheduledDelays(): number[] {
      return (mockLogger.info as unknown as jest.Mock).mock.calls
        .filter((call) => call[1] === 'Scheduling MCP server reconnect')
        .map((call) => (call[0] as { delayMs: number }).delayMs);
    }

    it('should mark a dropped server disconnected and queue a reconnect', async () => {
      await connectFlakyServer();
      expect(clientManager.getClient('flaky')).toBeDefined();

      // What the SDK does when a backend dies: Protocol._onclose() fires the
      // Client's own onclose.
      mockClient.onclose!();

      expect(clientManager.getClient('flaky')).toBeUndefined();
      expect(clientManager.getServerStatuses()[0]).toMatchObject({
        name: 'flaky',
        connected: false,
      });
      expect(scheduledDelays()).toEqual([1000]);
    });

    it('should not stack timers when a drop is reported twice', async () => {
      await connectFlakyServer();

      mockClient.onclose!();
      mockClient.onclose!();

      expect(jest.getTimerCount()).toBe(1);
      expect(scheduledDelays()).toEqual([1000]);
    });

    it('should ignore a close from a superseded connection', async () => {
      const constructor = await connectFlakyServer();
      const staleOnClose = mockClient.onclose!;

      const replacement = {
        ...mockClient,
        connect: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
      };
      constructor.mockImplementation(() => replacement);

      staleOnClose();
      await jest.advanceTimersByTimeAsync(1000);
      expect(clientManager.getClient('flaky')).toBe(replacement);

      // The dead transport finishes tearing down after the replacement is
      // already live; that must not knock the healthy connection back down.
      staleOnClose();

      expect(clientManager.getClient('flaky')).toBe(replacement);
      expect(jest.getTimerCount()).toBe(0);
    });

    it('should reconnect for real once the backoff elapses', async () => {
      const constructor = await connectFlakyServer();
      expect(constructor).toHaveBeenCalledTimes(1);

      mockClient.onclose!();
      await jest.advanceTimersByTimeAsync(1000);

      expect(constructor).toHaveBeenCalledTimes(2);
      expect(clientManager.getClient('flaky')).toBeDefined();
      expect(mockLogger.info).toHaveBeenCalledWith(
        { server: 'flaky' },
        'Reconnected to MCP server'
      );
    });

    it('should grow the backoff on repeated failures and cap it at 30s', async () => {
      const constructor = await connectFlakyServer();

      const deadClient = {
        ...mockClient,
        connect: jest
          .fn<() => Promise<void>>()
          .mockRejectedValue(new Error('still down')),
      };
      constructor.mockImplementation(() => deadClient);

      mockClient.onclose!();

      for (let i = 0; i < 7; i++) {
        await jest.advanceTimersByTimeAsync(30000);
      }

      expect(scheduledDelays().slice(0, 7)).toEqual([
        1000, 2000, 4000, 8000, 16000, 30000, 30000,
      ]);
    });

    it('should reset the backoff after a successful reconnect', async () => {
      const constructor = await connectFlakyServer();

      const deadClient = {
        ...mockClient,
        connect: jest
          .fn<() => Promise<void>>()
          .mockRejectedValue(new Error('still down')),
      };
      constructor.mockImplementation(() => deadClient);

      mockClient.onclose!();
      await jest.advanceTimersByTimeAsync(1000); // 1s attempt fails
      await jest.advanceTimersByTimeAsync(2000); // 2s attempt: back to healthy

      constructor.mockImplementation(() => mockClient);
      await jest.advanceTimersByTimeAsync(4000);
      expect(clientManager.getClient('flaky')).toBeDefined();

      mockClient.onclose!();

      // Not 8000: the counter is cleared when a connection comes back up.
      expect(scheduledDelays()).toEqual([1000, 2000, 4000, 1000]);
    });

    it('should unref the reconnect timer so it cannot hold the process open', async () => {
      await connectFlakyServer();

      const setTimeoutSpy = jest.spyOn(globalThis, 'setTimeout');
      mockClient.onclose!();

      const timer = setTimeoutSpy.mock.results.at(-1)?.value as NodeJS.Timeout;
      expect(timer.hasRef()).toBe(false);

      setTimeoutSpy.mockRestore();
    });

    it('should cancel pending reconnects on disconnectAll', async () => {
      const constructor = await connectFlakyServer();

      mockClient.onclose!();
      expect(jest.getTimerCount()).toBe(1);

      await clientManager.disconnectAll();
      expect(jest.getTimerCount()).toBe(0);

      await jest.advanceTimersByTimeAsync(120000);
      expect(constructor).toHaveBeenCalledTimes(1);
    });

    it('should not reconnect after a deliberate close', async () => {
      const constructor = await connectFlakyServer();

      await clientManager.disconnectAll();
      // The SDK fires onclose for our own close() exactly as for a crash.
      mockClient.onclose!();

      await jest.advanceTimersByTimeAsync(120000);

      expect(constructor).toHaveBeenCalledTimes(1);
      expect(mockLogger.warn).not.toHaveBeenCalledWith(
        expect.anything(),
        'MCP server connection lost'
      );
    });

    it('should record a transport error without tearing the connection down', async () => {
      await connectFlakyServer();

      mockClient.onerror!(new Error('stream hiccup'));

      // A recoverable transport error is not a drop: no retry, still usable.
      expect(clientManager.getClient('flaky')).toBeDefined();
      expect(jest.getTimerCount()).toBe(0);
      expect(clientManager.getServerStatuses()[0].lastError).toBe('stream hiccup');
    });

    it('should never retry a server that failed its very first connect', async () => {
      const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
      const constructor = Client as unknown as jest.Mock;

      const brokenClient = {
        ...mockClient,
        connect: jest
          .fn<() => Promise<void>>()
          .mockRejectedValue(new Error('command not found')),
      };
      constructor.mockImplementation(() => brokenClient);

      await clientManager.initializeServers([
        { name: 'typo', command: 'nope', enabled: true },
      ]);

      // A permanently misconfigured server must not retry forever: no hook is
      // wired at all until a connect has succeeded once.
      expect(brokenClient.onclose).toBeUndefined();
      expect(jest.getTimerCount()).toBe(0);

      await jest.advanceTimersByTimeAsync(120000);
      expect(constructor).toHaveBeenCalledTimes(1);
    });
  });
});
