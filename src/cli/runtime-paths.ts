import { homedir as osHomedir } from 'os';
import { join } from 'path';

export interface DaemonRuntimePaths {
  baseDir: string;
  socketPath: string;
  pidFile: string;
  readyFile: string;
  logFile: string;
  payloadDir: string;
  releaseId: string;
}

/**
 * Resolve daemon paths from environment variables so multiple release
 * generations can run beside each other while sharing durable payload files.
 */
export function getDaemonRuntimePaths(
  env: NodeJS.ProcessEnv = process.env,
  home = osHomedir()
): DaemonRuntimePaths {
  const baseDir =
    env.MCP_DAEMON_BASE_DIR ||
    join(home, '.mcp-compression-proxy');

  return {
    baseDir,
    socketPath:
      env.MCP_DAEMON_SOCKET_PATH ||
      join(baseDir, 'daemon.sock'),
    pidFile:
      env.MCP_DAEMON_PID_FILE ||
      join(baseDir, 'daemon.pid'),
    readyFile:
      env.MCP_DAEMON_READY_FILE ||
      join(baseDir, 'daemon.ready'),
    logFile:
      env.MCP_DAEMON_LOG_FILE ||
      join(baseDir, 'daemon.log'),
    payloadDir:
      env.MCP_PAYLOAD_DIR ||
      join(baseDir, 'payloads'),
    releaseId:
      env.MCP_DAEMON_RELEASE_ID?.trim() ||
      'legacy',
  };
}
