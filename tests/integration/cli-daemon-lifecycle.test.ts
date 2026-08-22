import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import { execFile } from 'child_process';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

/**
 * End-to-end lifecycle of the mcp-cli daemon.
 *
 * These run the built CLI as a real subprocess, because the bugs this guards
 * against are process-level and invisible to a unit test: `daemon start` once
 * returned its success message but never exited, and a failed listen killed
 * the daemon with nothing written to the log.
 */
describe('mcp-cli daemon lifecycle', () => {
  const repoRoot = process.cwd();
  const cliPath = join(repoRoot, 'dist/cli/index.js');
  let testHome: string;

  /** Run the CLI with an isolated HOME, resolving even on a non-zero exit. */
  function runCli(
    args: string[],
    timeoutMs = 30000
  ): Promise<{ code: number | null; stdout: string; stderr: string }> {
    return new Promise((resolve) => {
      const child = execFile(
        process.execPath,
        [cliPath, ...args],
        { env: { ...process.env, HOME: testHome }, timeout: timeoutMs },
        (error, stdout, stderr) => {
          const code =
            error && typeof (error as { code?: unknown }).code === 'number'
              ? ((error as { code: number }).code)
              : error
                ? 1
                : 0;
          resolve({ code, stdout, stderr });
        }
      );
      // Nothing is ever written to the CLI's stdin here; close it so a command
      // that falls back to reading stdin does not wait on us.
      child.stdin?.end();
    });
  }

  beforeAll(() => {
    // Deliberately short: Unix domain socket paths are capped near 107 bytes,
    // and jest's own tmp paths can be long enough to blow that limit.
    testHome = mkdtempSync(join(tmpdir(), 'mcpd-'));
    mkdirSync(join(testHome, '.mcp-compression-proxy'), { recursive: true });

    writeFileSync(
      join(testHome, '.mcp-compression-proxy', 'servers.json'),
      JSON.stringify({
        mcpServers: [
          {
            name: 'local-skills',
            command: 'node',
            args: [join(repoRoot, 'tests/__mocks__/single-tool-server.js')],
            enabled: true,
          },
        ],
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

  it('starts the daemon and exits', async () => {
    const result = await runCli(['daemon', 'start']);

    // A non-zero/null code here usually means the process hung until the
    // timeout: fork's IPC channel used to keep the parent alive forever.
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('Daemon started');

    const dir = join(testHome, '.mcp-compression-proxy');
    expect(existsSync(join(dir, 'daemon.sock'))).toBe(true);
    expect(existsSync(join(dir, 'daemon.pid'))).toBe(true);
  }, 45000);

  it('reports status for the running daemon', async () => {
    const result = await runCli(['daemon', 'status']);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain('Daemon running');
    expect(result.stdout).toContain('1 connected');
  }, 30000);

  it('lists tools from the backend server', async () => {
    const result = await runCli(['tools']);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain('local-skills/single_tool');
  }, 30000);

  it('is idempotent - starting again reports already running', async () => {
    const result = await runCli(['daemon', 'start']);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain('already running');
  }, 30000);

  it('stops the daemon and cleans up its files', async () => {
    const result = await runCli(['daemon', 'stop'], 25000);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain('Daemon stopped');

    // stopDaemon waits for the process to actually exit before reporting
    // success, so the socket and PID file must be gone by now.
    const dir = join(testHome, '.mcp-compression-proxy');
    expect(existsSync(join(dir, 'daemon.sock'))).toBe(false);
    expect(existsSync(join(dir, 'daemon.pid'))).toBe(false);
  }, 40000);

  it('reports a stopped daemon rather than failing', async () => {
    const result = await runCli(['daemon', 'stop']);

    expect(result.stdout).toContain('not running');
  }, 30000);

  it('cleans up a corrupt PID file instead of crashing', async () => {
    const dir = join(testHome, '.mcp-compression-proxy');
    writeFileSync(join(dir, 'daemon.pid'), 'not-a-number');

    const result = await runCli(['daemon', 'stop']);

    // process.kill(NaN) throws ERR_INVALID_ARG_TYPE, which is not ESRCH and
    // would otherwise escape as a stack trace.
    expect(result.stdout).toContain('not running');
    expect(result.stderr).not.toContain('ERR_INVALID_ARG_TYPE');
    expect(existsSync(join(dir, 'daemon.pid'))).toBe(false);
  }, 30000);
});
