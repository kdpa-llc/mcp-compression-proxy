#!/usr/bin/env node

import { fork } from 'child_process';
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

  const child = fork(daemonScript, [], {
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

/**
 * Stop the daemon by sending SIGTERM.
 */
function stopDaemon(): boolean {
  if (!existsSync(PID_FILE)) {
    console.log('Daemon is not running (no PID file).');
    return false;
  }

  const pid = parseInt(readFileSync(PID_FILE, 'utf-8').trim(), 10);

  try {
    process.kill(pid, 'SIGTERM');
    console.log(`Daemon stopped (PID ${pid}).`);
    return true;
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code === 'ESRCH') {
      // Process doesn't exist — clean up stale files
      try { unlinkSync(PID_FILE); } catch { /* ignore */ }
      try { unlinkSync(SOCKET_PATH); } catch { /* ignore */ }
      try { unlinkSync(READY_FILE); } catch { /* ignore */ }
      console.log('Daemon was not running (stale PID file cleaned up).');
      return false;
    }
    throw error;
  }
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
    process.stdin.on('data', (chunk) => { data += chunk; });
    process.stdin.on('end', () => resolve(data.trim() || null));
    // Timeout after 1s to not hang
    setTimeout(() => resolve(data.trim() || null), 1000);
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
        stopDaemon();
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
