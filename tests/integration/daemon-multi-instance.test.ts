import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import { spawn, type ChildProcess } from 'child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { sendRequest } from '../../src/cli/ipc-client.js';

describe('versioned daemon instances', () => {
  const repoRoot = process.cwd();
  const daemonPath = join(repoRoot, 'dist/cli/daemon.js');
  const children: ChildProcess[] = [];
  let testHome: string;
  let baseDir: string;

  async function waitFor(path: string, timeoutMs = 15_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (existsSync(path)) return;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(`Timed out waiting for ${path}`);
  }

  async function startRelease(releaseId: string): Promise<{
    socketPath: string;
    child: ChildProcess;
  }> {
    const runtimeDir = join(baseDir, 'releases', releaseId);
    mkdirSync(runtimeDir, { recursive: true });
    const socketPath = join(runtimeDir, 'daemon.sock');
    const readyFile = join(runtimeDir, 'daemon.ready');

    const child = spawn(process.execPath, [daemonPath], {
      env: {
        ...process.env,
        HOME: testHome,
        MCP_DAEMON_BASE_DIR: baseDir,
        MCP_DAEMON_SOCKET_PATH: socketPath,
        MCP_DAEMON_PID_FILE: join(runtimeDir, 'daemon.pid'),
        MCP_DAEMON_READY_FILE: readyFile,
        MCP_DAEMON_LOG_FILE: join(runtimeDir, 'daemon.log'),
        MCP_DAEMON_RELEASE_ID: releaseId,
      },
      stdio: 'ignore',
    });
    children.push(child);
    await waitFor(readyFile);
    return { socketPath, child };
  }

  beforeAll(() => {
    testHome = mkdtempSync(join(tmpdir(), 'mcp-blue-'));
    baseDir = join(testHome, '.mcp-compression-proxy');
    mkdirSync(baseDir, { recursive: true });
    writeFileSync(
      join(baseDir, 'servers.json'),
      JSON.stringify({
        cli: { payloadThreshold: 10 },
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
    for (const child of children) {
      if (child.exitCode === null) child.kill('SIGTERM');
    }
    await Promise.all(
      children.map((child) =>
        child.exitCode !== null
          ? Promise.resolve()
          : new Promise<void>((resolve) => child.once('close', () => resolve()))
      )
    );
    rmSync(testHome, { recursive: true, force: true });
  });

  it('runs two releases concurrently and shares payload handles', async () => {
    const releaseA = await startRelease('release-a');
    const releaseB = await startRelease('release-b');

    const [statusA, statusB] = await Promise.all([
      sendRequest(releaseA.socketPath, 'daemon-status'),
      sendRequest(releaseB.socketPath, 'daemon-status'),
    ]);
    expect(statusA.result).toEqual(expect.objectContaining({
      releaseId: 'release-a',
    }));
    expect(statusB.result).toEqual(expect.objectContaining({
      releaseId: 'release-b',
    }));

    const call = await sendRequest(releaseA.socketPath, 'call', {
      server: 'local-skills',
      tool: 'single_tool',
      arguments: {},
    });
    const payload = (call.result as {
      payload?: { id: string };
    }).payload;
    expect(payload?.id).toBeDefined();

    const read = await sendRequest(releaseB.socketPath, 'payload-read', {
      id: payload!.id,
      all: true,
    });
    expect(read.result).toEqual(expect.objectContaining({
      content: 'Single tool executed successfully',
      eof: true,
    }));
  }, 40_000);
});
