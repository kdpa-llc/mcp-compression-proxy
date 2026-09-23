import { sendRequest, isDaemonRunning } from './ipc-client.js';
import { loadJSONServers } from '../config/loader.js';
import type { ServerStatus, ToolEntry, ToolInfoResult } from '../types/index.js';
import type { SearchQuality } from '../search/usage-log.js';

/**
 * Format tool entries as aligned plain text:
 *   server/tool_name        Short description
 */
function formatToolList(tools: ToolEntry[]): string {
  if (tools.length === 0) return 'No tools found.';

  // Calculate column width for alignment
  const names = tools.map((t) => `${t.server}/${t.tool}`);
  const maxLen = Math.min(Math.max(...names.map((n) => n.length)), 40);

  const lines = tools.map((t) => {
    const name = `${t.server}/${t.tool}`;
    const padded = name.padEnd(maxLen + 4);
    return `${padded}${t.description}`;
  });

  return lines.join('\n');
}

/**
 * Pull `--name value` (or `--name=value`) out of an argument list.
 *
 * Kept here rather than in the entry point, which is excluded from coverage.
 * Returns the remaining arguments in order and the last value given.
 */
export function takeOption(args: string[], name: string): { rest: string[]; value?: string } {
  const rest: string[] = [];
  let value: string | undefined;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === `--${name}`) {
      value = args[index + 1];
      index++;
    } else if (arg.startsWith(`--${name}=`)) {
      value = arg.slice(name.length + 3);
    } else {
      rest.push(arg);
    }
  }
  return { rest, value };
}

/** `--limit N` as a positive integer, or undefined when absent or invalid. */
export function takeLimit(args: string[]): { rest: string[]; limit?: number } {
  const { rest, value } = takeOption(args, 'limit');
  const limit = value === undefined ? NaN : Number.parseInt(value, 10);
  return { rest, limit: Number.isInteger(limit) && limit > 0 ? limit : undefined };
}

/**
 * mcp-cli tools — list all available tools with compressed descriptions
 */
export async function handleTools(socketPath: string): Promise<void> {
  const response = await sendRequest(socketPath, 'tools');

  if (response.error) {
    console.error(`Error: ${response.error.message}`);
    process.exit(1);
  }

  const result = response.result as { tools: ToolEntry[]; count: number };
  console.log(formatToolList(result.tools));

  // Summary line
  const serverCount = new Set(result.tools.map((t) => t.server)).size;
  console.log(`\n(${result.count} tools across ${serverCount} servers)`);
}

/**
 * mcp-cli search <query> — ranked search over tool names and descriptions
 */
export async function handleSearch(
  socketPath: string,
  query: string,
  options: { limit?: number } = {}
): Promise<void> {
  if (!query) {
    console.error('Usage: mcp-cli search <query> [--limit N]');
    process.exit(1);
  }

  const response = await sendRequest(socketPath, 'search', {
    query,
    ...(options.limit !== undefined ? { limit: options.limit } : {}),
  });

  if (response.error) {
    console.error(`Error: ${response.error.message}`);
    process.exit(1);
  }

  const result = response.result as {
    tools: ToolEntry[];
    count: number;
    total?: number;
    signals?: string[];
  };

  if (result.count === 0) {
    console.log(`No tools matching "${query}".`);
    return;
  }

  console.log(formatToolList(result.tools));

  if (result.total !== undefined && result.total > result.count) {
    console.log(
      `\n(best ${result.count} of ${result.total} matches; --limit N shows more)`
    );
  }
}

/**
 * mcp-cli search-quality — how often search ranked the tool the agent used
 */
export async function handleSearchQuality(socketPath: string): Promise<void> {
  const response = await sendRequest(socketPath, 'search-quality');

  if (response.error) {
    console.error(`Error: ${response.error.message}`);
    process.exit(1);
  }

  const quality = response.result as SearchQuality & { enabled: boolean };

  if (!quality.enabled && quality.selections === 0) {
    console.log('Search learning is off. Enable it with "search": { "learnFromUsage": true }');
    console.log('in servers.json; searches followed by info/call are then recorded locally.');
    return;
  }

  console.log(`Recorded choices: ${quality.selections}${quality.enabled ? '' : ' (learning is now off)'}`);
  if (quality.selections === 0) return;
  console.log(`  ranked first:  ${quality.top1} (${quality.top1Rate}%)`);
  console.log(`  in top five:   ${quality.top5} (${quality.top5Rate}%)`);
  console.log(`  not shown:     ${quality.misses} (${quality.missRate}%)`);
  if (quality.topTools.length > 0) {
    console.log('\nMost chosen tools:');
    for (const entry of quality.topTools) {
      console.log(`  ${String(entry.selections).padStart(4)}  ${entry.tool}`);
    }
  }
}

