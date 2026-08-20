import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import type { Logger } from 'pino';
import type { CompressionPersistence } from '../../src/services/compression-persistence.js';
import { CompressionCache } from '../../src/services/compression-cache.js';

/**
 * Fallback behavior for tools that have no compressed description yet (#15).
 */
describe('CompressionCache fallback behavior', () => {
  let cache: CompressionCache;

  beforeEach(() => {
    const mockLogger = {
      debug: jest.fn(),
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    } as unknown as Logger;

    const mockPersistence = {
      load: jest.fn(),
      save: jest.fn(),
      clear: jest.fn(),
      getCacheFilePath: jest.fn().mockReturnValue('/tmp/cache.json'),
    } as unknown as jest.Mocked<CompressionPersistence>;

    cache = new CompressionCache(mockLogger, mockPersistence);
  });

  it('defaults to original so existing configs are unaffected', () => {
    expect(cache.getFallbackBehavior()).toBe('original');
    expect(cache.getDescription('srv', 'tool', 'the original')).toBe('the original');
  });

  it('returns an empty description for uncached tools when set to blank', () => {
    cache.setFallbackBehavior('blank');

    expect(cache.getDescription('srv', 'tool', 'the original')).toBe('');
  });

  it('only affects uncached tools - compressed ones still show compressed', () => {
    cache.setFallbackBehavior('blank');
    cache.saveCompressed('srv', 'tool', 'short', 'the original');

    expect(cache.getDescription('srv', 'tool', 'the original')).toBe('short');
  });

  it('still shows the original for tools expanded in a session', () => {
    cache.setFallbackBehavior('blank');
    cache.saveCompressed('srv', 'tool', 'short', 'the original');

    expect(cache.getDescription('srv', 'tool', 'the original', true)).toBe('the original');
  });

  it('still honours noCompress patterns over the blank fallback', () => {
    cache.setFallbackBehavior('blank');
    cache.setNoCompressPatterns(['srv__*']);

    expect(cache.getDescription('srv', 'tool', 'the original')).toBe('the original');
  });

  it('keeps caching originals so later expansion works', () => {
    cache.setFallbackBehavior('blank');
    cache.saveCompressed('srv', 'tool', 'short', 'the original');

    expect(cache.getOriginalDescription('srv', 'tool')).toBe('the original');
  });

  it('handles a missing original description under both behaviors', () => {
    expect(cache.getDescription('srv', 'tool', undefined)).toBeUndefined();

    cache.setFallbackBehavior('blank');
    expect(cache.getDescription('srv', 'tool', undefined)).toBe('');
  });
});
