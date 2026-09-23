import { createHash } from 'crypto';
import { homedir } from 'os';
import { resolve } from 'path';
import { DEFAULT_INHERITED_ENV_VARS } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { Logger } from 'pino';
import { matchesIgnorePattern, type ConfigResult } from '../config/loader.js';
import type { MCPServerConfig, ServerStatus } from '../types/index.js';
import { stableJson } from '../utils/stable-json.js';
import type { BackendAccess } from './backend-access.js';
import {
  MCPClientManager,
  buildServerEnv,
  resolveServerConfig,
  type AuthFailureConfirmer,
  type ManagedClientContext,
  type ResolvedServerConfig,
} from './client-manager.js';

/**
 * Environment variables that differ between one shell or terminal and the
 * next without changing what a server does. Two clients whose environments
 * differ only in these can share a backend; any other difference - another
 * token, another AWS_PROFILE - gives each its own.
 */
export const VOLATILE_ENV = [
  '_',
  'PWD',
  'OLDPWD',
  'SHLVL',
  'COLUMNS',
  'LINES',
  'WINDOWID',
  'TMUX_PANE',
  'STY',
  'WT_SESSION',
  'SECURITYSESSIONID',
  'SSH_TTY',
  '*_SESSION_ID',
];

/** Who is asking for backends: one client of the proxy. */
export interface ClientContext {
  /** Unique per client; `share: "session"` servers are scoped to it. */
  id: string;
  /** Where the client runs: the default directory of its spawned servers. */
  cwd: string;
  /** The environment its spawned servers inherit from. */
  env: NodeJS.ProcessEnv;
}

/** A backend as the pool runs it. */
export interface BackendSpec {
  /** A digest of everything that decides sharing; the name is not part of it. */
  id: string;
  /**
   * Fully resolved: environment and working directory included. Its name is
   * the client's name for the server plus the id, a label for logs.
   */
  config: ResolvedServerConfig;
}

/**
 * The environment a spawned server gets, complete. With `inheritEnv: false`
 * the transport would fill in its safe defaults (PATH, HOME, ...) from the
 * process that spawns it - in a daemon, not the client - so they are taken
 * from the client here instead.
 */
function spawnEnv(config: ResolvedServerConfig, clientEnv: NodeJS.ProcessEnv): Record<string, string> {
  const env = buildServerEnv(config, clientEnv) ?? {};
  if (config.inheritEnv !== false) return env;

  const defaults: Record<string, string> = {};
  for (const name of DEFAULT_INHERITED_ENV_VARS) {
    const value = clientEnv[name];
    if (value !== undefined && !value.startsWith('()')) defaults[name] = value;
  }
  return { ...defaults, ...env };
}

/**
 * How one client's server entry runs, and the identity that decides which
 * clients share it.
 *
 * The identity is everything that changes what the server does: command,
 * arguments, working directory, environment (less VOLATILE_ENV and the
 * config's shareIgnoreEnv), URL and headers, and the lifecycle and auth
 * settings. The `share` scope adds the client's id or directory. Equal
 * identity means one process or connection, whichever names clients give it.
 */
export function backendSpec(
  server: MCPServerConfig,
  config: NonNullable<ConfigResult>,
  client: ClientContext
): BackendSpec {
  const resolved = resolveServerConfig(server, config.defaultTimeout, config.inheritEnv, {
    softMaxConnectionAgeSeconds: config.softMaxConnectionAgeSeconds,
    hardMaxConnectionAgeSeconds: config.hardMaxConnectionAgeSeconds,
    authErrorPatterns: config.authErrorPatterns,
    authRetryTools: config.authRetryTools,
  });
  const remote = resolved.url !== undefined;
  const share = resolved.share ?? (remote ? 'global' : 'project');

  let run: ResolvedServerConfig = resolved;
  let identityEnv: Record<string, string> | undefined;
  if (!remote) {
    const env = spawnEnv(resolved, client.env);
    const cwd =
      resolved.cwd !== undefined
        ? resolve(client.cwd, resolved.cwd)
        : share === 'global'
          ? (client.env.HOME ?? homedir())
          : client.cwd;
    run = { ...resolved, env, inheritEnv: false, cwd };
    const ignore = [...VOLATILE_ENV, ...(config.shareIgnoreEnv ?? [])];
    identityEnv = Object.fromEntries(
      Object.entries(env).filter(([name]) => !matchesIgnorePattern(name, ignore))
    );
  }

  const identity = stableJson({
    command: run.command,
    args: run.args,
    cwd: run.cwd,
    env: identityEnv,
    url: run.url,
    headers: run.headers,
    softMaxConnectionAgeSeconds: run.softMaxConnectionAgeSeconds,
    hardMaxConnectionAgeSeconds: run.hardMaxConnectionAgeSeconds,
    authErrorPatterns: run.authErrorPatterns,
    authRetryTools: run.authRetryTools,
    scope: share === 'session' ? client.id : share === 'project' ? client.cwd : undefined,
  });
  const id = createHash('sha256').update(identity).digest('hex').slice(0, 12);
  return { id, config: { ...run, name: `${server.name}#${id}` } };
}

