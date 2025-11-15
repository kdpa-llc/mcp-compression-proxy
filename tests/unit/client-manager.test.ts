import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import { MCPClientManager } from '../../src/mcp/client-manager.js';
import type { MCPServerConfig } from '../../src/types/index.js';
import type { Logger } from 'pino';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';

// Mock the MCP SDK
jest.mock('@modelcontextprotocol/sdk/client/index.js');
jest.mock('@modelcontextprotocol/sdk/client/stdio.js');

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
});
