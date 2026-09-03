import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type {
  ConnectionLifecycleDefaults,
  MCPClientConnection,
  MCPServerConfig,
  ServerStatus,
} from '../types/index.js';
import type { Logger } from 'pino';
import type { ConfigResult } from '../config/loader.js';
import { SERVER_NAME, VERSION } from '../version.js';

export const DEFAULT_SOFT_MAX_CONNECTION_AGE_SECONDS = 3600;
export const DEFAULT_HARD_MAX_CONNECTION_AGE_SECONDS = 28_800;

type ManagedConnectionState = 'ready' | 'draining' | 'closed';

type ResolvedServerConfig = MCPServerConfig & {
  softMaxConnectionAgeSeconds: number;
  hardMaxConnectionAgeSeconds: number;
  authErrorPatterns: string[];
  authRetryTools: string[];
};

interface ManagedConnection extends MCPClientConnection {
  config: ResolvedServerConfig;
  state: ManagedConnectionState;
  generation: number;
  connectedAt: number;
  lastUsedAt: number;
  activeCalls: number;
  intentionalClose: boolean;
  hardExpiryTimer?: ReturnType<typeof setTimeout>;
  closePromise?: Promise<void>;
}

interface ServerSlot {
  config: ResolvedServerConfig;
  current?: ManagedConnection;
  draining: Set<ManagedConnection>;
  connectPromise?: Promise<ManagedConnection>;
  nextGeneration: number;
  lastAttemptAt?: number;
  lastSuccessAt?: number;
  lastUsedAt?: number;
  lastError?: string;
  consecutiveFailures: number;
  recycleCount: number;
  authInvalidations: number;
  reconnectAttempt: number;
  reconnectTimer?: ReturnType<typeof setTimeout>;
  disposed: boolean;
}

export interface ManagedClientContext {
  client: Client;
  generation: number;
  /** Record a failed operation without recycling an otherwise healthy backend. */
  markFailure(reason: string): void;
  /**
   * Stop routing new work to this exact generation. Active calls finish before
   * the backend closes, and the next acquisition starts a replacement.
   */
  invalidate(reason: string): void;
}

/**
 * Stable serialization of a resolved server config, used to decide whether a
 * live connection still matches what servers.json now asks for.
 *
 * Keys are sorted because JSON.stringify follows insertion order: an operator
 * swapping two lines inside a server entry would otherwise read as a changed
 * server and bounce a perfectly healthy backend. Absent and explicitly
 * `undefined` fields collapse together for the same reason.
 */
function configFingerprint(config: MCPServerConfig): string {
  // Only the fields that define the live connection. `enabled` is already
  // handled by filtering before reconcile, and `timeout` is consumed once at
  // connect time - hashing either meant deleting a redundant "enabled": true
  // or raising a timeout closed a healthy backend and respawned its process,
  // which is exactly the churn the key-sorting below exists to avoid.
  const {
    name,
    command,
    args,
    env,
    inheritEnv,
    url,
    headers,
    softMaxConnectionAgeSeconds,
    hardMaxConnectionAgeSeconds,
    maxConnectionAgeSeconds,
    authErrorPatterns,
    authRetryTools,
  } = config;
  const connectionFields = {
    name,
    command,
    args,
    env,
    inheritEnv,
    url,
    headers,
    softMaxConnectionAgeSeconds,
    hardMaxConnectionAgeSeconds,
    maxConnectionAgeSeconds,
    authErrorPatterns,
    authRetryTools,
  };

  return JSON.stringify(connectionFields, (_key, value: unknown) =>
    value !== null && typeof value === 'object' && !Array.isArray(value)
      ? Object.fromEntries(
          Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : 1))
        )
      : value
  );
}

/**
 * Best-effort message for something thrown.
 *
 * `instanceof Error` is not reliable here: `new URL()` is Node core, so on a
 * malformed address it throws an Error built in a different realm from this
 * module's, and the check silently fails - turning a perfectly good "Invalid
 * URL" into "Unknown error" on the one status field the user reads to find out
 * what went wrong.
 */
