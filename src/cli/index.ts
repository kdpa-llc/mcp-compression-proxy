#!/usr/bin/env node

import { spawn } from 'child_process';
import {
  existsSync,
  readFileSync,
  unlinkSync,
  statSync,
  openSync,
  readSync,
  closeSync,
} from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { homedir } from 'os';
import { isDaemonRunning } from './ipc-client.js';
import { isManagedRouterConfigured, managedRouterUnavailableMessage } from './runtime-mode.js';
import {
  handleTools,
  handleSearch,
  handleInfo,
  handleCall,
  handlePayloadRead,
  handlePayloadFind,
  handleScript,
  handleStats,
  handleDaemonStatus,
  handleDoctor,
  tailLines,
} from './commands.js';

const BASE_DIR = join(homedir(), '.mcp-compression-proxy');
const SOCKET_PATH = join(BASE_DIR, 'daemon.sock');
const PID_FILE = join(BASE_DIR, 'daemon.pid');
const READY_FILE = join(BASE_DIR, 'daemon.ready');
const LOG_FILE = join(BASE_DIR, 'daemon.log');

const USAGE = `
mcp-cli — Progressive MCP tool discovery for LLMs

Usage:
  mcp-cli tools                        List all tools (compressed)
  mcp-cli search <query>               Search tools by name/description
  mcp-cli info <server>/<tool>         Get full schema for a tool
  mcp-cli call <server>/<tool> <json>  Execute a tool
  mcp-cli output read <id> [offset] [length|all]
                                        Read cached large output
  mcp-cli output find <id> <query>      Find text in cached large output
  mcp-cli script <json>                 Run a declarative MCP call chain
  mcp-cli stats                        Show compression statistics
  mcp-cli doctor                       Check config and backend health
  mcp-cli daemon start                 Start the background daemon
  mcp-cli daemon stop                  Stop the daemon
  mcp-cli daemon restart               Restart the daemon
  mcp-cli daemon status                Show daemon status
  mcp-cli daemon logs [-n N] [-f]      Show daemon logs (default: last 50)
  mcp-cli help                         Show this help

Options:
  --no-auto-start    Don't auto-start daemon
`.trim();

/**
 * Start the daemon as a background process.
 * Forks the daemon.ts module with detached: true.
 */
async function startDaemon(): Promise<boolean> {
  if (isManagedRouterConfigured(BASE_DIR)) {
    console.error(
      'Error: This installation uses the managed MCP router. Refusing to start a legacy daemon on the stable socket.'
    );
    return false;
  }
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = dirname(__filename);
  const daemonScript = join(__dirname, 'daemon.js');

  if (!existsSync(daemonScript)) {
    console.error(`Error: Daemon script not found at ${daemonScript}`);
    console.error('Run "npm run build" first.');
    return false;
  }

  // Clean up stale ready file
  if (existsSync(READY_FILE)) {
    unlinkSync(READY_FILE);
  }

  // spawn, not fork: fork opens an IPC channel to the child, and that channel
  // keeps this process's event loop alive even after child.unref(), so
  // `mcp-cli daemon start` printed its success message and then hung forever.
  // The daemon never uses process.send(), so the channel was pure overhead.
  const child = spawn(process.execPath, [daemonScript], {
    detached: true,
    stdio: 'ignore',
  });

  child.unref();

  // Wait for the daemon to be ready (socket available)
  const maxWaitMs = 15000;
  const pollIntervalMs = 200;
  const startTime = Date.now();

  while (Date.now() - startTime < maxWaitMs) {
    if (existsSync(READY_FILE)) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }

  // Fallback: check if socket is reachable
  return isDaemonRunning(SOCKET_PATH);
}

/** Remove the socket, PID and ready markers left behind by a dead daemon. */
function cleanupDaemonFiles(): void {
  for (const file of [PID_FILE, SOCKET_PATH, READY_FILE]) {
    try {
      unlinkSync(file);
    } catch {
      /* ignore */
    }
  }
}

/**
 * Stop the daemon by sending SIGTERM and waiting for it to actually exit.
 */
