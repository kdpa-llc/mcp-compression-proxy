import { testProcessEnv } from '../helpers/test-process-env.js';
/**
 * The proxy in backendMode "daemon": several MCP clients, each with its own
 * proxy process, served by one daemon that runs each backend once. Runs the
 * built proxy, daemon and CLI as real processes.
 */

import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import { execFile } from 'child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

const repoRoot = process.cwd();
const proxyPath = join(repoRoot, 'dist/index.js');
const cliPath = join(repoRoot, 'dist/cli/index.js');
const mockServer = join(repoRoot, 'tests/__mocks__/multi-tool-server.js');

function textOf(result: unknown): string {
  return ((result as CallToolResult).content ?? [])
    .map((item) => (item.type === 'text' ? item.text : ''))
    .join('');
}

function writeConfig(home: string, config: Record<string, unknown>): void {
  mkdirSync(join(home, '.mcp-compression-proxy'), { recursive: true });
  writeFileSync(join(home, '.mcp-compression-proxy', 'servers.json'), JSON.stringify(config));
}

function runCli(env: NodeJS.ProcessEnv, args: string[]): Promise<{ code: number; stdout: string }> {
  return new Promise((resolve) => {
    const child = execFile(process.execPath, [cliPath, ...args], { env, timeout: 30_000 }, (error, stdout) =>
      resolve({ code: error ? 1 : 0, stdout })
    );
    child.stdin?.end();
  });
}

async function connect(env: NodeJS.ProcessEnv): Promise<Client> {
  const client = new Client({ name: 'shared-daemon-test', version: '1.0.0' }, { capabilities: {} });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [proxyPath], env: env as Record<string, string> }));
  return client;
}

const pidOf = async (client: Client) =>
  textOf(await client.callTool({ name: 'mock__tool_000', arguments: { input: '@pid' } }));

describe('proxy in backendMode "daemon"', () => {
  let home: string;
  let env: NodeJS.ProcessEnv;
  const clients: Client[] = [];

  beforeAll(() => {
    // Short: Unix socket paths are capped near 107 bytes.
    home = mkdtempSync(join(tmpdir(), 'mcpsd-'));
    writeConfig(home, {
      backendMode: 'daemon',
      mcpServers: [{ name: 'mock', command: process.execPath, args: [mockServer] }],
    });
    // Every client below gets exactly this environment, so they share backends.
    env = { ...testProcessEnv(home), LOG_LEVEL: 'error' };
  });

  afterAll(async () => {
    await Promise.allSettled(clients.map((client) => client.close()));
    if (existsSync(join(home, '.mcp-compression-proxy', 'daemon.pid'))) {
      await runCli(env, ['daemon', 'stop']);
    }
    rmSync(home, { recursive: true, force: true });
  });

  it('starts one daemon for two clients, which share one backend process', async () => {
    clients.push(await connect(env), await connect(env));
    const [a, b] = clients;

    expect((await a.listTools()).tools.map((tool) => tool.name)).toContain('mock__tool_002');
    const pid = await pidOf(a);
    expect(pid).toMatch(/^\d+$/);
    expect(await pidOf(b)).toBe(pid);

    const daemonPid = readFileSync(join(home, '.mcp-compression-proxy', 'daemon.pid'), 'utf-8').trim();
    expect(pid).not.toBe(daemonPid);
  }, 60_000);

  it('serves mcp-cli from the same pool, and reports the attached sessions', async () => {
    const called = await runCli(env, ['call', 'mock/tool_000', '{"input":"@pid"}']);
    expect(called.stdout.trim()).toBe(await pidOf(clients[0]));

    const status = await runCli(env, ['daemon', 'status']);
    expect(status.stdout).toContain('Servers: 1 connected');
    expect(status.stdout).toContain('2 MCP session(s) attached');
  }, 60_000);

  it('detaches a client that goes away', async () => {
    await clients.shift()?.close();
    let status = '';
    for (let attempt = 0; attempt < 50; attempt++) {
      status = (await runCli(env, ['daemon', 'status'])).stdout;
      if (status.includes('1 MCP session(s) attached')) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(status).toContain('1 MCP session(s) attached');
    expect(await pidOf(clients[0])).toMatch(/^\d+$/);
  }, 60_000);
});

describe('proxy in backendMode "daemon" without a usable daemon', () => {
  let home: string;

  beforeAll(() => {
    home = mkdtempSync(join(tmpdir(), 'mcpsl-'));
    writeConfig(home, {
      backendMode: 'daemon',
      mcpServers: [{ name: 'mock', command: process.execPath, args: [mockServer] }],
    });
    // The managed router owns the socket here, so the proxy must not start a
    // daemon over it; with none answering, it runs its backends itself.
    writeFileSync(join(home, '.mcp-compression-proxy', 'active-release.json'), '{}');
  });

  afterAll(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it('falls back to running its backends itself', async () => {
    const client = await connect({ ...testProcessEnv(home), LOG_LEVEL: 'error' });
    try {
      expect(textOf(await client.callTool({ name: 'mock__tool_000', arguments: {} }))).toBe(
        'tool_000 executed successfully'
      );
      expect(existsSync(join(home, '.mcp-compression-proxy', 'daemon.pid'))).toBe(false);
    } finally {
      await client.close();
    }
  }, 60_000);
});
