import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { spawnSync } from 'child_process';
import { mkdtempSync, rmSync } from 'fs';
import { homedir, tmpdir } from 'os';
import { join, resolve } from 'path';
import { pathToFileURL } from 'url';
import { configHomeDirectory } from '../../src/config/home-directory.js';
import { testProcessEnv } from '../helpers/test-process-env.js';

const protectedNames = ['HOME', 'USERPROFILE', 'XDG_CONFIG_HOME', 'CODEX_HOME'];
const snapshot = (env: NodeJS.ProcessEnv): Array<string | undefined> =>
  protectedNames.map((name) => env[name]);

describe('test process path isolation', () => {
  let root: string;
  let originalEnvironment: Array<string | undefined>;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'mcp-isolate-'));
    originalEnvironment = snapshot(process.env);
  });

  afterEach(() => {
    expect(snapshot(process.env)).toEqual(originalEnvironment);
    rmSync(root, { recursive: true, force: true });
  });

  it('keeps production home precedence and preserves protected child variables', () => {
    expect(configHomeDirectory.get()).toBe(process.env.HOME || homedir());
    const env = testProcessEnv(root);
    expect(snapshot(env)).toEqual(originalEnvironment);
    expect(env.MCP_DAEMON_SOCKET_PATH).toBe(join(root, '.mcp-compression-proxy', 'daemon.sock'));
    expect(env.MCP_PAYLOAD_DIR).toBe(join(root, '.mcp-compression-proxy', 'payloads'));
  });

  it('isolates built config/cache/runtime lookups in the child and its descendant', () => {
    const repo = resolve(__dirname, '../..');
    const loader = pathToFileURL(join(repo, 'dist/config/loader.js')).href;
    const persistence = pathToFileURL(join(repo, 'dist/services/compression-persistence.js')).href;
    const runtime = pathToFileURL(join(repo, 'dist/cli/runtime-paths.js')).href;
    const lookup = `
      import os from 'node:os';
      import { getConfigPath } from ${JSON.stringify(loader)};
      import { CompressionPersistence } from ${JSON.stringify(persistence)};
      import { getDaemonRuntimePaths } from ${JSON.stringify(runtime)};
      const actual = {
        home: os.homedir(),
        config: getConfigPath(),
        cache: new CompressionPersistence({}).getCacheFilePath(),
        payload: getDaemonRuntimePaths().payloadDir,
        protected: ${JSON.stringify(protectedNames)}.map(name => process.env[name]),
      };
    `;
    const descendant = `${lookup} process.stdout.write(JSON.stringify(actual));`;
    const script = `${lookup}
      const { spawnSync } = await import('node:child_process');
      const child = spawnSync(process.execPath, ['--input-type=module', '-e', ${JSON.stringify(descendant)}], {encoding: 'utf8'});
      if (child.status !== 0) throw new Error(child.stderr);
      process.stdout.write(JSON.stringify({ actual, descendant: JSON.parse(child.stdout) }));
    `;
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
      env: testProcessEnv(root),
      encoding: 'utf8',
      timeout: 10000,
    });
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    const expected = {
      home: root,
      config: join(root, '.mcp-compression-proxy', 'servers.json'),
      cache: join(root, '.mcp-compression-proxy', 'cache.json'),
      payload: join(root, '.mcp-compression-proxy', 'payloads'),
      protected: originalEnvironment.map((value) => value ?? null),
    };
    expect(JSON.parse(result.stdout)).toEqual({ actual: expected, descendant: expected });
  });

  it('fails before the entrypoint if its explicit test root is absent', () => {
    const env = testProcessEnv(root);
    delete env.MCP_TEST_ROOT;
    const result = spawnSync(process.execPath, ['-e', 'process.stdout.write("entrypoint ran")'], {
      env,
      encoding: 'utf8',
      timeout: 10000,
    });
    expect(result.status).not.toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('MCP_TEST_ROOT must be an existing absolute test directory');
  });
});
