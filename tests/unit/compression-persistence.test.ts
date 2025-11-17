import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { CompressionPersistence } from '../../src/services/compression-persistence.js';
import type { Logger } from 'pino';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

describe('CompressionPersistence', () => {
  let persistence: CompressionPersistence;
  let mockLogger: Logger;
  let testCacheDir: string;

  beforeEach(async () => {
    mockLogger = {
      debug: jest.fn(),
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    } as unknown as Logger;

    // Use a temporary directory for tests
    testCacheDir = path.join(os.tmpdir(), `mcp-test-${Date.now()}`);
    persistence = new CompressionPersistence(mockLogger, testCacheDir);
  });

  afterEach(async () => {
    // Clean up test directory
    try {
      await fs.rm(testCacheDir, { recursive: true, force: true });
    } catch (error) {
      // Ignore cleanup errors
    }
  });

  describe('save and load', () => {
    it('should save and load cache successfully', async () => {
      const cache = new Map([
        [
          'filesystem:read_file',
          {
            original: 'Read the complete contents of a file',
            compressed: 'Read file (text, max 10MB)',
            compressedAt: '2024-01-01T00:00:00.000Z',
          },
        ],
        [
          'github:create_issue',
          {
            compressed: 'Create GH issue',
            compressedAt: '2024-01-02T00:00:00.000Z',
          },
        ],
      ]);

      await persistence.save(cache);
      const loaded = await persistence.load();

      expect(loaded.size).toBe(2);
      expect(loaded.get('filesystem:read_file')).toEqual({
        original: 'Read the complete contents of a file',
        compressed: 'Read file (text, max 10MB)',
        compressedAt: '2024-01-01T00:00:00.000Z',
      });
      expect(loaded.get('github:create_issue')).toEqual({
        compressed: 'Create GH issue',
        compressedAt: '2024-01-02T00:00:00.000Z',
      });
    });

    it('should return empty cache when file does not exist', async () => {
      const loaded = await persistence.load();
      expect(loaded.size).toBe(0);
    });

    it('should create cache directory if it does not exist', async () => {
      const cache = new Map([
        ['server:tool', { compressed: 'Test', compressedAt: '2024-01-01T00:00:00.000Z' }],
      ]);

      await persistence.save(cache);

      const stat = await fs.stat(testCacheDir);
      expect(stat.isDirectory()).toBe(true);
    });

    it('should handle cache with special characters in names', async () => {
      const cache = new Map([
        [
          'server-with-dash:tool_with_underscore',
          { compressed: 'Test', compressedAt: '2024-01-01T00:00:00.000Z' },
        ],
      ]);

      await persistence.save(cache);
      const loaded = await persistence.load();

      expect(loaded.get('server-with-dash:tool_with_underscore')).toEqual({
        compressed: 'Test',
        compressedAt: '2024-01-01T00:00:00.000Z',
      });
    });

    it('should handle empty cache', async () => {
      const cache = new Map();

      await persistence.save(cache);
      const loaded = await persistence.load();

      expect(loaded.size).toBe(0);
    });

    it('should overwrite existing cache file', async () => {
      const cache1 = new Map([
        ['server1:tool1', { compressed: 'Version 1', compressedAt: '2024-01-01T00:00:00.000Z' }],
      ]);
      const cache2 = new Map([
        ['server2:tool2', { compressed: 'Version 2', compressedAt: '2024-01-02T00:00:00.000Z' }],
      ]);

      await persistence.save(cache1);
      await persistence.save(cache2);

      const loaded = await persistence.load();

      expect(loaded.size).toBe(1);
      expect(loaded.get('server2:tool2')).toBeDefined();
      expect(loaded.get('server1:tool1')).toBeUndefined();
    });
  });

  describe('version handling', () => {
    it('should include version in saved file', async () => {
      const cache = new Map([
        ['server:tool', { compressed: 'Test', compressedAt: '2024-01-01T00:00:00.000Z' }],
      ]);

      await persistence.save(cache);

      const cacheFile = persistence.getCacheFilePath();
      const content = await fs.readFile(cacheFile, 'utf-8');
      const data = JSON.parse(content);

      expect(data.version).toBe(1);
    });

    it('should include lastUpdated in saved file', async () => {
      const cache = new Map([
        ['server:tool', { compressed: 'Test', compressedAt: '2024-01-01T00:00:00.000Z' }],
      ]);

      await persistence.save(cache);

      const cacheFile = persistence.getCacheFilePath();
      const content = await fs.readFile(cacheFile, 'utf-8');
      const data = JSON.parse(content);

      expect(data.lastUpdated).toBeDefined();
      expect(typeof data.lastUpdated).toBe('string');
    });

    it('should ignore cache with different version', async () => {
      // Create a cache file with wrong version
      const cacheFile = persistence.getCacheFilePath();
      await fs.mkdir(testCacheDir, { recursive: true });
      await fs.writeFile(
        cacheFile,
        JSON.stringify({
          version: 999,
          lastUpdated: '2024-01-01T00:00:00.000Z',
          compressions: [
            {
              serverName: 'server',
              toolName: 'tool',
              compressedDescription: 'Test',
              compressedAt: '2024-01-01T00:00:00.000Z',
            },
          ],
        }),
        'utf-8'
      );

      const loaded = await persistence.load();

      expect(loaded.size).toBe(0);
      expect(mockLogger.warn).toHaveBeenCalledWith(
        { fileVersion: 999, currentVersion: 1 },
        'Cache version mismatch, ignoring cached data'
      );
    });
  });

  describe('clear', () => {
    it('should delete cache file', async () => {
      const cache = new Map([
        ['server:tool', { compressed: 'Test', compressedAt: '2024-01-01T00:00:00.000Z' }],
      ]);

      await persistence.save(cache);

      const cacheFile = persistence.getCacheFilePath();
      let exists = true;
      try {
        await fs.access(cacheFile);
      } catch {
        exists = false;
      }
      expect(exists).toBe(true);

      await persistence.clear();

      exists = true;
      try {
        await fs.access(cacheFile);
      } catch {
        exists = false;
      }
      expect(exists).toBe(false);
    });

    it('should not throw if cache file does not exist', async () => {
      await expect(persistence.clear()).resolves.not.toThrow();
    });
  });

  describe('getCacheFilePath', () => {
    it('should return correct cache file path', () => {
      const filePath = persistence.getCacheFilePath();
      expect(filePath).toBe(path.join(testCacheDir, 'cache.json'));
    });

    it('should use repo-specific directory by default', () => {
      const defaultPersistence = new CompressionPersistence(mockLogger);
      const filePath = defaultPersistence.getCacheFilePath();

      expect(filePath).toContain('.mcp-compression-proxy');
      expect(filePath).toContain('cache.json');
    });
  });

  describe('error handling', () => {
    it('should handle corrupted cache file', async () => {
      const cacheFile = persistence.getCacheFilePath();
      await fs.mkdir(testCacheDir, { recursive: true });
      await fs.writeFile(cacheFile, 'invalid json', 'utf-8');

      const loaded = await persistence.load();

      expect(loaded.size).toBe(0);
      expect(mockLogger.error).toHaveBeenCalled();
    });
  });
});
