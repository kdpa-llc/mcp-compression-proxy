import { describe, expect, it } from '@jest/globals';
import { join } from 'path';
import { getDaemonRuntimePaths } from '../../src/cli/runtime-paths.js';

describe('getDaemonRuntimePaths', () => {
  it('preserves the legacy single-daemon paths by default', () => {
    const paths = getDaemonRuntimePaths({}, '/home/test');

    expect(paths).toEqual({
      baseDir: '/home/test/.mcp-compression-proxy',
      socketPath: '/home/test/.mcp-compression-proxy/daemon.sock',
      pidFile: '/home/test/.mcp-compression-proxy/daemon.pid',
      readyFile: '/home/test/.mcp-compression-proxy/daemon.ready',
      logFile: '/home/test/.mcp-compression-proxy/daemon.log',
      payloadDir: '/home/test/.mcp-compression-proxy/payloads',
      releaseId: 'legacy',
    });
  });

  it('uses versioned runtime overrides without changing shared payload storage', () => {
    const baseDir = '/home/test/.mcp-compression-proxy';
    const runtimeDir = join(baseDir, 'releases', 'release-a', 'runtime');
    const paths = getDaemonRuntimePaths({
      MCP_DAEMON_BASE_DIR: baseDir,
      MCP_DAEMON_SOCKET_PATH: join(runtimeDir, 'daemon.sock'),
      MCP_DAEMON_PID_FILE: join(runtimeDir, 'daemon.pid'),
      MCP_DAEMON_READY_FILE: join(runtimeDir, 'daemon.ready'),
      MCP_DAEMON_LOG_FILE: join(runtimeDir, 'daemon.log'),
      MCP_DAEMON_RELEASE_ID: 'release-a',
    }, '/ignored');

    expect(paths).toEqual({
      baseDir,
      socketPath: join(runtimeDir, 'daemon.sock'),
      pidFile: join(runtimeDir, 'daemon.pid'),
      readyFile: join(runtimeDir, 'daemon.ready'),
      logFile: join(runtimeDir, 'daemon.log'),
      payloadDir: join(baseDir, 'payloads'),
      releaseId: 'release-a',
    });
  });

  it('allows an explicit shared payload directory override', () => {
    const paths = getDaemonRuntimePaths({
      MCP_PAYLOAD_DIR: '/secure/shared/payloads',
    }, '/home/test');

    expect(paths.payloadDir).toBe('/secure/shared/payloads');
  });
});
