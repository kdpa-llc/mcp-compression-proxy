import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import type { Logger } from 'pino';
import type { MCPClientManager } from '../../src/mcp/client-manager.js';
import type { CompressionPersistence } from '../../src/services/compression-persistence.js';
import { CompressionCache } from '../../src/services/compression-cache.js';
import { SessionManager } from '../../src/services/session-manager.js';
import { StatsService, type ObservedTool } from '../../src/services/stats-service.js';

/**
 * Live coverage stats surfaced in management tool descriptions (#16).
 */
describe('StatsService live coverage', () => {
  let cache: CompressionCache;
  let stats: StatsService;

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

    const mockClientManager = {
      getConnectedClients: jest.fn().mockReturnValue([]),
      getServerStatuses: jest.fn().mockReturnValue([]),
    } as unknown as jest.Mocked<MCPClientManager>;

    cache = new CompressionCache(mockLogger, mockPersistence);
    stats = new StatsService(
      mockLogger,
      mockClientManager,
      cache,
      new SessionManager(mockLogger),
      () => null
    );
  });

  const tools: ObservedTool[] = [
    { serverName: 'a', toolName: 'one', description: 'x'.repeat(100) },
    { serverName: 'a', toolName: 'two', description: 'y'.repeat(100) },
    { serverName: 'b', toolName: 'three', description: 'z'.repeat(200) },
  ];

  describe('computeCoverage', () => {
    it('reports zero coverage when nothing is compressed', () => {
      const coverage = stats.computeCoverage(tools);

      expect(coverage.totalTools).toBe(3);
      expect(coverage.compressedTools).toBe(0);
      expect(coverage.uncompressedTools).toBe(3);
      expect(coverage.coveragePercent).toBe(0);
      // Uncompressed tools still cost their original description.
      expect(coverage.estimatedTokensSaved).toBe(0);
    });

    it('counts compressed tools and the savings they produce', () => {
      cache.saveCompressed('a', 'one', 'short', 'x'.repeat(100));

      const coverage = stats.computeCoverage(tools);

      expect(coverage.compressedTools).toBe(1);
      expect(coverage.uncompressedTools).toBe(2);
      expect(coverage.coveragePercent).toBe(33.3);
      expect(coverage.originalChars).toBe(400);
      // 100 -> 5 for the compressed one, others unchanged.
      expect(coverage.compressedChars).toBe(305);
      expect(coverage.estimatedTokensSaved).toBe(Math.round(95 / 4));
    });

    it('reaches 100% when every tool is compressed', () => {
      for (const tool of tools) {
        cache.saveCompressed(tool.serverName, tool.toolName, 'c', tool.description);
      }

      const coverage = stats.computeCoverage(tools);

      expect(coverage.compressedTools).toBe(3);
      expect(coverage.uncompressedTools).toBe(0);
      expect(coverage.coveragePercent).toBe(100);
    });

    it('degrades gracefully with no tools at all', () => {
      const coverage = stats.computeCoverage([]);

      expect(coverage.totalTools).toBe(0);
      expect(coverage.coveragePercent).toBe(0);
      expect(coverage.estimatedTokensSaved).toBe(0);
      expect(coverage.latestCompressedAt).toBeUndefined();
    });

    it('handles tools with no description', () => {
      const coverage = stats.computeCoverage([
        { serverName: 'a', toolName: 'bare', description: undefined },
      ]);

      expect(coverage.totalTools).toBe(1);
      expect(coverage.originalChars).toBe(0);
    });

    it('prefers the cached original over the live description', () => {
      cache.saveCompressed('a', 'one', 'short', 'o'.repeat(500));

      const coverage = stats.computeCoverage([tools[0]]);

      // 500 from the cache, not the 100-char live description.
      expect(coverage.originalChars).toBe(500);
    });

    it('reflects a cleared cache immediately', () => {
      cache.saveCompressed('a', 'one', 'short', 'x'.repeat(100));
      expect(stats.computeCoverage(tools).compressedTools).toBe(1);

      cache.clear();
      expect(stats.computeCoverage(tools).compressedTools).toBe(0);
    });
  });

  describe('formatCoverage', () => {
    it('says so when there are no backend tools', () => {
      expect(stats.formatCoverage(stats.computeCoverage([]))).toBe(
        '[live: no backend tools available]'
      );
    });

    it('reports counts and remaining work', () => {
      const line = stats.formatCoverage(stats.computeCoverage(tools));

      expect(line).toContain('0/3 compressed (0%)');
      expect(line).toContain('3 remaining');
    });

    it('includes savings once there is something to report', () => {
      cache.saveCompressed('a', 'one', 'short', 'x'.repeat(100));

      const line = stats.formatCoverage(stats.computeCoverage(tools));

      expect(line).toContain('1/3 compressed (33.3%)');
      expect(line).toContain('2 remaining');
      expect(line).toContain('tokens saved');
    });

    it('omits savings when there are none', () => {
      expect(stats.formatCoverage(stats.computeCoverage(tools))).not.toContain('saved');
    });

    it('compacts large savings counts', () => {
      cache.saveCompressed('big', 'tool', 'c', 'x'.repeat(80_000));

      const line = stats.formatCoverage(
        stats.computeCoverage([{ serverName: 'big', toolName: 'tool' }])
      );

      expect(line).toMatch(/~\d+\.\dk tokens saved/);
    });
  });
});
