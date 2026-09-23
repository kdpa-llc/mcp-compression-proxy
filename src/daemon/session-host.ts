import { randomUUID } from 'crypto';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { PassThrough, type Duplex } from 'stream';
import type { BackendPool } from '../mcp/backend-pool.js';
import type { ModelRegistry } from '../models/model-registry.js';
import { ClientView } from '../proxy/client-view.js';
import { ProxySession } from '../proxy/session.js';
import type { ProxyServices } from '../proxy/view.js';
import { ATTACH_PROTOCOL, type AttachReply, type AttachRequest } from './protocol.js';

export interface SessionHostOptions {
  /** The daemon's package version; clients of another version are refused. */
  version: string;
  pool: BackendPool;
  models: ModelRegistry;
  services: ProxyServices;
  /** Called whenever a session starts or ends, for idle tracking. */
  onActivity?: () => void;
  /**
   * Called when the daemon should exit: a client of another version asked
   * for it and no session is left, now or after the last one closes.
   */
  onRetire?: () => void;
}

interface HostedSession {
  session: ProxySession;
  view: ClientView;
  socket: Duplex;
  cwd: string;
  since: number;
}

/**
 * The MCP sessions a daemon serves, one per attached client.
 *
 * Each gets its own configuration, read from the client's directory and
 * environment, and its own ProxySession, while backends, compression cache,
 * payloads and local models are shared through the pool and services.
 */
export class SessionHost {
  private readonly sessions = new Map<string, HostedSession>();
  private retiring = false;

  constructor(private readonly options: SessionHostOptions) {}

  get size(): number {
    return this.sessions.size;
  }

  /** Attached sessions, for daemon status. */
  status(): Array<{ id: string; cwd: string; since: string }> {
    return [...this.sessions].map(([id, hosted]) => ({
      id,
      cwd: hosted.cwd,
      since: new Date(hosted.since).toISOString(),
    }));
  }

  /**
   * Serve an MCP session on a connection whose first line was this attach
   * request. `rest` is whatever arrived after that line.
   */
  async attach(socket: Duplex, request: AttachRequest, rest: Buffer = Buffer.alloc(0)): Promise<void> {
    const { logger } = this.options.services;
    socket.on('error', (error) => logger.debug({ error: error.message }, 'Session socket error'));

    if (request.protocol !== ATTACH_PROTOCOL || request.version !== this.options.version) {
      // Another release is running now. Make way for it: at once when no one
      // is attached, else once the last session here ends.
      const stopping = this.sessions.size === 0;
      this.retiring = true;
      this.refuse(socket, {
        code: 'version-mismatch',
        message: `This daemon runs version ${this.options.version}; the client runs ${request.version}.`,
        stopping,
      });
      if (stopping) this.options.onRetire?.();
      return;
    }
    if (this.retiring) {
      this.refuse(socket, {
        code: 'retiring',
        message: 'This daemon is making way for another version and takes no new sessions.',
      });
      return;
    }

    const id = randomUUID();
    let gone = false;
    socket.once('close', () => {
      gone = true;
      void this.detach(id);
    });
    const view = new ClientView(
      this.options.pool,
      this.options.models,
      logger,
      { id, cwd: request.cwd, env: request.env }
    );
    await view.ready;
    if (gone) {
      // The client gave up while its backends were connecting.
      view.close();
      return;
    }

    const session = new ProxySession(view, this.options.services, {
      toolsPageSize: Number.parseInt(request.env.MCP_TOOLS_PAGE_SIZE ?? '', 10),
    });
    const hosted: HostedSession = { session, view, socket, cwd: request.cwd, since: Date.now() };
    this.sessions.set(id, hosted);
    this.options.onActivity?.();
    logger.info({ session: id, cwd: request.cwd }, 'MCP session attached');

    // The reply goes out before any MCP message: the client starts speaking
    // MCP only once it has read it.
    socket.write(JSON.stringify({ type: 'attached', session: id } satisfies AttachReply) + '\n');
    const input = new PassThrough();
    if (rest.length > 0) input.write(rest);
    socket.pipe(input);
    await session.connect(new StdioServerTransport(input, socket));
    socket.resume();
  }

  /** End every session and let go of their backends. */
  async closeAll(): Promise<void> {
    await Promise.all([...this.sessions.keys()].map((id) => this.detach(id)));
  }

  private refuse(
    socket: Duplex,
    reply: Omit<Extract<AttachReply, { type: 'refused' }>, 'type' | 'daemonVersion'>
  ): void {
    const refused: AttachReply = { type: 'refused', daemonVersion: this.options.version, ...reply };
    socket.end(JSON.stringify(refused) + '\n');
  }

  private async detach(id: string): Promise<void> {
    const hosted = this.sessions.get(id);
    if (!hosted) return;
    this.sessions.delete(id);
    hosted.view.close();
    hosted.socket.destroy();
    await hosted.session.close();
    this.options.services.logger.info({ session: id }, 'MCP session detached');
    this.options.onActivity?.();
    if (this.retiring && this.sessions.size === 0) this.options.onRetire?.();
  }
}
