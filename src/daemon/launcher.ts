import { spawn, type ChildProcess, type SpawnOptions } from 'child_process';
import { readFileSync, unlinkSync, writeFileSync } from 'fs';
import { isDaemonRunning } from '../cli/ipc-client.js';

type SpawnFn = (command: string, args: string[], options: SpawnOptions) => ChildProcess;

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: it exists but belongs to someone else, which still means taken.
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Take the daemon's PID file, or report that another live daemon holds it.
 *
 * Created exclusively, so of two daemons starting at once only one wins;
 * without this the second would unlink the first one's socket and listen in
 * its place, leaving the first running with no way to reach it. A file left
 * by a daemon that died is taken over.
 */
export function claimPidFile(pidFile: string, pid = process.pid): boolean {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      writeFileSync(pidFile, String(pid), { flag: 'wx', mode: 0o600 });
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    let holder = Number.NaN;
    try {
      holder = Number.parseInt(readFileSync(pidFile, 'utf-8').trim(), 10);
    } catch {
      // Removed between our write and read: try again.
    }
    if (Number.isInteger(holder) && holder > 0 && holder !== pid && alive(holder)) {
      return false;
    }
    try {
      unlinkSync(pidFile);
    } catch {
      // Someone else cleaned it up first.
    }
  }
  return false;
}

/**
 * Start a daemon in the background and wait until it answers on its socket.
 * Resolves false if it does not within the timeout. Safe to race: if another
 * daemon wins the PID file, this one exits and the other answers instead.
 */
export async function launchDaemon(options: {
  daemonScript: string;
  socketPath: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  spawnFn?: SpawnFn;
}): Promise<boolean> {
  const spawnFn = options.spawnFn ?? spawn;
  // spawn, not fork: fork opens an IPC channel that keeps this process alive.
  const child = spawnFn(process.execPath, [options.daemonScript], {
    detached: true,
    stdio: 'ignore',
    env: options.env ?? process.env,
  });
  child.unref();

  const deadline = Date.now() + (options.timeoutMs ?? 15_000);
  while (Date.now() < deadline) {
    if (await isDaemonRunning(options.socketPath)) return true;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  return false;
}
