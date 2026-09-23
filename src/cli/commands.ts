import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync } from 'fs';
import { dirname, join, relative } from 'path';
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

/** want/where/limit as given on the command line; want stays a JSON string until the daemon parses it. */
export interface ShapeOptions {
  want?: string;
  where?: string;
  limit?: number;
}

/** Pull --want, --where and --limit out of an argument list. */
export function takeShapeOptions(args: string[]): { rest: string[]; shape: ShapeOptions } {
  const want = takeOption(args, 'want');
  const where = takeOption(want.rest, 'where');
  const limit = takeLimit(where.rest);
  return {
    rest: limit.rest,
    shape: {
      ...(want.value !== undefined ? { want: want.value } : {}),
      ...(where.value !== undefined ? { where: where.value } : {}),
      ...(limit.limit !== undefined ? { limit: limit.limit } : {}),
    },
  };
}

function shapeParams(shape: ShapeOptions): Record<string, unknown> {
  const params: Record<string, unknown> = {};
  if (shape.want !== undefined) {
    try {
      params.want = JSON.parse(shape.want);
    } catch {
      console.error('Error: --want must be JSON, e.g. \'{"items":[{"id":"integer","title":"string"}]}\'');
      process.exit(1);
    }
  }
  if (shape.where !== undefined) params.where = shape.where;
  if (shape.limit !== undefined) params.limit = shape.limit;
  return params;
}

/**
 * mcp-cli call <server>/<tool> '<json>' — execute a tool
 */
export async function handleCall(
  socketPath: string,
  serverTool: string,
  jsonPayload: string,
  shape: ShapeOptions = {}
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
    ...shapeParams(shape),
  });

  if (response.error) {
    console.error(`Error: ${response.error.message}`);
    process.exit(1);
  }

  const result = response.result as { output: string; isError?: boolean; shaped?: unknown };
  if (result.isError) {
    console.error(result.output);
    process.exit(1);
  }

  if (result.shaped !== undefined) {
    console.log(JSON.stringify(result.shaped, null, 2));
    return;
  }

  console.log(result.output);
}

/**
 * mcp-cli output shape <id> --want <shape> --where <text> — shape a saved output
 */
export async function handlePayloadShape(
  socketPath: string,
  id: string,
  shape: ShapeOptions
): Promise<void> {
  if (shape.want === undefined && shape.where === undefined) {
    console.error("Usage: mcp-cli output shape <payload-id> [--want '<shape>'] [--where '<text>'] [--limit N]");
    process.exit(1);
  }

  const response = await sendRequest(socketPath, 'payload-shape', { id, ...shapeParams(shape) });

  if (response.error) {
    console.error(`Error: ${response.error.message}`);
    process.exit(1);
  }

  console.log(JSON.stringify(response.result, null, 2));
}

/**
 * mcp-cli suggest <request> [--run] — propose a tool call for a request
 */
export async function handleSuggest(
  socketPath: string,
  request: string,
  options: { run?: boolean; candidates?: number } = {}
): Promise<void> {
  if (!request) {
    console.error('Usage: mcp-cli suggest <what you want to do> [--run] [--limit N]');
    process.exit(1);
  }

  const response = await sendRequest(socketPath, 'suggest', {
    request,
    ...(options.run ? { run: true } : {}),
    ...(options.candidates !== undefined ? { candidates: options.candidates } : {}),
  });

  if (response.error) {
    console.error(`Error: ${response.error.message}`);
    process.exit(1);
  }

  const result = response.result as {
    suggestion: { runnable: boolean; runBlockedBy?: string };
    ran?: { output: string; isError?: boolean };
  };

  if (options.run && !result.ran) {
    console.error(`Not run: ${result.suggestion.runBlockedBy ?? 'no runnable proposal'}`);
  }

  console.log(JSON.stringify(result.suggestion, null, 2));

  if (result.ran) {
    console.log('\n--- output ---');
    if (result.ran.isError) {
      console.error(result.ran.output);
      process.exit(1);
    }
    console.log(result.ran.output);
  }
}

interface AuditReport {
  method: string;
  checked: number;
  confusable: Array<{
    tool: string;
    compressed: string;
    closestTo: string;
    ownSimilarity: number;
    otherSimilarity: number;
  }>;
  duplicates: Array<{ tools: [string, string]; similarity: number }>;
  notes: string[];
  requeued: number;
}

