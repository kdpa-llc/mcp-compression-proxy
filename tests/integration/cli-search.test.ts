import { testProcessEnv } from '../helpers/test-process-env.js';
import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import { execFile } from 'child_process';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync, statSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

/**
 * Ranked search, exclusion and usage learning through the real daemon.
 *
 * Each of these crosses the CLI -> socket -> daemon -> backend boundary, which
 * is where the daemon's own copies of listing and exclusion used to drift from
 * the native proxy's.
 */
describe('mcp-cli search and tool policy', () => {
  const repoRoot = process.cwd();
  const cliPath = join(repoRoot, 'dist/cli/index.js');
  let testHome: string;

  function runCli(
    args: string[],
    timeoutMs = 30000
  ): Promise<{ code: number | null; stdout: string; stderr: string }> {
    return new Promise((resolve) => {
      const child = execFile(
        process.execPath,
        [cliPath, ...args],
        {
          env: { ...testProcessEnv(testHome), MOCK_TOOL_COUNT: '3' },
          timeout: timeoutMs,
        },
        (error, stdout, stderr) => {
          const code =
            error && typeof (error as { code?: unknown }).code === 'number'
              ? (error as { code: number }).code
              : error
                ? 1
                : 0;
          resolve({ code, stdout, stderr });
        }
      );
      child.stdin?.end();
    });
  }

  beforeAll(() => {
    testHome = mkdtempSync(join(tmpdir(), 'mcps-'));
    mkdirSync(join(testHome, '.mcp-compression-proxy'), { recursive: true });

    writeFileSync(
      join(testHome, '.mcp-compression-proxy', 'servers.json'),
      JSON.stringify({
        mcpServers: [
          {
            name: 'multi',
            command: 'node',
            args: [join(repoRoot, 'tests/__mocks__/multi-tool-server.js')],
          },
        ],
        excludeTools: ['multi__tool_002'],
        search: { learnFromUsage: true },
      })
    );
  });

  afterAll(async () => {
    if (testHome && existsSync(join(testHome, '.mcp-compression-proxy', 'daemon.pid'))) {
      await runCli(['daemon', 'stop'], 20000);
    }
    if (testHome && existsSync(testHome)) {
      rmSync(testHome, { recursive: true, force: true });
    }
  });

  it('ranks the exactly named tool first and hides excluded tools', async () => {
    const result = await runCli(['search', 'tool_001']);

    expect(result.code).toBe(0);
    const lines = result.stdout.trim().split('\n');
    expect(lines[0]).toMatch(/^multi\/tool_001\s/);
    expect(result.stdout).not.toContain('tool_002');
  }, 45000);

  it('refuses to call or describe an excluded tool', async () => {
    const call = await runCli(['call', 'multi/tool_002', '{}']);
    expect(call.code).toBe(1);
    expect(call.stderr).toContain('excluded by the excludeTools configuration');
    expect(call.stdout).not.toContain('executed successfully');

    const info = await runCli(['info', 'multi/tool_002']);
    expect(info.code).toBe(1);
    expect(info.stderr).toContain('not found');
  }, 30000);

  it('shows forwarded tool metadata in info', async () => {
    const info = await runCli(['info', 'multi/tool_001']);

    expect(info.code).toBe(0);
    const parsed = JSON.parse(info.stdout) as { title?: string; annotations?: unknown };
    expect(parsed.title).toBe('Tool One');
    expect(parsed.annotations).toEqual({ readOnlyHint: true });
  }, 30000);

  it('learns which result the agent used, in an owner-only log', async () => {
    await runCli(['search', 'tool_000']);
    const call = await runCli(['call', 'multi/tool_000', '{}']);
    expect(call.code).toBe(0);

    const quality = await runCli(['search-quality']);
    expect(quality.code).toBe(0);
    expect(quality.stdout).toMatch(/Recorded choices: [1-9]/);
    expect(quality.stdout).toContain('multi/tool_000');

    const log = join(testHome, '.mcp-compression-proxy', 'search-usage.jsonl');
    expect(statSync(log).mode & 0o777).toBe(0o600);
  }, 30000);
});
