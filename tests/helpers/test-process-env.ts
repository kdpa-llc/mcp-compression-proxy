import { statSync } from 'fs';
import { isAbsolute, join } from 'path';
import { pathToFileURL } from 'url';

/** Isolate real child processes without changing the host's home variables. */
export function testProcessEnv(testRoot: string): NodeJS.ProcessEnv {
  if (!isAbsolute(testRoot) || !statSync(testRoot).isDirectory()) {
    throw new Error('Test process root must be an existing absolute directory');
  }
  const preload = pathToFileURL(join(__dirname, 'isolate-home.mjs')).href;
  const baseDir = join(testRoot, '.mcp-compression-proxy');
  return {
    ...process.env,
    MCP_TEST_ROOT: testRoot,
    NODE_OPTIONS: [process.env.NODE_OPTIONS, `--import=${preload}`].filter(Boolean).join(' '),
    MCP_DAEMON_BASE_DIR: baseDir,
    MCP_DAEMON_SOCKET_PATH: join(baseDir, 'daemon.sock'),
    MCP_DAEMON_PID_FILE: join(baseDir, 'daemon.pid'),
    MCP_DAEMON_READY_FILE: join(baseDir, 'daemon.ready'),
    MCP_DAEMON_LOG_FILE: join(baseDir, 'daemon.log'),
    MCP_PAYLOAD_DIR: join(baseDir, 'payloads'),
    MCP_DAEMON_RELEASE_ID: 'legacy',
  };
}