/**
 * mcp-cli audit [--requeue] — check compressed descriptions and find duplicate tools
 */
export async function handleAudit(socketPath: string, options: { requeue?: boolean } = {}): Promise<void> {
  const response = await sendRequest(socketPath, 'audit', options.requeue ? { requeue: true } : {});

  if (response.error) {
    console.error(`Error: ${response.error.message}`);
    process.exit(1);
  }

  const audit = response.result as AuditReport;
  console.log(`Checked ${audit.checked} compressed description(s), compared by ${audit.method === 'semantic' ? 'meaning (local model)' : 'shared words'}.`);

  if (audit.confusable.length === 0) {
    console.log('  ✓ Every compressed description is still closest to its own tool.');
  } else {
    console.log(`  ! ${audit.confusable.length} compressed description(s) now read more like another tool:`);
    for (const finding of audit.confusable) {
      console.log(`    ${finding.tool} -> closer to ${finding.closestTo} (${finding.otherSimilarity} vs ${finding.ownSimilarity})`);
      console.log(`      "${finding.compressed}"`);
    }
    console.log(
      audit.requeued > 0
        ? `    Re-queued ${audit.requeued} for compression.`
        : '    Re-queue them for compression with: mcp-cli audit --requeue'
    );
  }

  if (audit.duplicates.length > 0) {
    console.log(`\nPossible duplicate tools across servers (excluding one saves its whole definition):`);
    for (const duplicate of audit.duplicates) {
      console.log(`  ${duplicate.tools[0]}  ~  ${duplicate.tools[1]}  (${duplicate.similarity})`);
    }
  }

  for (const note of audit.notes) {
    console.log(`\nNote: ${note}`);
  }
}

/**
 * mcp-cli compress [--limit N] — write compressed descriptions with the configured compressor
 */