function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;

  const message = (error as { message?: unknown } | null | undefined)?.message;
  if (typeof message === 'string' && message !== '') return message;

  return 'Unknown error';
}

/**
 * Manages backend MCP processes as leased connection generations.
 *
 * READY connections may be leased by concurrent callers. Soft-expired
 * connections are replaced on the next acquisition. Hard-expired connections
 * enter DRAINING immediately and close after their final lease is released.
 */
export class MCPClientManager {
  private readonly slots = new Map<string, ServerSlot>();
  private readonly logger: Logger;
  private readonly DEFAULT_TIMEOUT_MS = 30_000;
  private readonly RECONNECT_BASE_MS = 1_000;
  private readonly RECONNECT_MAX_MS = 30_000;
  private configWatchTimer?: ReturnType<typeof setInterval>;
  private shuttingDown = false;

  constructor(logger: Logger) {
    this.logger = logger;
  }

  /**
   * Wraps a promise with a timeout.
   *
   * The timer is always cleared - leaving it pending keeps the Node event loop
   * alive for the full duration even after a fast connection succeeds.
   */
  private async withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
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
   * URLs - never reaches the child unless it is passed explicitly.
   */
  private buildEnv(config: MCPServerConfig): Record<string, string> | undefined {
    const inherit = config.inheritEnv ?? true;

    if (inherit === false) {
      return config.env;
    }

    const names = Array.isArray(inherit) ? inherit : Object.keys(process.env);
    const inherited: Record<string, string> = {};

    for (const name of names) {
      const value = process.env[name];
      if (value === undefined || value.startsWith('()')) continue;
      inherited[name] = value;
    }

    return { ...inherited, ...config.env };
  }