async function stopDaemon(): Promise<boolean> {
  if (!existsSync(PID_FILE)) {
    console.log('Daemon is not running (no PID file).');
    return false;
  }

  const pid = Number.parseInt(readFileSync(PID_FILE, 'utf-8').trim(), 10);

  // A truncated or corrupt PID file yields NaN, and process.kill(NaN) throws
  // ERR_INVALID_ARG_TYPE rather than ESRCH - which would escape the handler
  // below and surface as a stack trace instead of a stale-file message.
  if (!Number.isInteger(pid) || pid <= 0) {
    cleanupDaemonFiles();
    console.log('Daemon is not running (corrupt PID file cleaned up).');
    return false;
  }

  // A PID alone is not proof this is our daemon: if it died without cleaning
  // up, the OS may have recycled the number for an unrelated process, and
  // signalling that would kill something we do not own. Only trust the PID
  // when the daemon also answers on its socket.
  if (!(await isDaemonRunning(SOCKET_PATH))) {
    cleanupDaemonFiles();
    console.log('Daemon was not running (stale PID file cleaned up).');
    return false;
  }

  try {
    process.kill(pid, 'SIGTERM');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') {
      cleanupDaemonFiles();
      console.log('Daemon was not running (stale PID file cleaned up).');
      return false;
    }
    throw error;
  }

  // Shutdown disconnects every backend server first, so the process does not
  // exit immediately. Reporting success too early lets a follow-up `daemon
  // start` race the old daemon, which still owns the socket.
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch {
      cleanupDaemonFiles();
      console.log(`Daemon stopped (PID ${pid}).`);
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  console.error(`Daemon (PID ${pid}) did not exit within 10s; it may still be shutting down.`);
  return false;
}

/**
 * Print the tail of the daemon log, optionally following it.
 *
 * Polls rather than shelling out to `tail`: spawning it drags in platform
 * differences (BSD vs GNU flags) for something this file can do itself, and a
 * dependency for it would be worse still.
 */
async function showLogs(args: string[]): Promise<void> {
  const follow = args.includes('-f') || args.includes('--follow');

  const countIndex = args.findIndex((arg) => arg === '-n' || arg === '--lines');
  const requested = countIndex === -1 ? NaN : Number.parseInt(args[countIndex + 1] ?? '', 10);
  const count = Number.isInteger(requested) && requested > 0 ? requested : 50;

  if (!existsSync(LOG_FILE)) {
    console.error(`No daemon log at ${LOG_FILE}.`);
    console.error('The daemon writes it on first start: mcp-cli daemon start');
    process.exit(1);
  }

  console.log(tailLines(readFileSync(LOG_FILE, 'utf-8'), count));

  if (!follow) return;

  // Track the offset rather than re-reading the file: a long-running daemon's
  // log is appended to constantly.
  let offset = statSync(LOG_FILE).size;

  await new Promise<void>((resolve) => {
    const timer = setInterval(() => {
      let size: number;
      try {
        size = statSync(LOG_FILE).size;
      } catch {
        return; // rotated out from under us; pick it up on the next tick
      }

      // Truncation or rotation resets the file, so start over rather than
      // seeking past the end and printing nothing forever.
      if (size < offset) {
        offset = 0;
      }
      if (size === offset) return;

      const handle = openSync(LOG_FILE, 'r');
      try {
        const buffer = Buffer.alloc(size - offset);
        readSync(handle, buffer, 0, buffer.length, offset);
        process.stdout.write(buffer.toString('utf-8'));
        offset = size;
      } finally {
        closeSync(handle);
      }
    }, 500);

    // Housekeeping must never be the reason this process cannot exit.
    timer.unref?.();

    const stop = () => {
      clearInterval(timer);
      process.off('SIGINT', stop);
      process.off('SIGTERM', stop);
      resolve();
    };

    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
  });
}

/**
 * Ensure daemon is running, auto-starting if needed.
 */
async function ensureDaemon(noAutoStart: boolean): Promise<void> {
  const running = await isDaemonRunning(SOCKET_PATH);
  if (running) return;

  if (isManagedRouterConfigured(BASE_DIR)) {
    console.error(`Error: ${managedRouterUnavailableMessage()}`);
    process.exit(1);
  }

  if (noAutoStart) {
    console.error('Error: Daemon is not running. Start it with: mcp-cli daemon start');
    process.exit(1);
  }

  console.error('Daemon not running. Starting...');
  const started = await startDaemon();
  if (!started) {
    console.error('Error: Failed to start daemon. Try manually: mcp-cli daemon start');
    process.exit(1);
  }
  console.error('Daemon started.');
}

/**
 * Read JSON payload from stdin if available.
 */
