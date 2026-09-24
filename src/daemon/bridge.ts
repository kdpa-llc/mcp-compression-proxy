import net from 'net';
import type { Readable, Writable } from 'stream';
import { ATTACH_PROTOCOL, readLine, type AttachReply, type AttachRequest } from './protocol.js';

export type BridgeResult =
  | {
      attached: true;
      session: string;
      /** Resolves when the daemon side closes, however that happens. */
      closed: Promise<void>;
    }
  | {
      attached: false;
      reason: string;
      /** From a refusal: why, and whether the daemon is exiting to make way. */
      code?: string;
      stopping?: boolean;
    };

export interface BridgeOptions {
  socketPath: string;
  version: string;
  cwd: string;
  env: Record<string, string>;
  /** The MCP client's side: usually process.stdin and process.stdout. */
  input: Readable;
  output: Writable;
  /** How long to wait for the daemon to connect this client's backends and reply. */
  timeoutMs?: number;
}

/**
 * Attach to the daemon and join it to the MCP client: everything the client
 * writes goes to the daemon's session for it, and everything the session
 * writes comes back. Nothing is read from `input` until the daemon has
 * accepted, so a refused attach leaves the client's messages unread for a
 * local fallback to serve.
 */
export function attachToDaemon(options: BridgeOptions): Promise<BridgeResult> {
  return new Promise((resolve) => {
    const socket = net.createConnection({ path: options.socketPath });
    // Each path below ends the attempt exactly once: a connection error before
    // connecting, then readLine's own outcome, then the reply's.
    const fail = (reason: string, extra: Partial<Extract<BridgeResult, { attached: false }>> = {}) => {
      socket.destroy();
      resolve({ attached: false, reason, ...extra });
    };

    const onConnectError = (error: Error) => fail(error.message);
    socket.once('error', onConnectError);
    socket.once('connect', () => {
      // From here readLine reports errors, and after attaching the relay does.
      socket.off('error', onConnectError);
      const request: AttachRequest = {
        type: 'attach',
        protocol: ATTACH_PROTOCOL,
        version: options.version,
        cwd: options.cwd,
        env: options.env,
      };
      socket.write(JSON.stringify(request) + '\n');

      readLine(socket, { timeoutMs: options.timeoutMs ?? 60_000 }).then(
        ({ line, rest }) => {
          let reply: AttachReply;
          try {
            reply = JSON.parse(line) as AttachReply;
          } catch {
            fail('The daemon sent an unreadable reply');
            return;
          }
          if (reply.type !== 'attached') {
            fail(reply.message, { code: reply.code, stopping: reply.stopping });
            return;
          }

          socket.on('error', () => undefined); // 'close' follows and ends the bridge
          const closed = new Promise<void>((done) => socket.once('close', () => done()));
          if (rest.length > 0) options.output.write(rest);
          socket.pipe(options.output, { end: false });
          options.input.pipe(socket);
          socket.resume();
          resolve({ attached: true, session: reply.session, closed });
        },
        (error: Error) => fail(error.message)
      );
    });
  });
}
