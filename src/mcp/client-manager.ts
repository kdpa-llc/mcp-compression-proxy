import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type {
  MCPServerConfig,
  MCPClientConnection,
  ServerStatus
} from '../types/index.js';
import type { Logger } from 'pino';
import { SERVER_NAME, VERSION } from '../version.js';

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
   * Wraps a promise with a timeout.
   *
   * The timer is always cleared - leaving it pending keeps the Node event loop
   * alive for the full duration even after a fast connection succeeds.
   */
  private async withTimeout<T>(
    promise: Promise<T>,
    timeoutMs: number
  ): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;

    try {
      return await Promise.race([
        promise,
        new Promise<T>((_, reject) => {
          timer = setTimeout(() => {
            reject(new Error(`Connection timeout after ${timeoutMs}ms`));
          }, timeoutMs);
        }),
      ]);
    } finally {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
    }
  }

  /**
   * Build the environment handed to a spawned server.
   *
   * The stdio transport only inherits a small allowlist of "safe" variables
   * (PATH, HOME, ...), so anything else the user exported - API tokens, base
   * URLs - never reaches the child unless it is passed explicitly. By default
   * we forward the proxy's full environment, matching what users expect from a
   * process they launched themselves. `inheritEnv` narrows that when a server
   * should not see unrelated secrets.
   */
  private buildEnv(config: MCPServerConfig): Record<string, string> | undefined {
    const inherit = config.inheritEnv ?? true;

    // `false` defers entirely to the transport's safe defaults.
    if (inherit === false) {
      return config.env;
    }

    const names = Array.isArray(inherit) ? inherit : Object.keys(process.env);
    const inherited: Record<string, string> = {};

    for (const name of names) {
      const value = process.env[name];
      if (value === undefined) continue;
      // Skip exported shell functions, which are a known injection vector.
      if (value.startsWith('()')) continue;
      inherited[name] = value;
    }

    // Explicit `env` entries always win over inherited ones.
    return { ...inherited, ...config.env };
  }

  /**
   * Initialize and connect to all configured MCP servers
   * @param servers - Server configurations to initialize
   * @param defaultTimeout - Optional default timeout in seconds (overrides class default)
   * @param defaultInheritEnv - Optional default env inheritance policy (overridden per-server)
   */
  async initializeServers(
    servers: MCPServerConfig[],
    defaultTimeout?: number,
    defaultInheritEnv?: boolean | string[]
  ): Promise<void> {
    this.logger.info({ count: servers.length }, 'Initializing MCP servers');

    // Apply defaults to servers that don't specify their own
    const serversWithTimeout = servers.map(server => ({
      ...server,
      timeout: server.timeout ?? defaultTimeout,
      inheritEnv: server.inheritEnv ?? defaultInheritEnv,
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
      env: this.buildEnv(config),
    });

    const client = new Client(
      {
        name: SERVER_NAME,
        version: VERSION,
      },
      {
        capabilities: {},
      }
    );

    try {
      const connectPromise = client.connect(transport);
      // If the timeout wins the race below, this promise may still reject on its
      // own later; swallow it so it doesn't surface as an unhandled rejection.
      connectPromise.catch(() => {});

      await this.withTimeout(connectPromise, timeoutMs);

      this.connections.set(config.name, {
        name: config.name,
        client,
        transport,
        connected: true,
      });

      this.logger.info({ server: config.name }, 'Successfully connected to MCP server');
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';

      // A timed-out connect leaves the spawned process running. Tear the
      // transport down so we don't orphan a child for the proxy's lifetime.
      try {
        await transport.close();
      } catch (closeError) {
        this.logger.debug(
          { server: config.name, error: closeError },
          'Failed to close transport for unsuccessful connection'
        );
      }

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
