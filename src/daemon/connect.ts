import { isDaemonRunning } from '../cli/ipc-client.js';
import { attachToDaemon, type BridgeOptions, type BridgeResult } from './bridge.js';

export interface ConnectOptions extends BridgeOptions {
  /** Start a daemon when none answers; without it, a missing daemon is a failure. */
  launch?: () => Promise<boolean>;
  /** How long to wait for a daemon making way for this version to exit. */
  stopWaitMs?: number;
  isRunning?: (socketPath: string) => Promise<boolean>;
}

/** No daemon listening: the socket is missing, or left behind by a dead one. */
function noDaemon(reason: string): boolean {
  return /ENOENT|ECONNREFUSED/.test(reason);
}

/**
 * Attach to the daemon, starting one if none is running or the running one
 * is exiting to make way for this version. Anything else - another version
 * still serving sessions, a daemon that will not start - is reported, and
 * the caller runs its backends itself.
 */
export async function connectToDaemon(options: ConnectOptions): Promise<BridgeResult> {
  const first = await attachToDaemon(options);
  if (first.attached || !options.launch || !(first.stopping || noDaemon(first.reason))) {
    return first;
  }

  if (first.stopping) {
    const isRunning = options.isRunning ?? isDaemonRunning;
    const deadline = Date.now() + (options.stopWaitMs ?? 5000);
    while (Date.now() < deadline && (await isRunning(options.socketPath))) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  if (!(await options.launch())) {
    return { attached: false, reason: 'The daemon did not start; see its log' };
  }
  return attachToDaemon(options);
}