/**
 * mcp-cli info <server>/<tool> — get full schema for a single tool
 */
export async function handleInfo(socketPath: string, serverTool: string): Promise<void> {
  const slashIndex = serverTool.indexOf('/');
  if (slashIndex === -1) {
    console.error('Usage: mcp-cli info <server>/<tool>');
    process.exit(1);
  }

  const server = serverTool.slice(0, slashIndex);
  const tool = serverTool.slice(slashIndex + 1);

  const response = await sendRequest(socketPath, 'info', { server, tool });

  if (response.error) {
    console.error(`Error: ${response.error.message}`);
    process.exit(1);
  }

  const result = response.result as ToolInfoResult;
  console.log(JSON.stringify(result, null, 2));
}

/**
 * mcp-cli call <server>/<tool> '<json>' — execute a tool
 */
export async function handleCall(
  socketPath: string,
  serverTool: string,
  jsonPayload: string
): Promise<void> {
  const slashIndex = serverTool.indexOf('/');
  if (slashIndex === -1) {
    console.error("Usage: mcp-cli call <server>/<tool> '<json_payload>'");
    process.exit(1);
  }

  const server = serverTool.slice(0, slashIndex);
  const tool = serverTool.slice(slashIndex + 1);

  let args: Record<string, unknown> = {};
  if (jsonPayload) {
    try {
      args = JSON.parse(jsonPayload);
    } catch {
      console.error('Error: Invalid JSON payload');
      process.exit(1);
    }
  }

  const response = await sendRequest(socketPath, 'call', {
    server,
    tool,
    arguments: args,
  });

  if (response.error) {
    console.error(`Error: ${response.error.message}`);
    process.exit(1);
  }

  const result = response.result as { output: string; isError?: boolean };
  if (result.isError) {
    console.error(result.output);
    process.exit(1);
  }

  console.log(result.output);
}

export async function handlePayloadRead(
  socketPath: string,
  id: string,
  options: { offset?: number; length?: number; all?: boolean } = {}
): Promise<void> {
  const response = await sendRequest(socketPath, 'payload-read', {
    id,
    ...options,
  });

  if (response.error) {
    console.error(`Error: ${response.error.message}`);
    process.exit(1);
  }

  console.log(JSON.stringify(response.result, null, 2));
}

export async function handlePayloadFind(
  socketPath: string,
  id: string,
  query: string
): Promise<void> {
  const response = await sendRequest(socketPath, 'payload-find', {
    id,
    query,
  });

  if (response.error) {
    console.error(`Error: ${response.error.message}`);
    process.exit(1);
  }

  console.log(JSON.stringify(response.result, null, 2));
}

export async function handleScript(socketPath: string, jsonPayload: string): Promise<void> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonPayload);
  } catch {
    console.error('Error: Invalid JSON script');
    process.exit(1);
  }

  const steps = Array.isArray(parsed) ? parsed : (parsed as { steps?: unknown })?.steps;
  if (!Array.isArray(steps)) {
    console.error('Error: Script must be an array of steps or an object with a steps array');
    process.exit(1);
  }

  const response = await sendRequest(socketPath, 'script', { steps });
  if (response.error) {
    console.error(`Error: ${response.error.message}`);
    process.exit(1);
  }

  console.log(JSON.stringify(response.result, null, 2));
}

/**
 * mcp-cli stats — get compression/server statistics
 */
export async function handleStats(socketPath: string): Promise<void> {
  const response = await sendRequest(socketPath, 'stats');

  if (response.error) {
    console.error(`Error: ${response.error.message}`);
    process.exit(1);
  }

  console.log(JSON.stringify(response.result, null, 2));
}

/**
 * Last `count` lines of a log file's contents.
 *
 * Kept as a pure function so it is testable without a real log on disk - the
 * CLI entry point is excluded from coverage collection, this file is not.
 */
export function tailLines(content: string, count: number): string {
  if (!content) return '';

  // A trailing newline is a terminator, not an empty final line; without this
  // `-n 1` would return a blank.
  const lines = content.replace(/\n$/, '').split('\n');

  return lines.slice(Math.max(0, lines.length - count)).join('\n');
}

/**
 * mcp-cli doctor — validate config and report live backend health
 */