async function readStdin(): Promise<string | null> {
  if (process.stdin.isTTY) return null;

  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf-8');

    // Give up after 1s rather than hanging on a pipe that never closes. The
    // timer is unref'd and cleared so it cannot keep the CLI alive after
    // stdin has already ended.
    const timer = setTimeout(() => resolve(data.trim() || null), 1000);
    timer.unref?.();

    process.stdin.on('data', (chunk) => {
      data += chunk;
    });
    process.stdin.on('end', () => {
      clearTimeout(timer);
      resolve(data.trim() || null);
    });
  });
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const noAutoStart = args.includes('--no-auto-start');
  const filteredArgs = args.filter((a) => a !== '--no-auto-start');

  const command = filteredArgs[0];

  if (!command || command === 'help' || command === '--help' || command === '-h') {
    console.log(USAGE);
    return;
  }

  // Daemon management commands don't need a running daemon
  if (command === 'daemon') {
    const action = filteredArgs[1];

    switch (action) {
      case 'start': {
        const running = await isDaemonRunning(SOCKET_PATH);
        if (running) {
          console.log('Daemon is already running.');
          return;
        }
        const started = await startDaemon();
        if (started) {
          // Get connection info
          const response = await (
            await import('./ipc-client.js')
          ).sendRequest(SOCKET_PATH, 'daemon-status');
          if (!response.error) {
            const status = response.result as {
              pid: number;
              connectedServers: number;
              totalServers: number;
            };
            console.log(
              `Daemon started (PID ${status.pid}). Connected to ${status.connectedServers}/${status.totalServers} servers.`
            );
          } else {
            console.log('Daemon started.');
          }
        } else {
          console.error('Failed to start daemon.');
          process.exit(1);
        }
        return;
      }

      case 'stop':
        await stopDaemon();
        return;

      case 'restart': {
        // stopDaemon() returning false just means nothing was running, which
        // is a fine state to start from.
        await stopDaemon();

        const started = await startDaemon();
        if (!started) {
          console.error('Failed to start daemon.');
          process.exit(1);
        }
        console.log('Daemon restarted.');
        return;
      }

      case 'status':
        await handleDaemonStatus(SOCKET_PATH);
        return;

      case 'logs':
        await showLogs(filteredArgs.slice(2));
        return;

      default:
        console.error('Usage: mcp-cli daemon <start|stop|restart|status|logs>');
        process.exit(1);
    }
  }

  // All other commands require a running daemon
  await ensureDaemon(noAutoStart);

  switch (command) {
    case 'tools':
      await handleTools(SOCKET_PATH);
      break;

    case 'search':
      await handleSearch(SOCKET_PATH, filteredArgs.slice(1).join(' '));
      break;

    case 'info':
      if (!filteredArgs[1]) {
        console.error('Usage: mcp-cli info <server>/<tool>');
        process.exit(1);
      }
      await handleInfo(SOCKET_PATH, filteredArgs[1]);
      break;

    case 'call': {
      if (!filteredArgs[1]) {
        console.error("Usage: mcp-cli call <server>/<tool> '<json_payload>'");
        process.exit(1);
      }
      // Payload from args or stdin
      let payload = filteredArgs[2] || '';
      if (!payload) {
        const stdinData = await readStdin();
        if (stdinData) payload = stdinData;
      }
      if (!payload) payload = '{}';
      await handleCall(SOCKET_PATH, filteredArgs[1], payload);
      break;
    }

    case 'output': {
      const action = filteredArgs[1];
      const id = filteredArgs[2];
      if (!id || (action !== 'read' && action !== 'find')) {
        console.error('Usage: mcp-cli output <read|find> <payload-id> ...');
        process.exit(1);
      }

      if (action === 'find') {
        const query = filteredArgs.slice(3).join(' ');
        if (!query) {
          console.error('Usage: mcp-cli output find <payload-id> <query>');
          process.exit(1);
        }
        await handlePayloadFind(SOCKET_PATH, id, query);
        break;
      }

      const offset =
        filteredArgs[3] === undefined ? undefined : Number.parseInt(filteredArgs[3], 10);
      const lengthArg = filteredArgs[4];
      const all = lengthArg === 'all';
      const length = lengthArg && !all ? Number.parseInt(lengthArg, 10) : undefined;
      await handlePayloadRead(SOCKET_PATH, id, {
        offset: Number.isFinite(offset) ? offset : undefined,
        length: Number.isFinite(length) ? length : undefined,
        all,
      });
      break;
    }

    case 'script': {
      let payload = filteredArgs[1] || '';
      if (!payload) {
        const stdinData = await readStdin();
        if (stdinData) payload = stdinData;
      }
      if (!payload) {
        console.error('Usage: mcp-cli script <json>');
        process.exit(1);
      }
      await handleScript(SOCKET_PATH, payload);
      break;
    }

    case 'stats':
      await handleStats(SOCKET_PATH);
      break;

    case 'doctor':
      await handleDoctor(SOCKET_PATH);
      break;

    default:
      console.error(`Unknown command: ${command}\n`);
      console.log(USAGE);
      process.exit(1);
  }
}

main().catch((error) => {
  console.error(`Error: ${error.message || error}`);
  process.exit(1);
});