export async function handleCompress(socketPath: string, options: { limit?: number } = {}): Promise<void> {
  // A batch through a local model can take a while.
  const response = await sendRequest(
    socketPath,
    'compress',
    options.limit !== undefined ? { limit: options.limit } : {},
    600_000
  );

  if (response.error) {
    console.error(`Error: ${response.error.message}`);
    process.exit(1);
  }

  const result = response.result as {
    compressed: number;
    attempted: number;
    batchesFailed: number;
    batchesAttempted: number;
    remaining: number;
  };
  console.log(`Compressed ${result.compressed} of ${result.attempted} tool description(s).`);
  if (result.batchesFailed > 0) {
    console.log(`${result.batchesFailed} of ${result.batchesAttempted} batch(es) produced no usable result; run again to retry.`);
  }
  console.log(
    result.remaining > 0
      ? `${result.remaining} remaining; run mcp-cli compress again.`
      : 'All tools have compressed descriptions.'
  );
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

interface ReviewedEntry {
  server: string;
  tool: string;
  accepted: boolean;
  problems: string[];
  warnings: string[];
  before: { description: string; parameters: Record<string, string> };
  after: { description: string; parameters: Record<string, string> };
  chars: { before: number; after: number };
}

/** A before/after view of reviewed proposals, for the user to approve. */
export function formatReview(review: {
  mode: string;
  method: string;
  reviewed: ReviewedEntry[];
  accepted: number;
  rejected: number;
}): string {
  const lines: string[] = [];
  for (const item of review.reviewed) {
    const name = item.server && item.tool ? `${item.server}/${item.tool}` : '(unnamed entry)';
    lines.push(
      `${item.accepted ? '✓' : '✗'} ${name}  (${item.chars.before} -> ${item.chars.after} chars)`
    );
    if (item.before.description !== item.after.description) {
      lines.push(`    - ${item.before.description || '(none)'}`);
      lines.push(`    + ${item.after.description || '(none)'}`);
    }
    for (const [param, text] of Object.entries(item.after.parameters)) {
      const before = item.before.parameters[param];
      if (before === text) continue;
      lines.push(`    ${param}:`);
      lines.push(`      - ${before || '(none)'}`);
      lines.push(`      + ${text}`);
    }
    for (const problem of item.problems) lines.push(`    ✗ ${problem}`);
    for (const warning of item.warnings) lines.push(`    ! ${warning}`);
  }
  lines.push(
    `\n${review.accepted} accepted, ${review.rejected} rejected (${review.mode}; distinctness checked by ${review.method === 'semantic' ? 'meaning' : 'shared words'}).`
  );
  return lines.join('\n');
}

/**
 * mcp-cli describe next|review|apply|revert — compress or rewrite tool
 * descriptions with the agent's own model, reviewed by the user.
 */
export async function handleDescribe(
  socketPath: string,
  action: string,
  options: {
    mode?: string;
    limit?: number;
    server?: string;
    tool?: string;
    all?: boolean;
    proposals?: string;
  } = {}
): Promise<void> {
  const mode = options.mode === 'compress' ? 'compress' : 'rewrite';
  if (options.mode !== undefined && options.mode !== 'compress' && options.mode !== 'rewrite') {
    console.error('Error: --mode must be compress or rewrite');
    process.exit(1);
  }

  const params: Record<string, unknown> = { action, mode };
  if (action === 'next') {
    if (options.limit !== undefined) params.limit = options.limit;
    if (options.server) params.server = options.server;
    if (options.tool) params.tool = options.tool;
    if (options.all) params.all = true;
  } else if (action === 'review' || action === 'apply') {
    if (!options.proposals) {
      console.error(`Usage: mcp-cli describe ${action} <file.json|-> [--mode compress|rewrite]`);
      process.exit(1);
    }
    try {
      params.proposals = JSON.parse(options.proposals);
    } catch {
      console.error('Error: proposals must be JSON: [{"server":"...","tool":"...","description":"..."}]');
      process.exit(1);
    }
  } else if (action === 'revert') {
    if (!options.all && !options.tool) {
      console.error('Usage: mcp-cli describe revert <server>/<tool> | --all');
      process.exit(1);
    }
    if (options.all) params.all = true;
    else params.tool = options.tool;
  } else {
    console.error('Usage: mcp-cli describe <next|review|apply|revert> ...');
    process.exit(1);
  }

  const response = await sendRequest(socketPath, 'describe', params);
  if (response.error) {
    console.error(`Error: ${response.error.message}`);
    process.exit(1);
  }

  if (action === 'next') {
    console.log(JSON.stringify(response.result, null, 2));
    return;
  }

  if (action === 'revert') {
    const { reverted } = response.result as { reverted: string[] };
    console.log(
      reverted.length > 0
        ? `Reverted ${reverted.length} tool(s) to their original descriptions: ${reverted.join(', ')}`
        : 'Nothing to revert.'
    );
    return;
  }

  const result = response.result as Parameters<typeof formatReview>[0] & { applied?: string[] };
  console.log(formatReview(result));
  if (action === 'apply') {
    console.log(`Applied ${result.applied?.length ?? 0}. Originals are kept; undo with mcp-cli describe revert.`);
  } else if (result.accepted > 0) {
    console.log('Nothing was saved. Apply the accepted ones with: mcp-cli describe apply <file>');
  }
}

/**
 * Copy the bundled skill into a skills directory.
 *
 * Refuses to replace a copy that differs from the bundled one unless forced,
 * so local edits to an installed skill are not silently lost.
 */
export function installSkill(
  sourceDir: string,
  targetDir: string,
  options: { force?: boolean } = {}
): { target: string; status: 'installed' | 'updated' | 'unchanged' } {
  if (!existsSync(join(sourceDir, 'SKILL.md'))) {
    throw new Error(`Bundled skill not found at ${sourceDir}`);
  }

  const files = readdirSync(sourceDir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => relative(sourceDir, join(entry.parentPath, entry.name)));

  if (existsSync(targetDir)) {
    const identical = files.every((file) => {
      const target = join(targetDir, file);
      return existsSync(target) && readFileSync(target, 'utf-8') === readFileSync(join(sourceDir, file), 'utf-8');
    });
    if (identical) return { target: targetDir, status: 'unchanged' };
    if (!options.force) {
      throw new Error(
        `${targetDir} already exists and differs from the bundled skill. Re-run with --force to replace it.`
      );
    }
  }

  const existed = existsSync(targetDir);
  mkdirSync(dirname(targetDir), { recursive: true });
  cpSync(sourceDir, targetDir, { recursive: true, force: true });
  return { target: targetDir, status: existed ? 'updated' : 'installed' };
}