  private resolveConfig(
    server: MCPServerConfig,
    defaultTimeout: number | undefined,
    defaultInheritEnv: boolean | string[] | undefined,
    defaults: ConnectionLifecycleDefaults
  ): ResolvedServerConfig {
    return {
      ...server,
      timeout: server.timeout ?? defaultTimeout,
      inheritEnv: server.inheritEnv ?? defaultInheritEnv,
      softMaxConnectionAgeSeconds:
        server.softMaxConnectionAgeSeconds ??
        server.maxConnectionAgeSeconds ??
        defaults.softMaxConnectionAgeSeconds ??
        defaults.maxConnectionAgeSeconds ??
        DEFAULT_SOFT_MAX_CONNECTION_AGE_SECONDS,
      hardMaxConnectionAgeSeconds:
        server.hardMaxConnectionAgeSeconds ??
        defaults.hardMaxConnectionAgeSeconds ??
        DEFAULT_HARD_MAX_CONNECTION_AGE_SECONDS,
      authErrorPatterns: [...(server.authErrorPatterns ?? defaults.authErrorPatterns ?? [])],
      authRetryTools: [...(server.authRetryTools ?? defaults.authRetryTools ?? [])],
    };
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
   * Initialize all configured slots and eagerly start their first generation.
   * A failed initial connection remains configured and is retried lazily later.
   */
  async initializeServers(
    servers: MCPServerConfig[],
    defaultTimeout?: number,
    defaultInheritEnv?: boolean | string[],
    lifecycleDefaults: ConnectionLifecycleDefaults = {}
  ): Promise<void> {
    this.logger.info({ count: servers.length }, 'Initializing MCP servers');

    const slots = servers.map((server) => {
      const config = this.resolveConfig(
        server,
        defaultTimeout,
        defaultInheritEnv,
        lifecycleDefaults
      );
      const slot: ServerSlot = {
        config,
        draining: new Set(),
        nextGeneration: 0,
        consecutiveFailures: 0,
        recycleCount: 0,
        authInvalidations: 0,
        reconnectAttempt: 0,
        disposed: false,
      };
      this.slots.set(config.name, slot);
      return slot;
    });

    await Promise.allSettled(
      slots.map(async (slot) => {
        try {
          await this.ensureConnection(slot);
        } catch (error) {
          this.logger.error({ server: slot.config.name, error }, 'Failed to connect to MCP server');
        }
      })
    );

    const connectedCount = Array.from(this.slots.values()).filter(
      (slot) => slot.current?.state === 'ready'
    ).length;

    this.logger.info(
      { connected: connectedCount, total: servers.length },
      'MCP servers initialization complete'
    );
  }

  private async createConnection(slot: ServerSlot): Promise<ManagedConnection> {
    const { config } = slot;
    const timeoutMs = config.timeout ? config.timeout * 1000 : this.DEFAULT_TIMEOUT_MS;

    slot.lastAttemptAt = Date.now();
    this.logger.info(
      {
        server: config.name,
        timeoutMs,
        softMaxConnectionAgeSeconds: config.softMaxConnectionAgeSeconds,
        hardMaxConnectionAgeSeconds: config.hardMaxConnectionAgeSeconds,
      },
      'Connecting to MCP server'
    );

    const client = new Client(
      {
        name: SERVER_NAME,
        version: VERSION,
      },
      {
        capabilities: {},
      }
    );

    // Built inside the try so a transport that cannot be constructed at all -
    // `url` missing its scheme is schema-valid and throws here - still lands in
    // the catch and gets recorded. Outside it, the server simply disappeared
    // from getServerStatuses() and looked like it had never been configured.
    let transport: Transport | undefined;

    try {
      transport = this.buildTransport(config);

      const connectPromise = client.connect(transport);
      connectPromise.catch(() => {});
      await this.withTimeout(connectPromise, timeoutMs);

      // The world may have moved while this connect was in flight: a shutdown
      // completed, or a config reload dropped this server. Adopting the
      // connection now would resurrect a backend nobody will ever close, so
      // hand it straight back instead.
      const unwanted = this.shuttingDown || slot.disposed || this.slots.get(config.name) !== slot;

      if (unwanted) {
        try {
          await client.close();
        } catch (error) {
          this.logger.debug(
            { server: config.name, error },
            'Failed to close a connection that is no longer wanted'
          );
        }

        this.logger.info(
          { server: config.name, reason: this.shuttingDown ? 'shutdown' : 'removed from config' },
          'Discarded a connection that resolved after it was no longer wanted'
        );
        transport = undefined;
        throw new Error(`Server '${config.name}' is no longer configured`);
      }

      const now = Date.now();
      const connection: ManagedConnection = {
        name: config.name,
        client,
        transport,
        connected: true,
        config,
        state: 'ready',
        generation: ++slot.nextGeneration,
        connectedAt: now,
        lastUsedAt: now,
        activeCalls: 0,
        intentionalClose: false,
      };

      // Hooked only after connect() resolves: an initial failure is almost
      // always a misconfigured command, and retrying that forever would be an
      // unrequested behaviour change plus endless log noise.
      //
      // The Client's own callbacks rather than transport.onclose because
      // Protocol.connect() captures whatever is on the transport at connect
      // time and wraps it - assigning there afterwards is order-dependent and
      // reaches past the class's own API.
      client.onclose = () => this.handleDrop(slot, connection);
      client.onerror = (error) => {
        // Recorded, not acted on: transports report recoverable errors here
        // too. The close that follows a fatal one is what drives the retry,
        // and this leaves a cause behind for getServerStatuses().
        if (slot.current === connection && connection.state === 'ready') {
          slot.lastError = describeError(error);
        }
        this.logger.warn({ server: config.name, error }, 'MCP server transport error');
      };

      slot.reconnectAttempt = 0;
      this.scheduleHardExpiry(slot, connection);
      this.logger.info(
        { server: config.name, generation: connection.generation },
        'Successfully connected to MCP server'
      );
      return connection;
    } catch (error) {
      const errorMessage = describeError(error);

      // A timed-out connect leaves the spawned process running. Tear the
      // transport down so we don't orphan a child for the proxy's lifetime.
      // Undefined when construction itself failed, in which case there is no
      // process and nothing to close.
      try {
        await transport?.close();
      } catch (closeError) {
        this.logger.debug(
          { server: config.name, error: closeError },
          'Failed to close transport for unsuccessful connection'
        );
      }

      this.recordFailure(slot, errorMessage);
      throw error;
    }
  }

  /**
   * React to a backend connection going away.
   *
   * `connection` identifies which generation closed: an old transport finishing
   * its teardown after a reconnect already installed a replacement must not
   * mark the live connection down.
   */
  private handleDrop(slot: ServerSlot, connection: ManagedConnection): void {
    const name = slot.config.name;
    if (
      connection.intentionalClose ||
      this.shuttingDown ||
      slot.disposed ||
      this.slots.get(name) !== slot ||
      slot.current !== connection ||
      connection.state !== 'ready'
    ) {
      return;
    }

    if (connection.hardExpiryTimer) {
      clearTimeout(connection.hardExpiryTimer);
      connection.hardExpiryTimer = undefined;
    }
    connection.state = 'closed';
    connection.connected = false;
    slot.current = undefined;
    this.recordFailure(slot, slot.lastError ?? 'Connection closed');

    this.logger.warn({ server: name, error: slot.lastError }, 'MCP server connection lost');

    this.scheduleReconnect(slot);
  }

  /**
   * Queue a reconnect with capped, jittered exponential backoff.
   *
   * Attempts are uncapped on purpose - a backend can be down for hours (a
   * laptop asleep, a container being rebuilt) and should still come back
   * without the operator restarting their whole MCP client. The jitter keeps
   * several backends behind the same dead machine from retrying in lockstep.
   */
  private scheduleReconnect(slot: ServerSlot): void {
    const name = slot.config.name;

    // Two paths reach here - a fresh drop and a failed retry - and a second
    // timer would double the reconnect rate while orphaning the first.
    if (
      slot.reconnectTimer ||
      slot.disposed ||
      this.shuttingDown ||
      this.slots.get(name) !== slot
    ) {
      return;
    }

    const attempt = slot.reconnectAttempt;
    slot.reconnectAttempt += 1;

    // Jitter is applied first and the cap last, so RECONNECT_MAX_MS is a real
    // ceiling. Capping the base instead let the +20% arm push actual delays to
    // 36s, which quietly contradicts what the constant says.
    const backoff = this.RECONNECT_BASE_MS * 2 ** attempt;
    const jittered = backoff * (0.8 + Math.random() * 0.4);
    const delayMs = Math.round(Math.min(jittered, this.RECONNECT_MAX_MS));

    const timer = setTimeout(() => {
      slot.reconnectTimer = undefined;
      void this.reconnect(slot);
    }, delayMs);

    // A pending retry must never be the reason the process cannot exit: a
    // backend that stays down would otherwise pin the event loop open forever.
    timer.unref?.();

    slot.reconnectTimer = timer;

    this.logger.info(
      { server: name, delayMs, attempt: attempt + 1 },
      'Scheduling MCP server reconnect'
    );
  }

  private async reconnect(slot: ServerSlot): Promise<void> {
    const name = slot.config.name;
    if (slot.disposed || this.shuttingDown || this.slots.get(name) !== slot) {
      return;
    }

    try {
      await this.ensureConnection(slot);
      this.logger.info({ server: name }, 'Reconnected to MCP server');
    } catch (error) {
      this.logger.warn({ server: name, error }, 'Reconnect attempt failed, backing off');
      this.scheduleReconnect(slot);
    }
  }

  /**
   * Bring the live connections in line with a freshly loaded server list.
   *
   * Servers that vanished or changed are torn down, servers that appeared are
   * connected, and everything untouched keeps its existing connection - an
   * edit to one entry must not interrupt the other backends.
   */
  async reconcile(
    servers: MCPServerConfig[],
    defaultTimeout?: number,
    defaultInheritEnv?: boolean | string[],
    lifecycleDefaults: ConnectionLifecycleDefaults = {}
  ): Promise<void> {
    const desired = new Map(
      servers.map((server) => {
        const resolved = this.resolveConfig(
          server,
          defaultTimeout,
          defaultInheritEnv,
          lifecycleDefaults
        );
        return [resolved.name, resolved];
      })
    );

    const removed: string[] = [];
    const changed: string[] = [];

    for (const [name, slot] of this.slots) {
      const next = desired.get(name);
      if (!next) {
        removed.push(name);
      } else if (configFingerprint(next) !== configFingerprint(slot.config)) {
        changed.push(name);
      }
    }

    const added = Array.from(desired.keys()).filter((name) => !this.slots.has(name));

    // Nothing to do on the overwhelming majority of polls; returning before the
    // log keeps a five-second timer from filling the log with noise.
    if (removed.length === 0 && changed.length === 0 && added.length === 0) {
      return;
    }

    this.logger.info({ removed, changed, added }, 'Applying backend server configuration change');

    // Fully drained before a single connect starts. A changed server is a
    // teardown *and* an add, and letting the two overlap would leave two
    // MCPClientConnection generations racing to own the same name.
    for (const name of [...removed, ...changed]) {
      await this.teardownSlot(name);
    }

    const toConnect = new Set([...added, ...changed]);

    await Promise.allSettled(
      Array.from(desired.values())
        .filter((config) => toConnect.has(config.name))
        .map(async (config) => {
          const slot: ServerSlot = {
            config,
            draining: new Set(),
            nextGeneration: 0,
            consecutiveFailures: 0,
            recycleCount: 0,
            authInvalidations: 0,
            reconnectAttempt: 0,
            disposed: false,
          };
          this.slots.set(config.name, slot);
          try {
            await this.ensureConnection(slot);
          } catch (error) {
            this.logger.error({ server: config.name, error }, 'Failed to connect to MCP server');
          }
        })
    );
  }

  /**
   * Close a connection the operator has removed or replaced.
   *
   * Order matters: the queued retry dies first and the close is claimed as
   * ours *before* close() runs, so handleDrop() cannot resurrect a server that
   * was deliberately taken out of servers.json.
   */
  private async teardownSlot(name: string): Promise<void> {
    const slot = this.slots.get(name);
    if (!slot) {
      return;
    }

    this.slots.delete(name);
    slot.disposed = true;
    if (slot.reconnectTimer) {
      clearTimeout(slot.reconnectTimer);
      slot.reconnectTimer = undefined;
    }

    const connections = new Set(slot.draining);
    if (slot.current) {
      connections.add(slot.current);
      slot.current = undefined;
    }

    await Promise.allSettled(
      Array.from(connections).map(async (connection) => {
        connection.intentionalClose = true;
        connection.connected = false;
        connection.state = 'closed';
        if (connection.hardExpiryTimer) {
          clearTimeout(connection.hardExpiryTimer);
          connection.hardExpiryTimer = undefined;
        }
        try {
          await connection.client.close();
        } catch (error) {
          this.logger.debug({ server: name, error }, 'Error closing removed MCP server');
        } finally {
          slot.draining.delete(connection);
        }
      })
    );
  }

  private lifecycleDefaultsFromConfig(
    config: NonNullable<ConfigResult>
  ): ConnectionLifecycleDefaults {
    return {
      softMaxConnectionAgeSeconds: config.softMaxConnectionAgeSeconds,
      hardMaxConnectionAgeSeconds: config.hardMaxConnectionAgeSeconds,
      authErrorPatterns: config.authErrorPatterns,
      authRetryTools: config.authRetryTools,
    };
  }

  private cancelReconnect(slot: ServerSlot): void {
    if (slot.reconnectTimer) {
      clearTimeout(slot.reconnectTimer);
      slot.reconnectTimer = undefined;
    }
  }

  /**
   * Poll the config for server list changes and apply them live.
   *
   * Polling rather than fs.watch: watchers fire duplicate events and stop
   * working entirely once a file is replaced by write-temp-then-rename, which
   * is how most editors and jq-style tools save. Two stats every few seconds
   * are cheaper than the bug reports that would follow.
   *
   * `loadConfig` is injected rather than imported so this stays testable
   * without fixture files, matching the loader injection in StatsService.
   */
  startConfigWatch(
    loadConfig: () => ConfigResult,
    intervalMs = 5000,
    onConfigLoaded?: (config: NonNullable<ConfigResult>) => void
  ): void {
    // A second watcher would double the poll rate and leak the first interval.
    if (this.configWatchTimer) {
      return;
    }

    this.configWatchTimer = setInterval(() => {
      let config: ConfigResult;

      try {
        config = loadConfig();
      } catch (error) {
        // A half-written servers.json is invalid JSON for a few milliseconds.
        // That is an editor mid-save, not a reason to stop watching.
        this.logger.warn({ error }, 'Config reload failed, keeping the current backend servers');
        return;
      }

      if (!config) {
        return;
      }

      // Settings that live outside this class - compression patterns, the
      // uncompressed-tool fallback - are applied by the owner. Without this a
      // proxy started before servers.json existed would connect the servers it
      // later described but ignore the noCompressTools in the same file.
      try {
        onConfigLoaded?.(config);
      } catch (error) {
        this.logger.warn({ error }, 'Config reload hook failed');
      }

      void this.reconcile(
        config.servers.filter((server) => server.enabled !== false),
        config.defaultTimeout,
        config.inheritEnv,
        this.lifecycleDefaultsFromConfig(config)
      ).catch((error) => {
        this.logger.error({ error }, 'Failed to apply backend server configuration');
      });
    }, intervalMs);

    // Housekeeping must never be what keeps the process alive.
    this.configWatchTimer.unref?.();

    this.logger.info({ intervalMs }, 'Watching configuration for server changes');
  }

  /**
   * Single-flight connection creation. Concurrent callers share this promise.
   */
  private async ensureConnection(slot: ServerSlot): Promise<ManagedConnection> {
    if (this.shuttingDown) {
      throw new Error('MCP client manager is shutting down');
    }

    if (slot.current?.state === 'ready') {
      return slot.current;
    }

    if (slot.connectPromise) {
      return slot.connectPromise;
    }

    const connectPromise = this.createConnection(slot).then(async (connection) => {
      if (this.shuttingDown || slot.disposed || this.slots.get(slot.config.name) !== slot) {
        connection.intentionalClose = true;
        await this.closeConnection(slot, connection);
        throw new Error('MCP client manager no longer wants this connection');
      }
      slot.current = connection;
      return connection;
    });
    slot.connectPromise = connectPromise;

    try {
      return await connectPromise;
    } finally {
      if (slot.connectPromise === connectPromise) {
        slot.connectPromise = undefined;
      }
    }
  }

  private scheduleHardExpiry(slot: ServerSlot, connection: ManagedConnection): void {
    const hardAgeSeconds = connection.config.hardMaxConnectionAgeSeconds;
    if (hardAgeSeconds <= 0) return;

    connection.hardExpiryTimer = setTimeout(() => {
      this.beginDrain(slot, connection, 'hard-max-age');
    }, hardAgeSeconds * 1000);
    connection.hardExpiryTimer.unref?.();
  }

  private isSoftExpired(connection: ManagedConnection): boolean {
    const softAgeSeconds = connection.config.softMaxConnectionAgeSeconds;
    return softAgeSeconds > 0 && Date.now() - connection.connectedAt >= softAgeSeconds * 1000;
  }

  private beginDrain(slot: ServerSlot, connection: ManagedConnection, reason: string): void {
    if (connection.state !== 'ready') return;

    connection.state = 'draining';
    if (connection.hardExpiryTimer) {
      clearTimeout(connection.hardExpiryTimer);
      connection.hardExpiryTimer = undefined;
    }
    if (slot.current === connection) {
      slot.current = undefined;
    }
    slot.draining.add(connection);

    if (reason !== 'shutdown') {
      slot.recycleCount += 1;
    }
    if (reason === 'auth-error') {
      slot.authInvalidations += 1;
    }

    this.logger.info(
      {
        server: slot.config.name,
        generation: connection.generation,
        reason,
        ageMs: Date.now() - connection.connectedAt,
        activeCalls: connection.activeCalls,
      },
      'Draining MCP connection'
    );

    if (connection.activeCalls === 0) {
      void this.closeConnection(slot, connection);
    }
  }

  private async closeConnection(slot: ServerSlot, connection: ManagedConnection): Promise<void> {
    if (connection.closePromise) {
      return connection.closePromise;
    }

    if (connection.hardExpiryTimer) {
      clearTimeout(connection.hardExpiryTimer);
      connection.hardExpiryTimer = undefined;
    }
    connection.intentionalClose = true;
    connection.state = 'closed';
    connection.connected = false;

    connection.closePromise = (async () => {
      try {
        await connection.client.close();
      } catch (error) {
        this.recordFailure(slot, error);
        this.logger.error(
          {
            server: slot.config.name,
            generation: connection.generation,
            error,
          },
          'Failed to close MCP client; closing transport directly'
        );
        try {
          await connection.transport?.close();
        } catch (transportError) {
          this.logger.error(
            {
              server: slot.config.name,
              generation: connection.generation,
              error: transportError,
            },
            'Failed to close MCP transport'
          );
        }
      } finally {
        slot.draining.delete(connection);
        if (slot.current === connection) {
          slot.current = undefined;
        }
      }
    })();

    return connection.closePromise;
  }

  private async acquireConnection(
    serverName: string
  ): Promise<{ slot: ServerSlot; connection: ManagedConnection }> {
    const slot = this.slots.get(serverName);
    if (!slot) {
      throw new Error(`Server '${serverName}' is not configured`);
    }

    let connection = slot.current;
    if (connection?.state === 'ready' && this.isSoftExpired(connection)) {
      this.beginDrain(slot, connection, 'soft-max-age');
      connection = undefined;
    }

    if (!connection || connection.state !== 'ready') {
      connection = await this.ensureConnection(slot);
    }

    if (connection.state !== 'ready') {
      return this.acquireConnection(serverName);
    }

    connection.activeCalls += 1;
    connection.lastUsedAt = Date.now();
    slot.lastUsedAt = connection.lastUsedAt;
    return { slot, connection };
  }

  private async releaseConnection(slot: ServerSlot, connection: ManagedConnection): Promise<void> {
    connection.activeCalls = Math.max(0, connection.activeCalls - 1);
    connection.lastUsedAt = Date.now();
    slot.lastUsedAt = connection.lastUsedAt;

    if (connection.state === 'draining' && connection.activeCalls === 0) {
      await this.closeConnection(slot, connection);
    }
  }

  private recordSuccess(slot: ServerSlot): void {
    slot.lastSuccessAt = Date.now();
    slot.lastError = undefined;
    slot.consecutiveFailures = 0;
  }

  private recordFailure(slot: ServerSlot, error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    slot.lastError = message;
    slot.consecutiveFailures += 1;

    if (
      slot.consecutiveFailures === 3 ||
      (slot.consecutiveFailures > 3 && slot.consecutiveFailures % 5 === 0)
    ) {
      this.logger.warn(
        {
          server: slot.config.name,
          consecutiveFailures: slot.consecutiveFailures,
          lastSuccessAt: slot.lastSuccessAt,
          error: message,
        },
        'MCP server has repeated failures'
      );
    }
  }

  /**
   * Execute work under a lease. Invalidating the context drains this exact
   * generation, so concurrent recovery cannot accidentally close a newer one.
   */
  async withClient<T>(
    serverName: string,
    operation: (context: ManagedClientContext) => Promise<T>
  ): Promise<T> {
    const { slot, connection } = await this.acquireConnection(serverName);
    slot.lastAttemptAt = Date.now();
    let failureReason: string | undefined;

    try {
      const result = await operation({
        client: connection.client,
        generation: connection.generation,
        markFailure: (reason: string) => {
          failureReason ??= reason;
        },
        invalidate: (reason: string) => {
          failureReason ??= reason;
          this.beginDrain(slot, connection, reason);
        },
      });

      if (failureReason) {
        this.recordFailure(slot, failureReason);
      } else {
        this.recordSuccess(slot);
      }
      return result;
    } catch (error) {
      this.recordFailure(slot, error);
      throw error;
    } finally {
      await this.releaseConnection(slot, connection);
    }
  }

  getConfiguredServerNames(): string[] {
    return Array.from(this.slots.keys());
  }

  getAuthRecoveryPolicy(serverName: string): {
    authErrorPatterns: string[];
    authRetryTools: string[];
  } {
    const slot = this.slots.get(serverName);
    return {
      authErrorPatterns: [...(slot?.config.authErrorPatterns ?? [])],
      authRetryTools: [...(slot?.config.authRetryTools ?? [])],
    };
  }

  /**
   * Compatibility accessors. Production operations should use withClient so
   * lifecycle age, active leases, and health are tracked.
   */
  getClient(serverName: string): Client | undefined {
    const connection = this.slots.get(serverName)?.current;
    return connection?.state === 'ready' ? connection.client : undefined;
  }

  getConnectedClients(): Array<{ name: string; client: Client }> {
    return Array.from(this.slots.entries()).flatMap(([name, slot]) =>
      slot.current?.state === 'ready' ? [{ name, client: slot.current.client }] : []
    );
  }

  getServerStatuses(): ServerStatus[] {
    const now = Date.now();

    return Array.from(this.slots.entries()).map(([name, slot]) => {
      const current = slot.current?.state === 'ready' ? slot.current : undefined;
      const activeCalls =
        (current?.activeCalls ?? 0) +
        Array.from(slot.draining).reduce((total, connection) => total + connection.activeCalls, 0);
      const state = current
        ? 'ready'
        : slot.connectPromise
          ? 'starting'
          : slot.draining.size > 0
            ? 'draining'
            : slot.lastError && slot.consecutiveFailures > 0
              ? 'failed'
              : 'closed';

      return {
        name,
        connected: current !== undefined,
        state,
        lastError: slot.lastError,
        activeCalls,
        drainingConnections: slot.draining.size,
        generation: current?.generation ?? (slot.nextGeneration || undefined),
        connectedAt: current?.connectedAt,
        lastUsedAt: slot.lastUsedAt,
        lastAttemptAt: slot.lastAttemptAt,
        lastSuccessAt: slot.lastSuccessAt,
        connectionAgeSeconds: current ? Math.floor((now - current.connectedAt) / 1000) : undefined,
        softMaxConnectionAgeSeconds: slot.config.softMaxConnectionAgeSeconds,
        hardMaxConnectionAgeSeconds: slot.config.hardMaxConnectionAgeSeconds,
        recycleCount: slot.recycleCount,
        authInvalidations: slot.authInvalidations,
        consecutiveFailures: slot.consecutiveFailures,
      };
    });
  }

  hasConnectedServers(): boolean {
    return Array.from(this.slots.values()).some((slot) => slot.current?.state === 'ready');
  }

  async disconnectAll(): Promise<void> {
    this.logger.info('Disconnecting from all MCP servers');
    this.shuttingDown = true;

    if (this.configWatchTimer) {
      clearInterval(this.configWatchTimer);
      this.configWatchTimer = undefined;
    }

    const disconnectPromises: Promise<void>[] = [];
    const slots = Array.from(this.slots.values());
    this.slots.clear();

    for (const slot of slots) {
      slot.disposed = true;
      this.cancelReconnect(slot);
      const connections = new Set<ManagedConnection>(slot.draining);
      if (slot.current) {
        connections.add(slot.current);
        slot.current = undefined;
      }

      for (const connection of connections) {
        if (connection.state === 'ready') {
          connection.state = 'draining';
        }
        disconnectPromises.push(this.closeConnection(slot, connection));
      }
    }

    await Promise.allSettled(disconnectPromises);
    this.logger.info('All MCP servers disconnected');
  }
}
