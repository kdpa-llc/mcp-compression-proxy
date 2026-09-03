import { describe, it, expect, afterEach } from '@jest/globals';
import {
  DEFAULT_PAYLOAD_THRESHOLD,
  PayloadStore,
  interceptPayload,
} from '../../src/cli/payload-interceptor.js';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  statSync,
} from 'fs';
import { dirname, join } from 'path';
import { tmpdir } from 'os';

describe('PayloadInterceptor', () => {
  const createdFiles: string[] = [];

  afterEach(() => {
    // Clean up temp files created during tests
    for (const f of createdFiles) {
      try { unlinkSync(f); } catch { /* ignore */ }
    }
    createdFiles.length = 0;
  });

  it('should return short output directly', () => {
    const output = 'hello world';
    expect(interceptPayload(output)).toBe('hello world');
  });

  it('should return output at exactly the threshold directly', () => {
    const output = 'x'.repeat(500);
    expect(interceptPayload(output, 500)).toBe(output);
  });

  it('should redirect output exceeding threshold to a temp file', () => {
    const output = 'x'.repeat(501);
    const result = interceptPayload(output, 500);

    expect(result).toMatch(/^Output saved to .*mcp_output_.*\.txt \(501 chars\)\. Payload ID: [a-f0-9]+\. Use mcp_find_output or mcp_read_output to inspect it\.$/);

    // Extract file path and verify file exists with correct content
    const match = result.match(/Output saved to (.*?) \(/);
    expect(match).toBeTruthy();
    const filePath = match![1];
    createdFiles.push(filePath);

    expect(existsSync(filePath)).toBe(true);
    expect(readFileSync(filePath, 'utf-8')).toBe(output);
  });

  it('should use the 10K default threshold when not specified', () => {
    const shortOutput = 'x'.repeat(DEFAULT_PAYLOAD_THRESHOLD);
    expect(interceptPayload(shortOutput)).toBe(shortOutput);

    const longOutput = 'y'.repeat(DEFAULT_PAYLOAD_THRESHOLD + 1);
    const result = interceptPayload(longOutput);
    expect(result).toContain('Output saved to');

    // Clean up
    const match = result.match(/Output saved to (.*?) \(/);
    if (match) createdFiles.push(match[1]);
  });

  it('should use custom threshold', () => {
    const output = 'abc'; // 3 chars
    const result = interceptPayload(output, 2);

    expect(result).toContain('Output saved to');
    expect(result).toContain('3 chars');

    const match = result.match(/Output saved to (.*?) \(/);
    if (match) createdFiles.push(match[1]);
  });

  it('should produce deterministic filenames for same content', () => {
    const output = 'x'.repeat(1000);
    const result1 = interceptPayload(output, 100);
    const result2 = interceptPayload(output, 100);

    // Same content should produce same hash/filename
    expect(result1).toBe(result2);

    const match = result1.match(/Output saved to (.*?) \(/);
    if (match) createdFiles.push(match[1]);
  });

  it('should produce different filenames for different content', () => {
    const output1 = 'a'.repeat(1000);
    const output2 = 'b'.repeat(1000);

    const result1 = interceptPayload(output1, 100);
    const result2 = interceptPayload(output2, 100);

    expect(result1).not.toBe(result2);

    for (const result of [result1, result2]) {
      const match = result.match(/Output saved to (.*?) \(/);
      if (match) createdFiles.push(match[1]);
    }
  });

  it('should handle empty output', () => {
    expect(interceptPayload('')).toBe('');
  });

  it('should handle threshold of 0', () => {
    const result = interceptPayload('a', 0);
    expect(result).toContain('Output saved to');

    const match = result.match(/Output saved to (.*?) \(/);
    if (match) createdFiles.push(match[1]);
  });

  it('should write files to the system temp directory', () => {
    const output = 'x'.repeat(1000);
    const result = interceptPayload(output, 100);

    const match = result.match(/Output saved to (.*?) \(/);
    expect(match).toBeTruthy();
    expect(match![1].startsWith(tmpdir())).toBe(true);

    createdFiles.push(match![1]);
  });

  describe('temp file permissions', () => {
    const pathOf = (result: string): string => {
      const match = result.match(/Output saved to (.*?) \(/);
      expect(match).toBeTruthy();
      createdFiles.push(match![1]);
      return match![1];
    };

    it('writes payloads readable only by the owner', () => {
      const filePath = pathOf(interceptPayload('x'.repeat(1000), 100));

      // 0600 - no group or other access to whatever the backend returned.
      expect(statSync(filePath).mode & 0o777).toBe(0o600);
    });

    it('writes into a private directory, not the shared temp root', () => {
      const filePath = pathOf(interceptPayload('y'.repeat(1000), 100));
      const dir = dirname(filePath);

      // A predictable path in the world-writable temp root is what let another
      // local user pre-plant a symlink at the target.
      expect(dir).not.toBe(tmpdir());
      expect(dir.startsWith(tmpdir())).toBe(true);
      expect(statSync(dir).mode & 0o777).toBe(0o700);
    });

    it('does not make the path predictable from content alone', () => {
      const content = 'z'.repeat(1000);
      const filePath = pathOf(interceptPayload(content, 100));

      // The content hash may still name the file, but the containing
      // directory is random, so the full path cannot be guessed in advance.
      const hash = 'mcp_output_';
      expect(filePath).toContain(hash);
      expect(filePath.replace(/.*mcp-output-/, '')).not.toBe(content);
      expect(dirname(filePath)).toMatch(/mcp-output-\w+$/);
    });

    it('reuses the file when identical content is intercepted twice', () => {
      const content = 'w'.repeat(1000);
      const first = interceptPayload(content, 100);
      const second = interceptPayload(content, 100);

      expect(first).toBe(second);
      const filePath = pathOf(first);
      expect(readFileSync(filePath, 'utf-8')).toBe(content);
    });
  });

  describe('payload cache API', () => {
    it('reads bounded chunks and can explicitly load the remaining payload', () => {
      const store = new PayloadStore();
      const captured = store.capture('0123456789', 5);

      expect(captured.reference).toBeDefined();
      expect(store.read(captured.reference!.id, { offset: 2, length: 4 })).toEqual(
        expect.objectContaining({
          content: '2345',
          offset: 2,
          nextOffset: 6,
          eof: false,
          totalChars: 10,
        })
      );
      expect(store.read(captured.reference!.id, { offset: 6, all: true })).toEqual(
        expect.objectContaining({
          content: '6789',
          nextOffset: 10,
          eof: true,
        })
      );

      store.destroy();
    });

    it('finds literal text with offsets, line numbers, and bounded context', () => {
      const store = new PayloadStore();
      const captured = store.capture('alpha\nneedle one\nbeta\nNEEDLE two\ngamma', 5);

      const result = store.find(captured.reference!.id, 'needle', {
        caseSensitive: false,
        maxMatches: 10,
        contextChars: 8,
      });

      expect(result.matches).toHaveLength(2);
      expect(result.matches[0]).toEqual(expect.objectContaining({
        line: 2,
        match: 'needle',
      }));
      expect(result.matches[1]).toEqual(expect.objectContaining({
        line: 4,
        match: 'NEEDLE',
      }));

      store.destroy();
    });

    it('evicts the oldest payload when the configured entry limit is reached', () => {
      const store = new PayloadStore({ maxEntries: 2 });
      const first = store.capture('first payload', 1).reference!;
      const second = store.capture('second payload', 1).reference!;
      const third = store.capture('third payload', 1).reference!;

      expect(() => store.read(first.id)).toThrow('not found');
      expect(store.read(second.id).content).toBe('second payload');
      expect(store.read(third.id).content).toBe('third payload');

      store.destroy();
    });

    it('lets a new daemon generation read payloads written by the old one', () => {
      const directory = mkdtempSync(join(tmpdir(), 'mcp-shared-payload-test-'));
      const writer = new PayloadStore({
        directory,
        removeDirectoryOnDestroy: false,
      });
      const captured = writer.capture('shared across releases', 1).reference!;
      writer.destroy();

      const reader = new PayloadStore({
        directory,
        removeDirectoryOnDestroy: false,
      });
      expect(reader.read(captured.id, { all: true }).content).toBe(
        'shared across releases'
      );
      reader.destroy();
      rmSync(directory, { recursive: true, force: true });
    });
  });
});
