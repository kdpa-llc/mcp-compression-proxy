import { sendRequest, isDaemonRunning } from './ipc-client.js';
import type { ToolEntry, ToolInfoResult } from '../types/index.js';

/**
 * Format tool entries as aligned plain text:
 *   server/tool_name        Short description
 */
function formatToolList(tools: ToolEntry[]): string {
  if (tools.length === 0) return 'No tools found.';

  // Calculate column width for alignment
  const names = tools.map(t => `${t.server}/${t.tool}`);
  const maxLen = Math.min(Math.max(...names.map(n => n.length)), 40);

  const lines = tools.map(t => {
    const name = `${t.server}/${t.tool}`;
    const padded = name.padEnd(maxLen + 4);
    return `${padded}${t.description}`;
  });

  return lines.join('\n');
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
  const serverCount = new Set(result.tools.map(t => t.server)).size;
  console.log(`\n(${result.count} tools across ${serverCount} servers)`);
}

/**
 * mcp-cli search <query> — search tools by name or description
 */
export async function handleSearch(socketPath: string, query: string): Promise<void> {
  if (!query) {
    console.error('Usage: mcp-cli search <query>');
    process.exit(1);
  }

  const response = await sendRequest(socketPath, 'search', { query });

  if (response.error) {
    console.error(`Error: ${response.error.message}`);
    process.exit(1);
  }

  const result = response.result as { tools: ToolEntry[]; count: number };

  if (result.count === 0) {
    console.log(`No tools matching "${query}".`);
    return;
  }

  console.log(formatToolList(result.tools));
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
    console.error('Usage: mcp-cli call <server>/<tool> \'<json_payload>\'');
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
    uptime: number;
    connectedServers: number;
    totalServers: number;
    cachedToolCount: number;
    socketPath: string;
    servers: Array<{ name: string; connected: boolean; lastError?: string }>;
  };

  const hours = Math.floor(status.uptime / 3600);
  const minutes = Math.floor((status.uptime % 3600) / 60);
  const uptimeStr = hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;

  console.log(`Daemon running (PID ${status.pid}, uptime ${uptimeStr})`);
  console.log(`Servers: ${status.connectedServers} connected, ${status.totalServers - status.connectedServers} failed`);
  console.log(`Tools: ${status.cachedToolCount} cached`);
  console.log(`Socket: ${status.socketPath}`);

  // Show failed servers
  const failed = status.servers.filter(s => !s.connected);
  if (failed.length > 0) {
    console.log('\nFailed servers:');
    for (const s of failed) {
      console.log(`  - ${s.name}: ${s.lastError || 'unknown error'}`);
    }
  }
}
