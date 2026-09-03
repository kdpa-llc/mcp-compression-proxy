import { describe, it, expect, beforeEach, jest } from '@jest/globals';

// Mock ipc-client before importing commands
jest.mock('../../src/cli/ipc-client.js', () => ({
  sendRequest: jest.fn(),
  isDaemonRunning: jest.fn(),
}));

jest.mock('../../src/config/loader.js', () => ({
  loadJSONServers: jest.fn(),
}));

import { sendRequest, isDaemonRunning } from '../../src/cli/ipc-client.js';
import {
  handleTools,
  handleSearch,
  handleInfo,
  handleCall,
  handleStats,
  handleDaemonStatus,
  handleDoctor,
  tailLines,
} from '../../src/cli/commands.js';
import { loadJSONServers } from '../../src/config/loader.js';

const mockSendRequest = sendRequest as jest.MockedFunction<typeof sendRequest>;
const mockIsDaemonRunning = isDaemonRunning as jest.MockedFunction<typeof isDaemonRunning>;
const mockLoadConfig = loadJSONServers as jest.MockedFunction<typeof loadJSONServers>;
const SOCKET = '/tmp/test.sock';

describe('CLI commands', () => {
  let stdoutLines: string[];
  let stderrLines: string[];
  let exitCode: number | undefined;

  beforeEach(() => {
    jest.clearAllMocks();
    stdoutLines = [];
    stderrLines = [];
    exitCode = undefined;

    jest.spyOn(console, 'log').mockImplementation((msg: unknown) => {
      stdoutLines.push(String(msg));
    });
    jest.spyOn(console, 'error').mockImplementation((msg: unknown) => {
      stderrLines.push(String(msg));
    });
    jest.spyOn(process, 'exit').mockImplementation((code?: number | string | null) => {
      exitCode = Number(code ?? 0);
      throw new Error(`process.exit(${exitCode})`);
    });
  });

  // ── handleTools ─────────────────────────────────────────────────────────────

  describe('handleTools', () => {
    it('prints tool list and summary on success', async () => {
      mockSendRequest.mockResolvedValue({
        id: '1',
        result: {
          tools: [
            { server: 'fs', tool: 'read_file', description: 'Read a file' },
            { server: 'fs', tool: 'write_file', description: 'Write a file' },
          ],
          count: 2,
        },
      });

      await handleTools(SOCKET);

      expect(mockSendRequest).toHaveBeenCalledWith(SOCKET, 'tools');
      expect(stdoutLines.some(l => l.includes('fs/read_file'))).toBe(true);
      expect(stdoutLines.some(l => l.includes('2 tools'))).toBe(true);
    });

    it('prints "No tools found." when list is empty', async () => {
      mockSendRequest.mockResolvedValue({
        id: '1',
        result: { tools: [], count: 0 },
      });

      await handleTools(SOCKET);

      expect(stdoutLines.some(l => l.includes('No tools found.'))).toBe(true);
    });

    it('exits with 1 on error response', async () => {
      mockSendRequest.mockResolvedValue({
        id: '1',
        error: { code: -1, message: 'connection error' },
      });

      await expect(handleTools(SOCKET)).rejects.toThrow('process.exit(1)');
      expect(exitCode).toBe(1);
      expect(stderrLines.some(l => l.includes('connection error'))).toBe(true);
    });
  });

  // ── handleSearch ─────────────────────────────────────────────────────────────

  describe('handleSearch', () => {
    it('prints matching tools', async () => {
      mockSendRequest.mockResolvedValue({
        id: '1',
        result: {
          tools: [{ server: 'fs', tool: 'search_files', description: 'Search files' }],
          count: 1,
        },
      });

      await handleSearch(SOCKET, 'search');

      expect(mockSendRequest).toHaveBeenCalledWith(SOCKET, 'search', { query: 'search' });
      expect(stdoutLines.some(l => l.includes('fs/search_files'))).toBe(true);
    });

    it('prints no-match message when count is 0', async () => {
      mockSendRequest.mockResolvedValue({
        id: '1',
        result: { tools: [], count: 0 },
      });

      await handleSearch(SOCKET, 'xyz');

      expect(stdoutLines.some(l => l.includes('No tools matching'))).toBe(true);
    });

    it('exits with 1 when query is empty', async () => {
      await expect(handleSearch(SOCKET, '')).rejects.toThrow('process.exit(1)');
      expect(exitCode).toBe(1);
    });

    it('exits with 1 on error response', async () => {
      mockSendRequest.mockResolvedValue({
        id: '1',
        error: { code: -1, message: 'server error' },
      });

      await expect(handleSearch(SOCKET, 'q')).rejects.toThrow('process.exit(1)');
      expect(exitCode).toBe(1);
    });
  });

  // ── handleInfo ───────────────────────────────────────────────────────────────

  describe('handleInfo', () => {
    it('prints JSON schema on success', async () => {
      mockSendRequest.mockResolvedValue({
        id: '1',
        result: { name: 'read_file', server: 'fs', description: 'Read', inputSchema: {} },
      });

      await handleInfo(SOCKET, 'fs/read_file');

      expect(mockSendRequest).toHaveBeenCalledWith(SOCKET, 'info', { server: 'fs', tool: 'read_file' });
      const output = stdoutLines.join('');
      expect(output).toContain('read_file');
    });

    it('exits with 1 when serverTool has no slash', async () => {
      await expect(handleInfo(SOCKET, 'notool')).rejects.toThrow('process.exit(1)');
      expect(exitCode).toBe(1);
    });

    it('exits with 1 on error response', async () => {
      mockSendRequest.mockResolvedValue({
        id: '1',
        error: { code: -1, message: 'not found' },
      });

      await expect(handleInfo(SOCKET, 'fs/missing')).rejects.toThrow('process.exit(1)');
      expect(exitCode).toBe(1);
    });
  });

  // ── handleCall ───────────────────────────────────────────────────────────────

  describe('handleCall', () => {
    it('prints output on success', async () => {
      mockSendRequest.mockResolvedValue({
        id: '1',
        result: { output: 'file contents', isError: false },
      });

      await handleCall(SOCKET, 'fs/read_file', '{"path":"/tmp/a"}');

      expect(mockSendRequest).toHaveBeenCalledWith(SOCKET, 'call', {
        server: 'fs',
        tool: 'read_file',
        arguments: { path: '/tmp/a' },
      });
      expect(stdoutLines.some(l => l.includes('file contents'))).toBe(true);
    });

    it('exits with 1 when isError is true', async () => {
      mockSendRequest.mockResolvedValue({
        id: '1',
        result: { output: 'tool failed', isError: true },
      });

      await expect(handleCall(SOCKET, 'fs/read_file', '{}')).rejects.toThrow('process.exit(1)');
      expect(exitCode).toBe(1);
      expect(stderrLines.some(l => l.includes('tool failed'))).toBe(true);
    });

    it('exits with 1 when serverTool has no slash', async () => {
      await expect(handleCall(SOCKET, 'notool', '{}')).rejects.toThrow('process.exit(1)');
      expect(exitCode).toBe(1);
    });

    it('exits with 1 for invalid JSON payload', async () => {
      await expect(handleCall(SOCKET, 'fs/read_file', 'not-json')).rejects.toThrow('process.exit(1)');
      expect(exitCode).toBe(1);
      expect(stderrLines.some(l => l.includes('Invalid JSON'))).toBe(true);
    });

    it('defaults to empty args when payload is empty', async () => {
      mockSendRequest.mockResolvedValue({
        id: '1',
        result: { output: 'ok', isError: false },
      });

      await handleCall(SOCKET, 'fs/list', '');

      expect(mockSendRequest).toHaveBeenCalledWith(SOCKET, 'call', {
        server: 'fs',
        tool: 'list',
        arguments: {},
      });
    });

    it('exits with 1 on error response', async () => {
      mockSendRequest.mockResolvedValue({
        id: '1',
        error: { code: -1, message: 'call failed' },
      });

      await expect(handleCall(SOCKET, 'fs/read_file', '{}')).rejects.toThrow('process.exit(1)');
      expect(exitCode).toBe(1);
    });
  });

  // ── handleStats ──────────────────────────────────────────────────────────────

  describe('handleStats', () => {
    it('prints stats JSON on success', async () => {
      mockSendRequest.mockResolvedValue({
        id: '1',
        result: { totalCached: 5, coverage: '80%' },
      });

      await handleStats(SOCKET);

      expect(mockSendRequest).toHaveBeenCalledWith(SOCKET, 'stats');
      const output = stdoutLines.join('');
      expect(output).toContain('totalCached');
    });

    it('exits with 1 on error response', async () => {
      mockSendRequest.mockResolvedValue({
        id: '1',
        error: { code: -1, message: 'stats error' },
      });

      await expect(handleStats(SOCKET)).rejects.toThrow('process.exit(1)');
      expect(exitCode).toBe(1);
    });
  });

  // ── handleDaemonStatus ───────────────────────────────────────────────────────

  describe('handleDaemonStatus', () => {
    it('prints "not running" when daemon is down', async () => {
      mockIsDaemonRunning.mockResolvedValue(false);

      await handleDaemonStatus(SOCKET);

      expect(stdoutLines.some(l => l.includes('not running'))).toBe(true);
    });

    it('prints daemon info when running', async () => {
      mockIsDaemonRunning.mockResolvedValue(true);
      mockSendRequest.mockResolvedValue({
        id: '1',
        result: {
          pid: 1234,
          uptime: 3700,
          connectedServers: 2,
          totalServers: 3,
          cachedToolCount: 10,
          socketPath: SOCKET,
          servers: [
            { name: 'fs', connected: true },
            { name: 'git', connected: false, lastError: 'timeout' },
          ],
        },
      });

      await handleDaemonStatus(SOCKET);

      expect(stdoutLines.some(l => l.includes('1234'))).toBe(true);
      expect(stdoutLines.some(l => l.includes('git'))).toBe(true);
    });

    it('exits with 1 on error response', async () => {
      mockIsDaemonRunning.mockResolvedValue(true);
      mockSendRequest.mockResolvedValue({
        id: '1',
        error: { code: -1, message: 'status error' },
      });

      await expect(handleDaemonStatus(SOCKET)).rejects.toThrow('process.exit(1)');
      expect(exitCode).toBe(1);
    });

    it('shows uptime in minutes only when under 1 hour', async () => {
      mockIsDaemonRunning.mockResolvedValue(true);
      mockSendRequest.mockResolvedValue({
        id: '1',
        result: {
          pid: 42,
          uptime: 180,
          connectedServers: 1,
          totalServers: 1,
          cachedToolCount: 5,
          socketPath: SOCKET,
          servers: [{ name: 'fs', connected: true }],
        },
      });

      await handleDaemonStatus(SOCKET);

      expect(stdoutLines.some(l => l.includes('3m'))).toBe(true);
    });
  });

  describe('tailLines', () => {
    it('returns the last N lines', () => {
      expect(tailLines('a\nb\nc\nd', 2)).toBe('c\nd');
    });

    it('returns everything when asked for more than exists', () => {
      expect(tailLines('a\nb', 10)).toBe('a\nb');
    });

    it('returns exactly N when N matches the line count', () => {
      expect(tailLines('a\nb\nc', 3)).toBe('a\nb\nc');
    });

    it('treats a trailing newline as a terminator, not a blank line', () => {
      // Without this, `-n 1` on a normal log file returns an empty string.
      expect(tailLines('a\nb\n', 1)).toBe('b');
    });

    it('handles empty content', () => {
      expect(tailLines('', 5)).toBe('');
    });
  });

  describe('handleDoctor', () => {
    it('formats a schema error instead of throwing a stack trace', async () => {
      mockLoadConfig.mockImplementation(() => {
        throw new Error('Invalid server configuration:\n  - /mcpServers/0: must have required property');
      });

      await expect(handleDoctor(SOCKET)).rejects.toThrow('process.exit(1)');

      expect(exitCode).toBe(1);
      expect(stdoutLines.some(l => l.includes('Invalid configuration'))).toBe(true);
      expect(stdoutLines.some(l => l.includes('must have required property'))).toBe(true);
      // The backend section is pointless if the config never parsed.
      expect(mockSendRequest).not.toHaveBeenCalled();
    });

    it('reports a missing config without claiming health', async () => {
      mockLoadConfig.mockReturnValue(null);
      mockSendRequest.mockResolvedValue({ id: '1', result: { pid: 1, servers: [] } });

      await expect(handleDoctor(SOCKET)).rejects.toThrow('process.exit(1)');

      expect(stdoutLines.some(l => l.includes('No servers.json found'))).toBe(true);
    });

    it('passes when every configured server is connected', async () => {
      mockLoadConfig.mockReturnValue({
        servers: [{ name: 'fs', command: 'node' }],
        excludePatterns: [],
        noCompressPatterns: [],
      });
      mockSendRequest.mockResolvedValue({
        id: '1',
        result: { pid: 42, servers: [{ name: 'fs', connected: true }] },
      });

      await handleDoctor(SOCKET);

      expect(exitCode).toBeUndefined();
      expect(stdoutLines.some(l => l.includes('All checks passed'))).toBe(true);
    });

    it('surfaces a failed backend and its error', async () => {
      mockLoadConfig.mockReturnValue({
        servers: [{ name: 'fs', command: 'node' }, { name: 'gh', command: 'node' }],
        excludePatterns: [],
        noCompressPatterns: [],
      });
      mockSendRequest.mockResolvedValue({
        id: '1',
        result: {
          pid: 42,
          servers: [
            { name: 'fs', connected: true },
            { name: 'gh', connected: false, lastError: 'ENOENT' },
          ],
        },
      });

      await expect(handleDoctor(SOCKET)).rejects.toThrow('process.exit(1)');

      expect(stdoutLines.some(l => l.includes('gh: ENOENT'))).toBe(true);
      expect(stdoutLines.some(l => l.includes('Some checks failed'))).toBe(true);
    });

    it('flags a configured server the running daemon has never seen', async () => {
      // Added to servers.json after the daemon started: its warm connections
      // are stale and a restart is the fix.
      mockLoadConfig.mockReturnValue({
        servers: [{ name: 'fs', command: 'node' }, { name: 'added-later', command: 'node' }],
        excludePatterns: [],
        noCompressPatterns: [],
      });
      mockSendRequest.mockResolvedValue({
        id: '1',
        result: { pid: 42, servers: [{ name: 'fs', connected: true }] },
      });

      await expect(handleDoctor(SOCKET)).rejects.toThrow('process.exit(1)');

      expect(stdoutLines.some(l => l.includes('added-later'))).toBe(true);
      expect(stdoutLines.some(l => l.includes('daemon restart'))).toBe(true);
    });
  });
});