interface PoolEntry {
  spec: BackendSpec;
  holders: Set<string>;
  releaseTimer?: ReturnType<typeof setTimeout>;
}

/**
 * Backend connections shared by every client of one process.
 *
 * Each client holds the backends its configuration describes; a backend runs
 * while any client holds it, and for a grace period after the last lets go,
 * so a client that reconnects does not restart its servers. One
 * MCPClientManager does the connecting, keyed by backend id.
 */
export class BackendPool {
  readonly manager: MCPClientManager;
  private readonly entries = new Map<string, PoolEntry>();
  private readonly holdings = new Map<string, Set<string>>();
  private applying: Promise<void> = Promise.resolve();
  private closed = false;

  constructor(
    readonly logger: Logger,
    private readonly options: { releaseGraceMs?: number; manager?: MCPClientManager } = {}
  ) {
    this.manager = options.manager ?? new MCPClientManager(logger);
  }

  /** A client's view of the pool. Its backends start with the first `apply`. */
  client(
    context: ClientContext,
    options: { authConfirmer?: () => AuthFailureConfirmer | undefined } = {}
  ): PooledBackends {
    return new PooledBackends(this, context, options);
  }

  /**
   * Make these the backends a client holds. Resolves once new ones have
   * connected or failed to, so a caller can wait before listing tools.
   */
  hold(clientId: string, specs: BackendSpec[]): Promise<void> {
    const next = new Set(specs.map((spec) => spec.id));
    for (const spec of specs) {
      let entry = this.entries.get(spec.id);
      if (!entry) {
        entry = { spec, holders: new Set() };
        this.entries.set(spec.id, entry);
      }
      entry.holders.add(clientId);
      if (entry.releaseTimer) {
        clearTimeout(entry.releaseTimer);
        entry.releaseTimer = undefined;
      }
    }
    // A backend the client's own edit dropped stops now if no one else holds
    // it; the grace period is for clients that go away and come back.
    for (const id of this.holdings.get(clientId) ?? []) {
      if (!next.has(id)) this.letGo(clientId, id, 0);
    }
    if (next.size > 0) this.holdings.set(clientId, next);
    else this.holdings.delete(clientId);
    return this.sync();
  }

  /** The client is gone; its backends stop once no one else holds them. */
  release(clientId: string): void {
    const grace = this.options.releaseGraceMs ?? 60_000;
    for (const id of this.holdings.get(clientId) ?? []) this.letGo(clientId, id, grace);
    this.holdings.delete(clientId);
  }

  /**
   * The manager's name for a backend: the name of the first client to hold
   * it, plus its id. Undefined once no one holds it.
   */
  slotName(id: string): string | undefined {
    return this.entries.get(id)?.spec.config.name;
  }

  /** Every backend with the number of clients holding it. */
  statuses(): Array<ServerStatus & { holders: number }> {
    const holders = new Map(
      [...this.entries.values()].map((entry) => [entry.spec.config.name, entry.holders.size])
    );
    return this.manager.getServerStatuses().map((status) => ({
      ...status,
      holders: holders.get(status.name) ?? 0,
    }));
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const entry of this.entries.values()) {
      if (entry.releaseTimer) clearTimeout(entry.releaseTimer);
    }
    this.entries.clear();
    this.holdings.clear();
    await this.applying;
    await this.manager.disconnectAll();
  }

  private letGo(clientId: string, id: string, grace: number): void {
    // A held id always has an entry: entries go only once nobody holds them.
    const entry = this.entries.get(id) as PoolEntry;
    entry.holders.delete(clientId);
    if (entry.holders.size > 0 || entry.releaseTimer) return;

    // Holding the backend again clears the timer, and close() clears every
    // timer, so when this runs the entry is still unheld and still pooled.
    const retire = () => {
      entry.releaseTimer = undefined;
      this.entries.delete(id);
      this.sync().catch((error) =>
        this.logger.error({ error, backend: id }, 'Failed to stop an unused backend')
      );
    };
    if (grace <= 0) {
      retire();
      return;
    }
    entry.releaseTimer = setTimeout(retire, grace);
    // Housekeeping must never be what keeps the process alive.
    entry.releaseTimer.unref?.();
  }

  /** Bring the manager in line with the entries, one reconcile at a time. */
  private sync(): Promise<void> {
    const run = async () => {
      if (this.closed) return;
      await this.manager.reconcile([...this.entries.values()].map((entry) => entry.spec.config));
    };
    this.applying = this.applying.then(run, run);
    return this.applying;
  }
}

