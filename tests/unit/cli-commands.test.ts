import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

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
  handleSearchQuality,
  takeOption,
  takeLimit,
  handleInfo,
  handleCall,
  handleSuggest,
  handleAudit,
  handleCompress,
  handlePayloadShape,
  takeShapeOptions,
  handleDescribe,
  formatReview,
  installSkill,
  handlePayloadRead,
  handlePayloadFind,
  handleScript,
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

  // ── option parsing ──────────────────────────────────────────────────────────

  describe('takeOption / takeLimit', () => {
    it('extracts --name value and --name=value, keeping other args in order', () => {
      expect(takeOption(['a', '--want', '{}', 'b'], 'want')).toEqual({ rest: ['a', 'b'], value: '{}' });
      expect(takeOption(['--want={"x":1}', 'a'], 'want')).toEqual({ rest: ['a'], value: '{"x":1}' });
      expect(takeOption(['a'], 'want')).toEqual({ rest: ['a'] });
    });

    it('accepts only a positive integer limit', () => {
      expect(takeLimit(['q', '--limit', '5'])).toEqual({ rest: ['q'], limit: 5 });
      expect(takeLimit(['q', '--limit', 'zero']).limit).toBeUndefined();
      expect(takeLimit(['q', '--limit', '-2']).limit).toBeUndefined();
      expect(takeLimit(['q']).limit).toBeUndefined();
    });
  });

  // ── handleSearchQuality ────────────────────────────────────────────────────

  describe('handleSearchQuality', () => {
    it('explains how to enable learning when nothing is recorded', async () => {
      mockSendRequest.mockResolvedValue({
        id: '1',
        result: { enabled: false, selections: 0, top1: 0, top5: 0, misses: 0, top1Rate: 0, top5Rate: 0, missRate: 0, topTools: [] },
      });

      await handleSearchQuality(SOCKET);

      expect(stdoutLines.join('\n')).toContain('learnFromUsage');
    });

    it('prints rates and the most chosen tools', async () => {
      mockSendRequest.mockResolvedValue({
        id: '1',
        result: {
          enabled: true,
          selections: 4,
          top1: 2,
          top5: 3,
          misses: 1,
          top1Rate: 50,
          top5Rate: 75,
          missRate: 25,
          topTools: [{ tool: 'fs/read_file', selections: 3 }],
        },
      });

      await handleSearchQuality(SOCKET);

      const out = stdoutLines.join('\n');
      expect(out).toContain('Recorded choices: 4');
      expect(out).toContain('ranked first:  2 (50%)');
      expect(out).toContain('fs/read_file');
    });

    it('stops after the count when learning was switched off with nothing recorded since', async () => {
      mockSendRequest.mockResolvedValue({
        id: '1',
        result: { enabled: true, selections: 0, top1: 0, top5: 0, misses: 0, top1Rate: 0, top5Rate: 0, missRate: 0, topTools: [] },
      });

      await handleSearchQuality(SOCKET);

      expect(stdoutLines.join('\n')).toContain('Recorded choices: 0');
      expect(stdoutLines.join('\n')).not.toContain('ranked first');
    });

    it('exits with 1 on a daemon error', async () => {
      mockSendRequest.mockResolvedValue({ id: '1', error: { code: -1, message: 'boom' } });
      await expect(handleSearchQuality(SOCKET)).rejects.toThrow('process.exit(1)');
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

    it('passes a limit and says when more matches exist', async () => {
      mockSendRequest.mockResolvedValue({
        id: '1',
        result: {
          tools: [{ server: 'fs', tool: 'read_file', description: 'Read' }],
          count: 1,
          total: 7,
          signals: ['lexical'],
        },
      });

      await handleSearch(SOCKET, 'read', { limit: 1 });

      expect(mockSendRequest).toHaveBeenCalledWith(SOCKET, 'search', { query: 'read', limit: 1 });
      expect(stdoutLines.some((l) => l.includes('best 1 of 7 matches'))).toBe(true);
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

  describe('describe and install-skill', () => {
    const review: Parameters<typeof formatReview>[0] = {
      mode: 'rewrite',
      method: 'lexical',
      accepted: 1,
      rejected: 1,
      reviewed: [
        {
          server: 'gh',
          tool: 'list_issues',
          accepted: true,
          problems: [],
          warnings: ['longer than the original'],
          before: { description: 'Gets issues.', parameters: { state: 'state' } },
          after: { description: 'List issues in one repository.', parameters: { state: 'open or closed' } },
          chars: { before: 12, after: 30 },
        },
        {
          server: '',
          tool: '',
          accepted: false,
          problems: ['missing server or tool'],
          warnings: [],
          before: { description: '', parameters: {} },
          after: { description: 'x', parameters: {} },
          chars: { before: 0, after: 1 },
        },
      ],
    };

    it('formats a review as before/after with problems and warnings', () => {
      const text = formatReview(review);
      expect(text).toContain('✓ gh/list_issues  (12 -> 30 chars)');
      expect(text).toContain('- Gets issues.');
      expect(text).toContain('+ List issues in one repository.');
      expect(text).toContain('state:');
      expect(text).toContain('+ open or closed');
      expect(text).toContain('! longer than the original');
      expect(text).toContain('✗ (unnamed entry)');
      expect(text).toContain('✗ missing server or tool');
      expect(text).toContain('1 accepted, 1 rejected');
    });

    it('prints the next batch as JSON with the requested filters', async () => {
      mockSendRequest.mockResolvedValue({ id: '1', result: { mode: 'compress', items: [] } });
      await handleDescribe(SOCKET, 'next', { mode: 'compress', limit: 5, server: 'gh', tool: 'gh/x', all: true });

      expect(mockSendRequest).toHaveBeenCalledWith(SOCKET, 'describe', {
        action: 'next',
        mode: 'compress',
        limit: 5,
        server: 'gh',
        tool: 'gh/x',
        all: true,
      });
      expect(JSON.parse(stdoutLines.join('\n')).mode).toBe('compress');
    });

    it('reviews without saving and applies with an undo hint', async () => {
      mockSendRequest.mockResolvedValue({ id: '1', result: review });
      await handleDescribe(SOCKET, 'review', { proposals: '[{"server":"gh","tool":"list_issues"}]' });
      expect(mockSendRequest).toHaveBeenCalledWith(SOCKET, 'describe', {
        action: 'review',
        mode: 'rewrite',
        proposals: [{ server: 'gh', tool: 'list_issues' }],
      });
      expect(stdoutLines.join('\n')).toContain('Nothing was saved');

      mockSendRequest.mockResolvedValue({ id: '1', result: { ...review, applied: ['gh/list_issues'] } });
      await handleDescribe(SOCKET, 'apply', { proposals: '[]' });
      expect(stdoutLines.join('\n')).toContain('Applied 1. Originals are kept');
    });

    it('reverts one tool or all of them', async () => {
      mockSendRequest.mockResolvedValue({ id: '1', result: { reverted: ['gh/list_issues'] } });
      await handleDescribe(SOCKET, 'revert', { tool: 'gh/list_issues' });
      expect(mockSendRequest).toHaveBeenCalledWith(SOCKET, 'describe', {
        action: 'revert',
        mode: 'rewrite',
        tool: 'gh/list_issues',
      });
      expect(stdoutLines.join('\n')).toContain('Reverted 1 tool(s)');

      mockSendRequest.mockResolvedValue({ id: '1', result: { reverted: [] } });
      await handleDescribe(SOCKET, 'revert', { all: true });
      expect(stdoutLines.join('\n')).toContain('Nothing to revert.');
    });

    it.each([
      ['a bad mode', 'next', { mode: 'shorten' }],
      ['review without proposals', 'review', {}],
      ['proposals that are not JSON', 'apply', { proposals: '[oops' }],
      ['revert without a target', 'revert', {}],
      ['an unknown action', 'polish', {}],
    ])('exits with 1 on %s', async (_label, action, options) => {
      await expect(handleDescribe(SOCKET, action, options)).rejects.toThrow('process.exit(1)');
      expect(mockSendRequest).not.toHaveBeenCalled();
    });

    it('exits with 1 when the daemon reports an error', async () => {
      mockSendRequest.mockResolvedValue({ id: '1', error: { code: -1, message: 'Unknown describe action' } });
      await expect(handleDescribe(SOCKET, 'next')).rejects.toThrow('process.exit(1)');
    });

    it('installs the bundled skill, leaves an identical copy alone, and protects local edits', () => {
      const root = mkdtempSync(join(tmpdir(), 'skill-'));
      try {
        const source = join(process.cwd(), 'skills', 'mcp-cli');
        const target = join(root, 'skills', 'mcp-cli');

        expect(installSkill(source, target).status).toBe('installed');
        expect(readFileSync(join(target, 'SKILL.md'), 'utf-8')).toContain('name: mcp-cli');
        expect(existsSync(join(target, 'DESCRIBE.md'))).toBe(true);
        expect(installSkill(source, target).status).toBe('unchanged');

        writeFileSync(join(target, 'SKILL.md'), 'my edits');
        expect(() => installSkill(source, target)).toThrow('--force');
        expect(installSkill(source, target, { force: true }).status).toBe('updated');
        expect(readFileSync(join(target, 'SKILL.md'), 'utf-8')).toContain('name: mcp-cli');

        expect(() => installSkill(join(root, 'nowhere'), target)).toThrow('Bundled skill not found');
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  });

  describe('output edges', () => {
    const quality = { top1: 1, top5: 1, misses: 0, top1Rate: 100, top5Rate: 100, missRate: 0 };

    it('shows counts after learning was switched off, with no top tools', async () => {
      mockSendRequest.mockResolvedValue({ id: '1', result: { ...quality, enabled: false, selections: 1, topTools: [] } });
      await handleSearchQuality(SOCKET);
      const out = stdoutLines.join('\n');
      expect(out).toContain('Recorded choices: 1 (learning is now off)');
      expect(out).not.toContain('Most chosen tools');
    });

    it('explains a refused run without a reason', async () => {
      mockSendRequest.mockResolvedValue({ id: '1', result: { suggestion: { runnable: false } } });
      await handleSuggest(SOCKET, 'x', { run: true });
      expect(stderrLines.join('\n')).toContain('Not run: no runnable proposal');
    });

    it('shows only what changed in a review, marking empty text', () => {
      const text = formatReview({
        mode: 'rewrite',
        method: 'semantic',
        accepted: 0,
        rejected: 1,
        reviewed: [
          {
            server: 's',
            tool: 't',
            accepted: false,
            problems: ['description is empty'],
            warnings: [],
            before: { description: 'Same.', parameters: { kept: 'unchanged' } },
            after: { description: '', parameters: { kept: 'unchanged', added: 'new text' } },
            chars: { before: 5, after: 0 },
          },
          {
            server: 's',
            tool: 'u',
            accepted: true,
            problems: [],
            warnings: [],
            before: { description: 'Same.', parameters: {} },
            after: { description: 'Same.', parameters: {} },
            chars: { before: 5, after: 5 },
          },
        ],
      });
      expect(text).toContain('+ (none)');
      expect(text).not.toContain('kept:');
      expect(text).toContain('added:');
      expect(text).toContain('      - (none)');
      expect(text).toContain('distinctness checked by meaning');
      expect(text.split('\n').filter((line) => line.includes('Same.'))).toHaveLength(1);
    });

    it('applies with a zero count when nothing is reported, and gives no hint when nothing passed', async () => {
      const empty = { mode: 'rewrite', method: 'lexical', reviewed: [], accepted: 0, rejected: 0 };
      mockSendRequest.mockResolvedValue({ id: '1', result: empty });
      await handleDescribe(SOCKET, 'apply', { proposals: '[]' });
      expect(stdoutLines.join('\n')).toContain('Applied 0.');

      stdoutLines.length = 0;
      await handleDescribe(SOCKET, 'review', { proposals: '[]' });
      expect(stdoutLines.join('\n')).not.toContain('Nothing was saved');
    });
  });

  describe('shaping, suggest, audit and compress', () => {
    it('parses --want, --where and --limit out of call arguments', () => {
      expect(
        takeShapeOptions(['fs/list', '{}', '--want', '{"a":"string"}', '--where=auth', '--limit', '3'])
      ).toEqual({ rest: ['fs/list', '{}'], shape: { want: '{"a":"string"}', where: 'auth', limit: 3 } });
      expect(takeShapeOptions(['fs/list'])).toEqual({ rest: ['fs/list'], shape: {} });
    });

    it('sends a parsed shape with the call and prints the shaped answer', async () => {
      mockSendRequest.mockResolvedValue({
        id: '1',
        result: { output: '', shaped: { data: { a: 1 }, meta: { method: 'projection' } } },
      });

      await handleCall(SOCKET, 'fs/list', '{}', { want: '{"a":"number"}', where: 'x', limit: 2 });

      expect(mockSendRequest).toHaveBeenCalledWith(SOCKET, 'call', {
        server: 'fs',
        tool: 'list',
        arguments: {},
        want: { a: 'number' },
        where: 'x',
        limit: 2,
      });
      expect(JSON.parse(stdoutLines.join('\n')).data).toEqual({ a: 1 });
    });

    it('rejects a --want that is not JSON before calling the daemon', async () => {
      await expect(handleCall(SOCKET, 'fs/list', '{}', { want: '{a:' })).rejects.toThrow('process.exit(1)');
      expect(stderrLines.join('\n')).toContain('--want must be JSON');
      expect(mockSendRequest).not.toHaveBeenCalled();
    });

    it('shapes a saved output, and requires something to shape with', async () => {
      mockSendRequest.mockResolvedValue({ id: '1', result: { data: [1] } });
      await handlePayloadShape(SOCKET, 'abc', { where: 'auth' });
      expect(mockSendRequest).toHaveBeenCalledWith(SOCKET, 'payload-shape', { id: 'abc', where: 'auth' });

      await expect(handlePayloadShape(SOCKET, 'abc', {})).rejects.toThrow('process.exit(1)');

      mockSendRequest.mockResolvedValue({ id: '1', error: { code: -1, message: 'gone' } });
      await expect(handlePayloadShape(SOCKET, 'abc', { where: 'x' })).rejects.toThrow('process.exit(1)');
    });

    it('prints a suggestion, and the output when it ran', async () => {
      mockSendRequest.mockResolvedValue({
        id: '1',
        result: { suggestion: { runnable: true }, ran: { output: 'listing', isError: false } },
      });
      await handleSuggest(SOCKET, 'list files', { run: true, candidates: 3 });
      expect(mockSendRequest).toHaveBeenCalledWith(SOCKET, 'suggest', {
        request: 'list files',
        run: true,
        candidates: 3,
      });
      expect(stdoutLines.join('\n')).toContain('listing');
    });

    it('says why a suggestion was not run', async () => {
      mockSendRequest.mockResolvedValue({
        id: '1',
        result: { suggestion: { runnable: false, runBlockedBy: 'the tool does not declare readOnlyHint' } },
      });
      await handleSuggest(SOCKET, 'delete it', { run: true });
      expect(stderrLines.join('\n')).toContain('Not run: the tool does not declare readOnlyHint');
    });

    it('exits non-zero when a suggested call ran and failed, or on bad input', async () => {
      mockSendRequest.mockResolvedValue({
        id: '1',
        result: { suggestion: { runnable: true }, ran: { output: 'failed', isError: true } },
      });
      await expect(handleSuggest(SOCKET, 'x', { run: true })).rejects.toThrow('process.exit(1)');
      await expect(handleSuggest(SOCKET, '')).rejects.toThrow('process.exit(1)');
      mockSendRequest.mockResolvedValue({ id: '1', error: { code: -1, message: 'no' } });
      await expect(handleSuggest(SOCKET, 'x')).rejects.toThrow('process.exit(1)');
    });

    it('prints audit findings, duplicates and notes', async () => {
      mockSendRequest.mockResolvedValue({
        id: '1',
        result: {
          method: 'lexical',
          checked: 2,
          confusable: [
            { tool: 'fs/read_file', compressed: 'Reads files.', closestTo: 'fs/read_many', ownSimilarity: 0.3, otherSimilarity: 0.5 },
          ],
          duplicates: [{ tools: ['a/x', 'b/x'], similarity: 0.9 }],
          notes: ['a note'],
          requeued: 0,
        },
      });

      await handleAudit(SOCKET);

      const out = stdoutLines.join('\n');
      expect(out).toContain('fs/read_file -> closer to fs/read_many');
      expect(out).toContain('mcp-cli audit --requeue');
      expect(out).toContain('a/x  ~  b/x');
      expect(out).toContain('Note: a note');
    });

    it('reports a clean audit and re-queued findings', async () => {
      mockSendRequest.mockResolvedValue({
        id: '1',
        result: { method: 'semantic', checked: 1, confusable: [], duplicates: [], notes: [], requeued: 0 },
      });
      await handleAudit(SOCKET, { requeue: true });
      expect(mockSendRequest).toHaveBeenCalledWith(SOCKET, 'audit', { requeue: true });
      expect(stdoutLines.join('\n')).toContain('still closest to its own tool');

      mockSendRequest.mockResolvedValue({
        id: '1',
        result: {
          method: 'lexical',
          checked: 1,
          confusable: [{ tool: 'a/b', compressed: 'c', closestTo: 'a/d', ownSimilarity: 0, otherSimilarity: 1 }],
          duplicates: [],
          notes: [],
          requeued: 1,
        },
      });
      await handleAudit(SOCKET, { requeue: true });
      expect(stdoutLines.join('\n')).toContain('Re-queued 1');

      mockSendRequest.mockResolvedValue({ id: '1', error: { code: -1, message: 'no' } });
      await expect(handleAudit(SOCKET)).rejects.toThrow('process.exit(1)');
    });

    it('summarises a compression run', async () => {
      mockSendRequest.mockResolvedValue({
        id: '1',
        result: { compressed: 8, attempted: 10, batchesAttempted: 1, batchesFailed: 1, remaining: 2 },
      });
      await handleCompress(SOCKET, { limit: 10 });

      expect(mockSendRequest).toHaveBeenCalledWith(SOCKET, 'compress', { limit: 10 }, 600_000);
      const out = stdoutLines.join('\n');
      expect(out).toContain('Compressed 8 of 10');
      expect(out).toContain('1 of 1 batch');
      expect(out).toContain('2 remaining');

      mockSendRequest.mockResolvedValue({
        id: '1',
        result: { compressed: 1, attempted: 1, batchesAttempted: 1, batchesFailed: 0, remaining: 0 },
      });
      await handleCompress(SOCKET);
      expect(stdoutLines.join('\n')).toContain('All tools have compressed descriptions');

      mockSendRequest.mockResolvedValue({ id: '1', error: { code: -1, message: 'No compressor configured' } });
      await expect(handleCompress(SOCKET)).rejects.toThrow('process.exit(1)');
      expect(stderrLines.join('\n')).toContain('No compressor configured');
    });
  });

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

  describe('large output commands', () => {
    it('reads a cached payload', async () => {
      mockSendRequest.mockResolvedValue({
        id: '1',
        result: {
          id: 'payload-1',
          content: 'chunk',
          offset: 0,
          nextOffset: 5,
          totalChars: 5,
          eof: true,
        },
      });

      await handlePayloadRead(SOCKET, 'payload-1', {
        offset: 0,
        length: 5,
      });

      expect(mockSendRequest).toHaveBeenCalledWith(
        SOCKET,
        'payload-read',
        { id: 'payload-1', offset: 0, length: 5 }
      );
      expect(stdoutLines.join('\n')).toContain('chunk');
    });

    it('finds text in a cached payload', async () => {
      mockSendRequest.mockResolvedValue({
        id: '1',
        result: {
          id: 'payload-1',
          query: 'needle',
          matches: [{ line: 2, offset: 8, match: 'needle', context: 'needle' }],
        },
      });

      await handlePayloadFind(SOCKET, 'payload-1', 'needle');

      expect(mockSendRequest).toHaveBeenCalledWith(
        SOCKET,
        'payload-find',
        { id: 'payload-1', query: 'needle' }
      );
      expect(stdoutLines.join('\n')).toContain('needle');
    });

    it('runs a script from either an array or steps object', async () => {
      mockSendRequest.mockResolvedValue({
        id: '1',
        result: { steps: [{ id: 'one', output: 'ok' }] },
      });

      await handleScript(
        SOCKET,
        JSON.stringify([{ id: 'one', server: 's', tool: 't' }])
      );

      expect(mockSendRequest).toHaveBeenCalledWith(
        SOCKET,
        'script',
        { steps: [{ id: 'one', server: 's', tool: 't' }] }
      );
      expect(stdoutLines.join('\n')).toContain('"one"');
    });

    it('rejects invalid script JSON before IPC', async () => {
      await expect(handleScript(SOCKET, 'not-json')).rejects.toThrow(
        'process.exit(1)'
      );
      expect(mockSendRequest).not.toHaveBeenCalled();
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

    it('reports the shared pool and attached sessions of a newer daemon', async () => {
      mockIsDaemonRunning.mockResolvedValue(true);
      mockSendRequest.mockResolvedValue({
        id: '1',
        result: {
          pid: 7,
          uptime: 60,
          connectedServers: 1,
          totalServers: 1,
          cachedToolCount: 0,
          socketPath: SOCKET,
          servers: [{ name: 'fs', connected: true }],
          backends: [{ name: 'fs#abc', connected: true, holders: 2 }, { name: 'git#def', connected: true, holders: 1 }],
          sessions: [{ id: 's1', cwd: '/p' }],
        },
      });

      await handleDaemonStatus(SOCKET);

      expect(stdoutLines).toContain('Shared: 2 backend(s) for every client, 1 MCP session(s) attached');
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
