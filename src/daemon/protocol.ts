import type { Duplex } from 'stream';

/**
 * Attaching an MCP session to the daemon.
 *
 * A connector opens the daemon socket and sends one line: an attach request
 * carrying its working directory and environment, from which the daemon
 * builds that client's configuration. The daemon answers with one line, and
 * after `attached` the connection carries MCP JSON-RPC in both directions,
 * exactly as stdio would. A first line that is not an attach request is the
 * mcp-cli request protocol, served as before.
 */
export const ATTACH_PROTOCOL = 1;

export interface AttachRequest {
  type: 'attach';
  protocol: number;
  /** The connector's package version; the daemon serves only its own. */
  version: string;
  cwd: string;
  env: Record<string, string>;
}

export type AttachReply =
  | { type: 'attached'; session: string }
  | {
      type: 'refused';
      code: 'version-mismatch' | 'retiring' | 'bad-request';
      message: string;
      daemonVersion: string;
      /** The daemon is exiting now; a new one can be started right away. */
      stopping?: boolean;
    };

export function isAttachRequest(value: unknown): value is AttachRequest {
  const request = value as Partial<AttachRequest> | null;
  return (
    !!request &&
    typeof request === 'object' &&
    request.type === 'attach' &&
    typeof request.protocol === 'number' &&
    typeof request.version === 'string' &&
    typeof request.cwd === 'string' &&
    !!request.env &&
    typeof request.env === 'object'
  );
}

/** Only the string-valued variables: what a child process can inherit. */
export function stringEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => typeof entry[1] === 'string')
  );
}

/**
 * Read one newline-terminated line from a stream, then stop reading.
 * Resolves with the line and any bytes that arrived after it, which belong
 * to whatever reads the stream next.
 */
export function readLine(
  stream: Duplex,
  options: { maxBytes?: number; timeoutMs?: number } = {}
): Promise<{ line: string; rest: Buffer }> {
  const maxBytes = options.maxBytes ?? 4 * 1024 * 1024;
  return new Promise((resolve, reject) => {
    let buffered = Buffer.alloc(0);
    let timer: ReturnType<typeof setTimeout> | undefined;

    const finish = (error?: Error, result?: { line: string; rest: Buffer }) => {
      stream.off('data', onData);
      stream.off('end', onEnd);
      stream.off('error', onError);
      if (timer) clearTimeout(timer);
      stream.pause();
      if (error) reject(error);
      else resolve(result as { line: string; rest: Buffer });
    };
    const onData = (chunk: Buffer | string) => {
      buffered = Buffer.concat([buffered, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);
      const newline = buffered.indexOf(0x0a);
      if (newline !== -1) {
        finish(undefined, {
          line: buffered.subarray(0, newline).toString('utf-8'),
          rest: buffered.subarray(newline + 1),
        });
      } else if (buffered.length > maxBytes) {
        finish(new Error(`First line exceeds ${maxBytes} bytes`));
      }
    };
    const onEnd = () => finish(new Error('Connection closed before a complete line'));
    const onError = (error: Error) => finish(error);

    if (options.timeoutMs !== undefined) {
      timer = setTimeout(() => finish(new Error(`No reply within ${options.timeoutMs}ms`)), options.timeoutMs);
      timer.unref?.();
    }
    stream.on('data', onData);
    stream.on('end', onEnd);
    stream.on('error', onError);
    stream.resume();
  });
}