/**
 * One client's backends, by the names its configuration uses, with its own
 * `excludeTools`. Every call reaches the shared pool.
 */
export class PooledBackends implements BackendAccess {
  private aliases = new Map<string, string>();
  private excludePatterns: string[] = [];
  private watchTimer: ReturnType<typeof setInterval> | undefined;
  private released = false;

  constructor(
    private readonly pool: BackendPool,
    readonly context: ClientContext,
    private readonly options: { authConfirmer?: () => AuthFailureConfirmer | undefined }
  ) {}

  /** Hold the backends this configuration describes and apply its exclusions. */
  apply(config: ConfigResult): Promise<void> {
    if (this.released) return Promise.resolve();
    // A later entry with the same name wins, as it always has.
    const servers = new Map(
      (config?.servers ?? [])
        .filter((server) => server.enabled !== false)
        .map((server) => [server.name, server])
    );
    const specs = config
      ? [...servers.values()].map((server) => backendSpec(server, config, this.context))
      : [];
    this.aliases = new Map([...servers.keys()].map((name, index) => [name, specs[index].id]));
    this.excludePatterns = [...(config?.excludePatterns ?? [])];
    return this.pool.hold(this.context.id, specs);
  }

  /**
   * Apply the configuration again whenever `config()` returns a new result.
   * Polling: a cached loader returns the same object until its files change.
   */
  watch(config: () => ConfigResult, intervalMs = 5000): void {
    if (this.watchTimer || this.released) return;
    let last = config();
    this.watchTimer = setInterval(() => {
      const next = config();
      if (next === last) return;
      last = next;
      this.apply(next).catch((error) =>
        this.pool.logger.error({ error }, 'Failed to apply backend server configuration')
      );
    }, intervalMs);
    // Housekeeping must never be what keeps the process alive.
    this.watchTimer.unref?.();
  }

  /** Stop watching and let go of every backend. */
  release(): void {
    this.released = true;
    if (this.watchTimer) clearInterval(this.watchTimer);
    this.watchTimer = undefined;
    this.pool.release(this.context.id);
  }

  getConfiguredServerNames(): string[] {
    return [...this.aliases.keys()];
  }

  withClient<T>(
    serverName: string,
    operation: (context: ManagedClientContext) => Promise<T>
  ): Promise<T> {
    const slot = this.slot(serverName);
    if (!slot) {
      return Promise.reject(new Error(`Server '${serverName}' is not configured`));
    }
    return this.pool.manager.withClient(slot, operation);
  }

  isToolExcluded(serverName: string, toolName: string): boolean {
    return matchesIgnorePattern(`${serverName}__${toolName}`, this.excludePatterns);
  }

  getExcludePatterns(): string[] {
    return [...this.excludePatterns];
  }

  getAuthRecoveryPolicy(serverName: string): { authErrorPatterns: string[]; authRetryTools: string[] } {
    const slot = this.slot(serverName);
    return slot
      ? this.pool.manager.getAuthRecoveryPolicy(slot)
      : { authErrorPatterns: [], authRetryTools: [] };
  }

  getAuthFailureConfirmer(): AuthFailureConfirmer | undefined {
    return this.options.authConfirmer?.();
  }

  /** The pool's status of each backend, under this client's name for it. */
  getServerStatuses(): ServerStatus[] {
    const names = new Map(
      [...this.aliases.keys()].flatMap((alias) => {
        const slot = this.slot(alias);
        return slot ? [[slot, alias] as const] : [];
      })
    );
    return this.pool.manager.getServerStatuses().flatMap((status) => {
      const alias = names.get(status.name);
      return alias ? [{ ...status, name: alias }] : [];
    });
  }

  private slot(serverName: string): string | undefined {
    const id = this.aliases.get(serverName);
    return id === undefined ? undefined : this.pool.slotName(id);
  }
}