export async function handleDoctor(socketPath: string): Promise<void> {
  let healthy = true;

  console.log('Configuration');

  // Uncached on purpose: a doctor reports what is on disk right now.
  // A schema error throws, and an unformatted stack trace here would bury the
  // one thing the user came for.
  let configuredServers: string[] = [];
  try {
    const config = loadJSONServers();

    if (!config) {
      console.log('  ! No servers.json found (user or project level)');
      console.log('    The proxy will start with management tools only.');
      healthy = false;
    } else {
      configuredServers = config.servers.map((server) => server.name);
      const disabled = config.servers.filter((server) => server.enabled === false).length;

      console.log(
        `  ✓ Loaded ${config.servers.length} server(s)${disabled ? `, ${disabled} disabled` : ''}`
      );
      if (config.excludePatterns.length > 0) {
        console.log(`    excludeTools: ${config.excludePatterns.join(', ')}`);
      }
      if (config.noCompressPatterns.length > 0) {
        console.log(`    noCompressTools: ${config.noCompressPatterns.join(', ')}`);
      }
    }
  } catch (error) {
    console.log('  ✗ Invalid configuration');
    for (const line of String(error instanceof Error ? error.message : error).split('\n')) {
      console.log(`    ${line}`);
    }
    console.log('\nFix the configuration before checking backend health.');
    process.exit(1);
  }

  console.log('\nBackends');

  const response = await sendRequest(socketPath, 'daemon-status');

  if (response.error) {
    console.log(`  ✗ Daemon did not respond: ${response.error.message}`);
    process.exit(1);
  }

  const status = response.result as {
    pid: number;
    servers: Array<{ name: string; connected: boolean; lastError?: string }>;
  };

  for (const server of status.servers) {
    if (server.connected) {
      console.log(`  ✓ ${server.name}`);
    } else {
      console.log(`  ✗ ${server.name}: ${server.lastError || 'not connected'}`);
      healthy = false;
    }
  }

  // A server in the config that the daemon has no record of predates the
  // daemon's own startup, so its warm connections are stale.
  const known = new Set(status.servers.map((server) => server.name));
  const missing = configuredServers.filter((name) => !known.has(name));
  if (missing.length > 0) {
    console.log(`  ! Not known to the running daemon: ${missing.join(', ')}`);
    console.log('    Restart it to pick them up: mcp-cli daemon restart');
    healthy = false;
  }

  console.log(`\n${healthy ? 'All checks passed.' : 'Some checks failed (see above).'}`);

  if (!healthy) {
    process.exit(1);
  }
}

/**
 * mcp-cli daemon status — show daemon status
 */
export async function handleDaemonStatus(socketPath: string): Promise<void> {
  const running = await isDaemonRunning(socketPath);

  if (!running) {
    console.log('Daemon is not running.');
    return;
  }

  const response = await sendRequest(socketPath, 'daemon-status');
  if (response.error) {
    console.error(`Error: ${response.error.message}`);
    process.exit(1);
  }

  const status = response.result as {
    pid: number;
    releaseId?: string;
    uptime: number;
    connectedServers: number;
    totalServers: number;
    cachedToolCount: number;
    socketPath: string;
    servers: ServerStatus[];
  };

  const hours = Math.floor(status.uptime / 3600);
  const minutes = Math.floor((status.uptime % 3600) / 60);
  const uptimeStr = hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;

  console.log(
    `Daemon running (PID ${status.pid}, release ${status.releaseId ?? 'legacy'}, uptime ${uptimeStr})`
  );
  const failed = status.servers.filter((server) => server.state === 'failed');
  const inactive = status.servers.filter(
    (server) => !server.connected && server.state !== 'failed'
  );
  console.log(
    `Servers: ${status.connectedServers} connected, ${inactive.length} inactive, ${failed.length} failed`
  );
  console.log(`Tools: ${status.cachedToolCount} cached`);
  console.log(`Socket: ${status.socketPath}`);

  if (status.servers.length > 0) {
    console.log('\nConnection lifecycle:');
    for (const server of status.servers) {
      const details = [
        `state=${server.state ?? (server.connected ? 'ready' : 'failed')}`,
        server.generation ? `generation=${server.generation}` : undefined,
        server.connectionAgeSeconds !== undefined
          ? `age=${server.connectionAgeSeconds}s`
          : undefined,
        `active=${server.activeCalls ?? 0}`,
        `recycles=${server.recycleCount ?? 0}`,
        `auth-resets=${server.authInvalidations ?? 0}`,
        `failures=${server.consecutiveFailures ?? 0}`,
      ].filter((value): value is string => value !== undefined);
      console.log(`  - ${server.name}: ${details.join(', ')}`);
      if (server.lastError) {
        console.log(`    last error: ${server.lastError}`);
      }
    }
  }
}
