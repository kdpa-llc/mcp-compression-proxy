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
        // The stand-in bridge: same protocol as python/needle_bridge.py.
        model: {
          provider: 'needle',
          command: process.execPath,
          args: [join(repoRoot, 'tests/__mocks__/fake-model-bridge.js')],
        },
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

  it('indexes tool embeddings through the configured model bridge', async () => {
    const result = await runCli(['search', 'verbose description']);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('multi/tool_000');

    const cache = join(testHome, '.mcp-compression-proxy', 'embeddings.json');
    // Indexing starts in the background at daemon start; give it a moment.
    for (let attempt = 0; attempt < 50 && !existsSync(cache); attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(existsSync(cache)).toBe(true);
    expect(statSync(cache).mode & 0o777).toBe(0o600);
  }, 30000);

  it('returns only the requested fields, then reshapes the saved source', async () => {
    const output = JSON.stringify({
      items: [
        { id: 1, title: 'Login fails with SSO', body: 'x'.repeat(300) },
        { id: 2, title: 'Dark mode', body: 'y'.repeat(300) },
      ],
    });
    const shaped = await runCli([
      'call',
      'multi/tool_000',
      JSON.stringify({ input: output }),
      '--want',
      '{"items":[{"id":"integer","title":"string"}]}',
      '--where',
      'login',
    ]);
    expect(shaped.code).toBe(0);
    const parsed = JSON.parse(shaped.stdout) as {
      data: unknown;
      source: { id: string };
    };
    expect(parsed.data).toEqual({ items: [{ id: 1, title: 'Login fails with SSO' }] });

    const reshaped = await runCli(['output', 'shape', parsed.source.id, '--where', 'dark']);
    expect(reshaped.code).toBe(0);
    expect(JSON.parse(reshaped.stdout).data[0].id).toBe(2);
  }, 30000);

  it('suggests a call with the model bridge and audits compressions', async () => {
    const suggestion = await runCli(['suggest', 'multi', 'tool', '001', 'input=hi']);
    expect(suggestion.code).toBe(0);
    expect(JSON.parse(suggestion.stdout).proposal).toMatchObject({
      tool: 'tool_001',
      arguments: { input: 'hi' },
    });

    const ran = await runCli(['suggest', 'multi', 'tool', '001', 'input=hi', '--run']);
    expect(ran.code).toBe(0);
    expect(ran.stdout).toContain('tool_001 executed successfully');

    const audit = await runCli(['audit']);
    expect(audit.code).toBe(0);
    expect(audit.stdout).toContain('Checked 0 compressed description(s)');
  }, 30000);

  it('explains how to configure a compressor when none is set', async () => {
    const result = await runCli(['compress']);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('No compressor configured');
  }, 30000);

  it('rewrites descriptions through next, review, apply and revert', async () => {
    const next = await runCli(['describe', 'next', '--tool', 'multi/tool_001']);
    expect(next.code).toBe(0);
    const batch = JSON.parse(next.stdout) as {
      items: Array<{ tool: string; parameters: Record<string, unknown> }>;
      guidelines: string[];
    };
    expect(batch.items[0].tool).toBe('tool_001');
    expect(batch.items[0].parameters.input).toMatchObject({ type: 'string' });
    expect(batch.guidelines.length).toBeGreaterThan(0);

    const file = join(testHome, 'proposals.json');
    const good = {
      server: 'multi',
      tool: 'tool_001',
      description: 'Test tool one: echoes a JSON input back, or reports that tool_001 ran.',
      parameters: { input: 'Text to send; JSON is echoed back unchanged' },
    };
    writeFileSync(file, JSON.stringify([good]));

    const review = await runCli(['describe', 'review', file]);
    expect(review.code).toBe(0);
    expect(review.stdout).toContain('+ Test tool one');
    expect(review.stdout).toContain('Nothing was saved');
    expect(JSON.parse((await runCli(['info', 'multi/tool_001'])).stdout).inputSchema.properties.input.description).toBe(
      'Test input parameter'
    );

    // A later, empty entry supersedes the first; neither may be saved.
    writeFileSync(file, JSON.stringify([good, { server: 'multi', tool: 'tool_001', description: '' }]));
    const rejected = await runCli(['describe', 'apply', file]);
    expect(rejected.stdout).toContain('Applied 0');

    writeFileSync(file, JSON.stringify([good]));
    const applied = await runCli(['describe', 'apply', file]);
    expect(applied.code).toBe(0);
    expect(applied.stdout).toContain('Applied 1');

    const info = JSON.parse((await runCli(['info', 'multi/tool_001'])).stdout);
    expect(info.inputSchema.properties.input.description).toBe('Text to send; JSON is echoed back unchanged');
    expect((await runCli(['search', 'echoes'])).stdout).toContain('multi/tool_001');

    const reverted = await runCli(['describe', 'revert', 'multi/tool_001']);
    expect(reverted.stdout).toContain('Reverted 1 tool(s)');
    expect(
      JSON.parse((await runCli(['info', 'multi/tool_001'])).stdout).inputSchema.properties.input.description
    ).toBe('Test input parameter');
  }, 60000);

  it('installs the bundled skill without needing the daemon', async () => {
    const skills = join(testHome, 'skills-root');
    const first = await runCli(['install-skill', '--path', skills]);
    expect(first.code).toBe(0);
    expect(first.stdout).toContain('Installed the mcp-cli skill');
    expect(existsSync(join(skills, 'mcp-cli', 'SKILL.md'))).toBe(true);
    expect(existsSync(join(skills, 'mcp-cli', 'DESCRIBE.md'))).toBe(true);

    const again = await runCli(['install-skill', '--path', skills]);
    expect(again.stdout).toContain('already up to date');
  }, 30000);
});
