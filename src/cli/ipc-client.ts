import net from 'net';
import { randomUUID } from 'crypto';
import type { IPCRequest, IPCResponse, IPCMethod, RequestContext } from '../types/index.js';
import { stringEnv } from '../daemon/protocol.js';

const DEFAULT_TIMEOUT_MS = 30000;

/**
 * Where this process runs, sent with each request so the daemon answers from
 * the configuration this directory and environment produce - the servers.json
 * of the project the command ran in, with the variables exported in its shell.
 */
export function currentContext(): RequestContext {
  return { cwd: process.cwd(), env: stringEnv(process.env) };
}

/**
 * Sends a request to the daemon via Unix domain socket
 * and waits for the response.
 */
export async function sendRequest(
  socketPath: string,
  method: IPCMethod,
  params?: Record<string, unknown>,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  context: RequestContext = currentContext()
): Promise<IPCResponse> {
  const request: IPCRequest = {
    id: randomUUID(),
    method,
    params,
    context,
  };

  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ path: socketPath });
    let buffer = '';
    let settled = false;

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        socket.destroy();
        reject(new Error(`Request timed out after ${timeoutMs}ms`));
      }
    }, timeoutMs);

    socket.on('connect', () => {
      socket.write(JSON.stringify(request) + '\n');
    });

    socket.on('data', (data) => {
      buffer += data.toString();

      const newlineIndex = buffer.indexOf('\n');
      if (newlineIndex !== -1) {
        const line = buffer.slice(0, newlineIndex);
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          socket.destroy();
          try {
            const response: IPCResponse = JSON.parse(line);
            resolve(response);
          } catch {
            reject(new Error('Invalid response from daemon'));
          }
        }
      }
    });

    socket.on('error', (error) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        if ((error as NodeJS.ErrnoException).code === 'ECONNREFUSED' ||
            (error as NodeJS.ErrnoException).code === 'ENOENT') {
          reject(new Error('Daemon is not running'));
        } else {
          reject(error);
        }
      }
    });

    socket.on('close', () => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(new Error('Connection closed before response'));
      }
    });
  });
}

/**
 * Check if the daemon is reachable by sending a status ping.
 */
export async function isDaemonRunning(socketPath: string): Promise<boolean> {
  try {
    const response = await sendRequest(socketPath, 'daemon-status', { ping: true }, 3000);
    return !response.error;
  } catch {
    return false;
  }
}
