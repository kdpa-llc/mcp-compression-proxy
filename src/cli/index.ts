#!/usr/bin/env node

import { spawn } from 'child_process';
import { existsSync, readFileSync, unlinkSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { homedir } from 'os';
import { isDaemonRunning } from './ipc-client.js';
import {
  handleTools,
  handleSearch,
  handleInfo,
  handleCall,
  handleStats,
  handleDaemonStatus,
} from './commands.js';

const BASE_DIR = join(homedir(), '.mcp-compression-proxy');
const SOCKET_PATH = join(BASE_DIR, 'daemon.sock');
const PID_FILE = join(BASE_DIR, 'daemon.pid');
const READY_FILE = join(BASE_DIR, 'daemon.ready');

const USAGE = `
mcp-cli — Progressive MCP tool discovery for LLMs

Usage:
  mcp-cli tools                        List all tools (compressed)
  mcp-cli search <query>               Search tools by name/description
  mcp-cli info <server>/<tool>         Get full schema for a tool
  mcp-cli call <server>/<tool> <json>  Execute a tool
  mcp-cli stats                        Show compression statistics
  mcp-cli daemon start                 Start the background daemon
  mcp-cli daemon stop                  Stop the daemon
  mcp-cli daemon status                Show daemon status
  mcp-cli help                         Show this help

Options:
  --no-auto-start    Don't auto-start daemon
`.trim();

/**
 * Start the daemon as a background process.
 * Forks the daemon.ts module with detached: true.
 */
async function startDaemon(): Promise<boolean> {
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
    await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
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
 * Ensure daemon is running, auto-starting if needed.
 */
async function ensureDaemon(noAutoStart: boolean): Promise<void> {
  const running = await isDaemonRunning(SOCKET_PATH);
  if (running) return;

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

    process.stdin.on('data', (chunk) => { data += chunk; });
    process.stdin.on('end', () => {
      clearTimeout(timer);
      resolve(data.trim() || null);
    });
  });
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const noAutoStart = args.includes('--no-auto-start');
  const filteredArgs = args.filter(a => a !== '--no-auto-start');

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
          const response = await (await import('./ipc-client.js')).sendRequest(SOCKET_PATH, 'daemon-status');
          if (!response.error) {
            const status = response.result as { pid: number; connectedServers: number; totalServers: number };
            console.log(`Daemon started (PID ${status.pid}). Connected to ${status.connectedServers}/${status.totalServers} servers.`);
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

      case 'status':
        await handleDaemonStatus(SOCKET_PATH);
        return;

      default:
        console.error('Usage: mcp-cli daemon <start|stop|status>');
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
        console.error('Usage: mcp-cli call <server>/<tool> \'<json_payload>\'');
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

    case 'stats':
      await handleStats(SOCKET_PATH);
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
