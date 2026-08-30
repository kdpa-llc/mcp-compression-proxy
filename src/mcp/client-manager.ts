import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
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
  private reconnectTimers: Map<string, NodeJS.Timeout> = new Map();
  private reconnectAttempts: Map<string, number> = new Map();
  /**
   * Names we are about to close on purpose. The SDK fires `onclose` for a
   * deliberate `close()` exactly as it does for a crashed backend, so this is
   * the only way the drop handler can tell the two apart.
   */
  private intentionalClose: Set<string> = new Set();
  private logger: Logger;
  private readonly DEFAULT_TIMEOUT_MS = 30000; // 30 seconds default timeout
  private readonly RECONNECT_BASE_MS = 1000;
  private readonly RECONNECT_MAX_MS = 30000;

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
   * Pick the transport for a server.
   *
   * `url` is the whole discriminator - the config schema makes `command` and
   * `url` mutually exclusive, so there is nothing else to inspect. `buildEnv`
   * falls away on the remote branch because there is no child process to hand
   * an environment to; credentials travel as headers instead.
   */
  private buildTransport(config: MCPServerConfig): Transport {
    if (config.url) {
      return new StreamableHTTPClientTransport(new URL(config.url), {
        requestInit: config.headers ? { headers: config.headers } : undefined,
      });
    }

    const command = config.command;
    if (!command) {
      throw new Error(
        `Server "${config.name}" has neither "command" nor "url" - config validation should have rejected it`
      );
    }

    return new StdioClientTransport({
      command,
      args: config.args,
      env: this.buildEnv(config),
    });
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

    const transport = this.buildTransport(config);

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
        config,
      });

      // A connection that came up once is worth chasing again, so the backoff
      // starts fresh from here. The intentional-close flag goes too: a stale
      // one would swallow the first genuine drop of this new connection.
      this.reconnectAttempts.delete(config.name);
      this.intentionalClose.delete(config.name);

      // Hooked only after connect() resolves: an initial failure is almost
      // always a misconfigured command, and retrying that forever would be an
      // unrequested behaviour change plus endless log noise.
      //
      // The Client's own callbacks rather than transport.onclose because
      // Protocol.connect() captures whatever is on the transport at connect
      // time and wraps it - assigning there afterwards is order-dependent and
      // reaches past the class's own API.
      client.onclose = () => this.handleDrop(config.name, client);
      client.onerror = (error) => {
        // Recorded, not acted on: transports report recoverable errors here
        // too. The close that follows a fatal one is what drives the retry,
        // and this leaves a cause behind for getServerStatuses().
        const connection = this.connections.get(config.name);
        if (connection?.client === client) {
          connection.lastError = error instanceof Error ? error.message : String(error);
        }
        this.logger.warn({ server: config.name, error }, 'MCP server transport error');
      };

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
        config,
      });

      throw error;
    }
  }

  /**
   * React to a backend connection going away.
   *
   * `client` identifies which generation closed: an old transport finishing
   * its teardown after a reconnect already installed a replacement must not
   * mark the live connection down.
   */
  private handleDrop(name: string, client: Client): void {
    if (this.intentionalClose.delete(name)) {
      return;
    }

    const connection = this.connections.get(name);
    if (!connection || connection.client !== client) {
      return;
    }

    connection.connected = false;
    connection.lastError = connection.lastError ?? 'Connection closed';

    this.logger.warn(
      { server: name, error: connection.lastError },
      'MCP server connection lost'
    );

    this.scheduleReconnect(connection.config);
  }

  /**
   * Queue a reconnect with capped, jittered exponential backoff.
   *
   * Attempts are uncapped on purpose - a backend can be down for hours (a
   * laptop asleep, a container being rebuilt) and should still come back
   * without the operator restarting their whole MCP client. The jitter keeps
   * several backends behind the same dead machine from retrying in lockstep.
   */
  private scheduleReconnect(config: MCPServerConfig): void {
    const name = config.name;

    // Two paths reach here - a fresh drop and a failed retry - and a second
    // timer would double the reconnect rate while orphaning the first.
    if (this.reconnectTimers.has(name)) {
      return;
    }

    const attempt = this.reconnectAttempts.get(name) ?? 0;
    this.reconnectAttempts.set(name, attempt + 1);

    const capped = Math.min(
      this.RECONNECT_BASE_MS * 2 ** attempt,
      this.RECONNECT_MAX_MS
    );
    const delayMs = Math.round(capped * (0.8 + Math.random() * 0.4));

    const timer = setTimeout(() => {
      this.reconnectTimers.delete(name);
      void this.reconnect(config);
    }, delayMs);

    // A pending retry must never be the reason the process cannot exit: a
    // backend that stays down would otherwise pin the event loop open forever.
    timer.unref?.();

    this.reconnectTimers.set(name, timer);

    this.logger.info(
      { server: name, delayMs, attempt: attempt + 1 },
      'Scheduling MCP server reconnect'
    );
  }

  private async reconnect(config: MCPServerConfig): Promise<void> {
    try {
      await this.connectToServer(config);
      this.logger.info({ server: config.name }, 'Reconnected to MCP server');
    } catch (error) {
      this.logger.warn(
        { server: config.name, error },
        'Reconnect attempt failed, backing off'
      );
      this.scheduleReconnect(config);
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

    // Cancel queued retries and claim every close as ours *before* closing
    // anything. A timer surviving teardown would reconnect to a backend nobody
    // is listening to, and the resulting `onclose` would schedule yet another.
    for (const timer of this.reconnectTimers.values()) {
      clearTimeout(timer);
    }
    this.reconnectTimers.clear();
    this.reconnectAttempts.clear();

    for (const name of this.connections.keys()) {
      this.intentionalClose.add(name);
    }

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
    // The intentional-close flags stay: a transport can fire `onclose` a tick
    // after close() resolves, and clearing them here would make that late
    // callback look like a crash. Each is dropped when its server connects
    // again, so they cannot outlive a reconnect.

    this.logger.info('All MCP servers disconnected');
  }
}
