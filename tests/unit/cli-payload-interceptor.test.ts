import { describe, it, expect, afterEach } from '@jest/globals';
import { interceptPayload } from '../../src/cli/payload-interceptor.js';
import { existsSync, readFileSync, unlinkSync } from 'fs';
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

    expect(result).toMatch(/^Output saved to .*mcp_output_.*\.txt \(501 chars\)\. Read file for full content\.$/);

    // Extract file path and verify file exists with correct content
    const match = result.match(/Output saved to (.*?) \(/);
    expect(match).toBeTruthy();
    const filePath = match![1];
    createdFiles.push(filePath);

    expect(existsSync(filePath)).toBe(true);
    expect(readFileSync(filePath, 'utf-8')).toBe(output);
  });

  it('should use default threshold of 500 when not specified', () => {
    const shortOutput = 'x'.repeat(500);
    expect(interceptPayload(shortOutput)).toBe(shortOutput);

    const longOutput = 'y'.repeat(501);
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
});
