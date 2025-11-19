import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type {
  MCPServerConfig,
  MCPClientConnection,
  ServerStatus
} from '../types/index.js';
import type { Logger } from 'pino';

/**
 * Manages connections to multiple MCP servers
 */
export class MCPClientManager {
  private connections: Map<string, MCPClientConnection> = new Map();
  private logger: Logger;
  private readonly DEFAULT_TIMEOUT_MS = 30000; // 30 seconds default timeout

  constructor(logger: Logger) {
    this.logger = logger;
  }

  /**
   * Wraps a promise with a timeout
   */
  private withTimeout<T>(
    promise: Promise<T>,
    timeoutMs: number
  ): Promise<T> {
    return Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        setTimeout(() => {
          reject(new Error(`Connection timeout after ${timeoutMs}ms`));
        }, timeoutMs);
      }),
    ]);
  }

  /**
   * Initialize and connect to all configured MCP servers
   * @param servers - Server configurations to initialize
   * @param defaultTimeout - Optional default timeout in seconds (overrides class default)
   */
  async initializeServers(
    servers: MCPServerConfig[],
    defaultTimeout?: number
  ): Promise<void> {
    this.logger.info({ count: servers.length }, 'Initializing MCP servers');

    // Apply default timeout to servers that don't have one specified
    const serversWithTimeout = servers.map(server => ({
      ...server,
      timeout: server.timeout ?? defaultTimeout
    }));

    const connectionPromises = serversWithTimeout.map(async (config) => {
      try {
        await this.connectToServer(config);
      } catch (error) {
        this.logger.error(
          { server: config.name, error },
          'Failed to connect to MCP server'
        );
      }
    });

    await Promise.allSettled(connectionPromises);

    const connectedCount = Array.from(this.connections.values()).filter(
      (c) => c.connected
    ).length;

    this.logger.info(
      { connected: connectedCount, total: servers.length },
      'MCP servers initialization complete'
    );
  }

  /**
   * Connect to a single MCP server with timeout
   */
  private async connectToServer(config: MCPServerConfig): Promise<void> {
    // Use server-specific timeout or default (convert seconds to milliseconds)
    const timeoutMs = config.timeout
      ? config.timeout * 1000
      : this.DEFAULT_TIMEOUT_MS;

    this.logger.info(
      { server: config.name, timeoutMs },
      'Connecting to MCP server'
    );

    const transport = new StdioClientTransport({
      command: config.command,
      args: config.args,
      env: config.env,
    });

    const client = new Client(
      {
        name: 'mcp-compression-proxy',
        version: '0.1.0',
      },
      {
        capabilities: {},
      }
    );

    try {
      // Wrap connection with timeout
      await this.withTimeout(
        client.connect(transport),
        timeoutMs
      );

      this.connections.set(config.name, {
        name: config.name,
        client,
        transport,
        connected: true,
      });

      this.logger.info({ server: config.name }, 'Successfully connected to MCP server');
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';

      this.connections.set(config.name, {
        name: config.name,
        client,
        transport,
        connected: false,
        lastError: errorMessage,
      });

      throw error;
    }
  }

  /**
   * Get a connected client by server name
   */
  getClient(serverName: string): Client | undefined {
    const connection = this.connections.get(serverName);
    return connection?.connected ? connection.client : undefined;
  }

  /**
   * Get all connected clients
   */
  getConnectedClients(): Array<{ name: string; client: Client }> {
    return Array.from(this.connections.values())
      .filter((conn) => conn.connected)
      .map((conn) => ({ name: conn.name, client: conn.client }));
  }

  /**
   * Get status of all servers
   */
  getServerStatuses(): ServerStatus[] {
    return Array.from(this.connections.values()).map((conn) => ({
      name: conn.name,
      connected: conn.connected,
      lastError: conn.lastError,
    }));
  }

  /**
   * Check if at least one server is connected
   */
  hasConnectedServers(): boolean {
    return Array.from(this.connections.values()).some((conn) => conn.connected);
  }

  /**
   * Disconnect from all servers
   */
  async disconnectAll(): Promise<void> {
    this.logger.info('Disconnecting from all MCP servers');

    const disconnectPromises = Array.from(this.connections.values()).map(
      async (conn) => {
        try {
          await conn.client.close();
        } catch (error) {
          this.logger.error(
            { server: conn.name, error },
            'Error disconnecting from server'
          );
        }
      }
    );

    await Promise.allSettled(disconnectPromises);
    this.connections.clear();

    this.logger.info('All MCP servers disconnected');
  }
}
