import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import { CompressionCache } from '../../src/services/compression-cache.js';
import type { Logger } from 'pino';

describe('CompressionCache', () => {
  let cache: CompressionCache;
  let mockLogger: Logger;

  beforeEach(() => {
    mockLogger = {
      debug: jest.fn(),
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    } as unknown as Logger;

    cache = new CompressionCache(mockLogger);
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
});
