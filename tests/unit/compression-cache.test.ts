import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import { CompressionCache } from '../../src/services/compression-cache.js';
import { CompressionPersistence } from '../../src/services/compression-persistence.js';
import type { Logger } from 'pino';

describe('CompressionCache', () => {
  let cache: CompressionCache;
  let mockLogger: Logger;
  let mockPersistence: jest.Mocked<CompressionPersistence>;

  beforeEach(() => {
    mockLogger = {
      debug: jest.fn(),
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    } as unknown as Logger;

    mockPersistence = {
      load: jest.fn(),
      save: jest.fn(),
      clear: jest.fn(),
      getCacheFilePath: jest.fn(),
    } as unknown as jest.Mocked<CompressionPersistence>;

    cache = new CompressionCache(mockLogger, mockPersistence);
  });

  describe('saveCompressed', () => {
    it('should save compressed description with original', () => {
      const serverName = 'filesystem';
      const toolName = 'read_file';
      const compressed = 'Read file (text, max 10MB)';
      const original = 'Reads the complete contents of a file at the specified path';

      cache.saveCompressed(serverName, toolName, compressed, original);

      expect(cache.hasCompressed(serverName, toolName)).toBe(true);
      expect(cache.getCompressedDescription(serverName, toolName)).toBe(compressed);
      expect(cache.getOriginalDescription(serverName, toolName)).toBe(original);
    });

    it('should save compressed description without original', () => {
      const serverName = 'github';
      const toolName = 'create_issue';
      const compressed = 'Create GH issue';

      cache.saveCompressed(serverName, toolName, compressed);

      expect(cache.hasCompressed(serverName, toolName)).toBe(true);
      expect(cache.getCompressedDescription(serverName, toolName)).toBe(compressed);
      expect(cache.getOriginalDescription(serverName, toolName)).toBeUndefined();
    });

    it('should overwrite existing compressed description', () => {
      const serverName = 'filesystem';
      const toolName = 'write_file';
      const compressed1 = 'Write file v1';
      const compressed2 = 'Write file v2';

      cache.saveCompressed(serverName, toolName, compressed1);
      cache.saveCompressed(serverName, toolName, compressed2);

      expect(cache.getCompressedDescription(serverName, toolName)).toBe(compressed2);
    });
  });

  describe('getDescription', () => {
    it('should return compressed description when not expanded', () => {
      const serverName = 'filesystem';
      const toolName = 'read_file';
      const compressed = 'Read file (compressed)';
      const original = 'Read file (original long description)';

      cache.saveCompressed(serverName, toolName, compressed, original);

      const result = cache.getDescription(
        serverName,
        toolName,
        original,
        false // not expanded
      );

      expect(result).toBe(compressed);
    });

    it('should return original description when expanded in session', () => {
      const serverName = 'filesystem';
      const toolName = 'read_file';
      const compressed = 'Read file (compressed)';
      const original = 'Read file (original long description)';

      cache.saveCompressed(serverName, toolName, compressed, original);

      const result = cache.getDescription(
        serverName,
        toolName,
        original,
        true // expanded
      );

      expect(result).toBe(original);
    });

    it('should return fallback original description if no compression exists', () => {
      const serverName = 'unknown';
      const toolName = 'unknown_tool';
      const original = 'Original description';

      const result = cache.getDescription(
        serverName,
        toolName,
        original,
        false
      );

      expect(result).toBe(original);
    });

    it('should return undefined if no description available', () => {
      const result = cache.getDescription('unknown', 'unknown_tool');
      expect(result).toBeUndefined();
    });
  });

  describe('hasCompressed', () => {
    it('should return true for compressed tools', () => {
      cache.saveCompressed('server1', 'tool1', 'compressed');
      expect(cache.hasCompressed('server1', 'tool1')).toBe(true);
    });

    it('should return false for non-compressed tools', () => {
      expect(cache.hasCompressed('server1', 'tool1')).toBe(false);
    });
  });

  describe('getOriginalDescription', () => {
    it('should return original description if cached', () => {
      const original = 'Original description';
      cache.saveCompressed('server1', 'tool1', 'compressed', original);

      expect(cache.getOriginalDescription('server1', 'tool1')).toBe(original);
    });

    it('should return undefined if no original cached', () => {
      cache.saveCompressed('server1', 'tool1', 'compressed');
      expect(cache.getOriginalDescription('server1', 'tool1')).toBeUndefined();
    });

    it('should return undefined if tool not in cache', () => {
      expect(cache.getOriginalDescription('server1', 'tool1')).toBeUndefined();
    });
  });

  describe('getCompressedDescription', () => {
    it('should return compressed description if cached', () => {
      const compressed = 'Compressed description';
      cache.saveCompressed('server1', 'tool1', compressed);

      expect(cache.getCompressedDescription('server1', 'tool1')).toBe(compressed);
    });

    it('should return undefined if tool not in cache', () => {
      expect(cache.getCompressedDescription('server1', 'tool1')).toBeUndefined();
    });
  });

  describe('getStats', () => {
    it('should return correct statistics for empty cache', () => {
      const stats = cache.getStats();

      expect(stats.totalTools).toBe(0);
      expect(stats.compressedTools).toBe(0);
      expect(stats.expandedTools).toEqual([]);
      expect(stats.cacheSize).toBeGreaterThan(0);
    });

    it('should return correct statistics with cached tools', () => {
      cache.saveCompressed('server1', 'tool1', 'compressed1', 'original1');
      cache.saveCompressed('server2', 'tool2', 'compressed2', 'original2');

      const stats = cache.getStats();

      expect(stats.totalTools).toBe(2);
      expect(stats.compressedTools).toBe(2);
      expect(stats.cacheSize).toBeGreaterThan(0);
    });
  });

  describe('getCacheMetrics', () => {
    it('should compute metrics for cached entries', () => {
      cache.saveCompressed('server1', 'tool1', 'compressed', 'original');
      cache.saveCompressed('server1', 'tool2', 'compressed-two');
      cache.saveCompressed('server2', 'tool3', 'c3', 'orig3');

      const metrics = cache.getCacheMetrics();

      expect(metrics.totalCached).toBe(3);
      expect(metrics.totalCompressedChars).toBe(
        'compressed'.length + 'compressed-two'.length + 'c3'.length
      );
      expect(metrics.totalOriginalChars).toBe('original'.length + 0 + 'orig3'.length);
      expect(metrics.missingOriginals).toBe(1);
      expect(metrics.perServer.server1.cached).toBe(2);
      expect(metrics.perServer.server2.cached).toBe(1);
      expect(metrics.cacheSizeBytes).toBeGreaterThan(0);
      expect(metrics.latestCompressedAt).toBeDefined();
    });
  });

  describe('clear', () => {
    it('should clear all cached descriptions', () => {
      cache.saveCompressed('server1', 'tool1', 'compressed1');
      cache.saveCompressed('server2', 'tool2', 'compressed2');

      expect(cache.getStats().totalTools).toBe(2);

      cache.clear();

      expect(cache.getStats().totalTools).toBe(0);
      expect(cache.hasCompressed('server1', 'tool1')).toBe(false);
      expect(cache.hasCompressed('server2', 'tool2')).toBe(false);
    });
  });

  describe('getAllCached', () => {
    it('should return empty array for empty cache', () => {
      const cached = cache.getAllCached();
      expect(cached).toEqual([]);
    });

    it('should return all cached tools', () => {
      cache.saveCompressed('filesystem', 'read_file', 'compressed');
      cache.saveCompressed('github', 'create_issue', 'compressed');

      const cached = cache.getAllCached();

      expect(cached).toHaveLength(2);
      expect(cached).toContainEqual({ serverName: 'filesystem', toolName: 'read_file' });
      expect(cached).toContainEqual({ serverName: 'github', toolName: 'create_issue' });
    });
  });

  describe('edge cases', () => {
    it('should handle tools with special characters in names', () => {
      const serverName = 'server-with-dash';
      const toolName = 'tool_with_underscore';
      const compressed = 'Compressed';

      cache.saveCompressed(serverName, toolName, compressed);

      expect(cache.hasCompressed(serverName, toolName)).toBe(true);
      expect(cache.getCompressedDescription(serverName, toolName)).toBe(compressed);
    });

    it('should handle empty string descriptions', () => {
      cache.saveCompressed('server1', 'tool1', '', '');

      // Note: hasCompressed returns false for empty strings due to !! coercion
      // This is a limitation of the current implementation
      expect(cache.hasCompressed('server1', 'tool1')).toBe(false);
      expect(cache.getCompressedDescription('server1', 'tool1')).toBe('');
      expect(cache.getOriginalDescription('server1', 'tool1')).toBe('');
    });

    it('should handle very long descriptions', () => {
      const longDesc = 'A'.repeat(10000);
      cache.saveCompressed('server1', 'tool1', longDesc, longDesc);

      expect(cache.getCompressedDescription('server1', 'tool1')).toBe(longDesc);
    });
  });

  describe('noCompress patterns (display-only bypass)', () => {
    it('should still save compressed description for tools matching noCompress pattern', () => {
      cache.setNoCompressPatterns(['filesystem__*']);

      const serverName = 'filesystem';
      const toolName = 'read_file';
      const compressed = 'Read file (compressed)';
      const original = 'Read file (original)';

      cache.saveCompressed(serverName, toolName, compressed, original);

      // Tool should be cached even with noCompress pattern
      expect(cache.hasCompressed(serverName, toolName)).toBe(true);
      expect(cache.getCompressedDescription(serverName, toolName)).toBe(compressed);
      expect(cache.getOriginalDescription(serverName, toolName)).toBe(original);
    });

    it('should always return original description for noCompress tools', () => {
      cache.setNoCompressPatterns(['github__*']);

      const serverName = 'github';
      const toolName = 'create_issue';
      const original = 'Create GitHub issue (original)';

      const result = cache.getDescription(serverName, toolName, original, false);

      expect(result).toBe(original);
    });

    it('should cache all tools regardless of noCompress patterns', () => {
      cache.setNoCompressPatterns(['*__delete*']);

      cache.saveCompressed('filesystem', 'delete_file', 'compressed', 'original');
      cache.saveCompressed('github', 'delete_repo', 'compressed', 'original');

      // Both tools should be cached now
      expect(cache.hasCompressed('filesystem', 'delete_file')).toBe(true);
      expect(cache.hasCompressed('github', 'delete_repo')).toBe(true);
    });

    it('should allow compression for all tools including those matching noCompress pattern', () => {
      cache.setNoCompressPatterns(['filesystem__*']);

      cache.saveCompressed('filesystem', 'read_file', 'compressed1', 'original1');
      cache.saveCompressed('github', 'create_issue', 'compressed2', 'original2');

      // Both should be cached now
      expect(cache.hasCompressed('filesystem', 'read_file')).toBe(true);
      expect(cache.hasCompressed('github', 'create_issue')).toBe(true);
    });

    it('should respect noCompress patterns for display even when expanded in session', () => {
      cache.setNoCompressPatterns(['filesystem__*']);

      const serverName = 'filesystem';
      const toolName = 'read_file';
      const original = 'Read file (original)';

      // Even if expanded in session, should return original for noCompress tools
      const result = cache.getDescription(serverName, toolName, original, true);

      expect(result).toBe(original);
    });

    it('should cache all tools but display originals for matching patterns', () => {
      cache.setNoCompressPatterns(['filesystem__*', 'github__delete*', '*__experimental*']);

      cache.saveCompressed('filesystem', 'read_file', 'c1', 'o1');
      cache.saveCompressed('github', 'delete_repo', 'c2', 'o2');
      cache.saveCompressed('server', 'experimental_feature', 'c3', 'o3');
      cache.saveCompressed('github', 'create_issue', 'c4', 'o4');

      // All should be cached now
      expect(cache.hasCompressed('filesystem', 'read_file')).toBe(true);
      expect(cache.hasCompressed('github', 'delete_repo')).toBe(true);
      expect(cache.hasCompressed('server', 'experimental_feature')).toBe(true);
      expect(cache.hasCompressed('github', 'create_issue')).toBe(true);

      // But display behavior should respect patterns
      expect(cache.getDescription('filesystem', 'read_file', 'o1', false)).toBe('o1');
      expect(cache.getDescription('github', 'delete_repo', 'o2', false)).toBe('o2');
      expect(cache.getDescription('server', 'experimental_feature', 'o3', false)).toBe('o3');
      expect(cache.getDescription('github', 'create_issue', 'o4', false)).toBe('c4'); // Should use compressed
    });

    it('should be case insensitive for noCompress patterns', () => {
      cache.setNoCompressPatterns(['FileSystem__*']);

      cache.saveCompressed('filesystem', 'read_file', 'compressed', 'original');

      // Should be cached
      expect(cache.hasCompressed('filesystem', 'read_file')).toBe(true);
      // But should display original
      expect(cache.getDescription('filesystem', 'read_file', 'original', false)).toBe('original');
    });
  });

  describe('persistence integration', () => {
    describe('loadFromDisk', () => {
      it('should load cache from persistence', async () => {
        const mockCache = new Map([
          [
            'filesystem:read_file',
            {
              original: 'Read file original',
              compressed: 'Read file compressed',
              compressedAt: '2024-01-01T00:00:00.000Z',
            },
          ],
        ]);

        mockPersistence.load.mockResolvedValue(mockCache);

        await cache.loadFromDisk();

        expect(mockPersistence.load).toHaveBeenCalled();
        expect(cache.hasCompressed('filesystem', 'read_file')).toBe(true);
        expect(cache.getCompressedDescription('filesystem', 'read_file')).toBe(
          'Read file compressed'
        );
      });

      it('should handle empty cache from disk', async () => {
        mockPersistence.load.mockResolvedValue(new Map());

        await cache.loadFromDisk();

        expect(cache.getStats().totalTools).toBe(0);
      });
    });

    describe('saveToDisk', () => {
      it('should save cache to persistence', async () => {
        cache.saveCompressed('server1', 'tool1', 'compressed', 'original');

        await cache.saveToDisk();

        expect(mockPersistence.save).toHaveBeenCalled();
        const savedMap = (mockPersistence.save as jest.Mock).mock.calls[0][0] as Map<string, { original?: string; compressed: string; compressedAt: string }>;
        expect(savedMap.size).toBe(1);
        expect(savedMap.get('server1:tool1')).toMatchObject({
          compressed: 'compressed',
          original: 'original',
        });
      });

      it('should save empty cache', async () => {
        await cache.saveToDisk();

        expect(mockPersistence.save).toHaveBeenCalled();
        const savedMap = (mockPersistence.save as jest.Mock).mock.calls[0][0] as Map<string, { original?: string; compressed: string; compressedAt: string }>;
        expect(savedMap.size).toBe(0);
      });
    });

    describe('clearAll', () => {
      it('should clear both memory and disk', async () => {
        cache.saveCompressed('server1', 'tool1', 'compressed');

        expect(cache.hasCompressed('server1', 'tool1')).toBe(true);

        await cache.clearAll();

        expect(cache.hasCompressed('server1', 'tool1')).toBe(false);
        expect(mockPersistence.clear).toHaveBeenCalled();
      });
    });
  });
});
