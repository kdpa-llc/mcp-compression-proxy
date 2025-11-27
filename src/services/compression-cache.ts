import type { CompressedToolCache, CompressionStats } from '../types/compression.js';
import type { CacheMetrics } from '../types/compression.js';
import type { Logger } from 'pino';
import { CompressionPersistence } from './compression-persistence.js';
import { matchesIgnorePattern } from '../config/loader.js';

/**
 * In-memory cache for compressed tool descriptions
 * Key format: "serverName:toolName"
 */
export class CompressionCache {
  private cache: CompressedToolCache = {};
  private logger: Logger;
  private persistence: CompressionPersistence;
  private noCompressPatterns: string[] = [];
  private fallbackBehavior: 'original' | 'blank' = 'original';

  constructor(logger: Logger, persistence?: CompressionPersistence) {
    this.logger = logger;
    this.persistence = persistence || new CompressionPersistence(logger);
  }

  /**
   * Set fallback behavior for when no compressed description exists
   */
  setFallbackBehavior(behavior: 'original' | 'blank'): void {
    this.fallbackBehavior = behavior;
    this.logger.debug({ behavior }, 'Set compression fallback behavior');
  }

  /**
   * Set patterns for tools that should display original descriptions
   * (tools are still compressed and cached, but show original when listing)
   */
  setNoCompressPatterns(patterns: string[]): void {
    this.noCompressPatterns = patterns;
    this.logger.debug(
      { patterns },
      'Set noCompress patterns (display-only bypass)'
    );
  }

  /**
   * Get all cached entries (for reporting/stats)
   */
  getCacheEntries(): Array<{
    serverName: string;
    toolName: string;
    original?: string;
    compressed: string;
    compressedAt: string;
  }> {
    return Object.entries(this.cache).map(([key, value]) => {
      const [serverName, toolName] = key.split(':');
      return {
        serverName,
        toolName,
        original: value.original,
        compressed: value.compressed,
        compressedAt: value.compressedAt,
      };
    });
  }

  /**
   * Check if a tool should bypass compression display
   * (for showing original descriptions while still caching compressed versions)
   */
  private shouldBypassCompression(toolName: string): boolean {
    return matchesIgnorePattern(toolName, this.noCompressPatterns);
  }

  /**
   * Generate cache key from server and tool name
   */
  private getKey(serverName: string, toolName: string): string {
    return `${serverName}:${toolName}`;
  }

  /**
   * Save compressed description for a tool
   * Always saves compression to cache regardless of noCompress patterns
   */
  saveCompressed(
    serverName: string,
    toolName: string,
    compressedDescription: string,
    originalDescription?: string
  ): void {
    const key = this.getKey(serverName, toolName);

    this.cache[key] = {
      original: originalDescription,
      compressed: compressedDescription,
      compressedAt: new Date().toISOString(),
    };

    this.logger.debug(
      { serverName, toolName },
      'Saved compressed description'
    );
  }

  /**
   * Get description for a tool (session-aware)
   * - If tool matches noCompress pattern: always use original (display-only bypass)
   * - If tool is expanded in session: use original
   * - If compressed exists: use compressed
   * - Otherwise: use original
   */
  getDescription(
    serverName: string,
    toolName: string,
    originalDescription?: string,
    isExpandedInSession?: boolean
  ): string | undefined {
    const fullToolName = `${serverName}__${toolName}`;
    const key = this.getKey(serverName, toolName);

    // Always bypass compression for noCompress patterns
    if (this.shouldBypassCompression(fullToolName)) {
      return originalDescription;
    }

    // If tool is expanded in session, use original description
    if (isExpandedInSession) {
      return this.cache[key]?.original || originalDescription;
    }

    // Otherwise use compressed if available, fallback to behavior
    if (this.cache[key]?.compressed) {
      return this.cache[key].compressed;
    }

    // No compressed description available - use fallback behavior
    return this.fallbackBehavior === 'blank' ? '' : originalDescription;
  }

  /**
   * Check if a tool has compressed description
   */
  hasCompressed(serverName: string, toolName: string): boolean {
    const key = this.getKey(serverName, toolName);
    return !!this.cache[key]?.compressed;
  }

  /**
   * Get original description if cached
   */
  getOriginalDescription(
    serverName: string,
    toolName: string
  ): string | undefined {
    const key = this.getKey(serverName, toolName);
    return this.cache[key]?.original;
  }

  /**
   * Get compressed description if cached
   */
  getCompressedDescription(
    serverName: string,
    toolName: string
  ): string | undefined {
    const key = this.getKey(serverName, toolName);
    return this.cache[key]?.compressed;
  }

  /**
   * Get compression statistics
   */
  getStats(): CompressionStats {
    return {
      totalTools: Object.keys(this.cache).length,
      compressedTools: Object.keys(this.cache).length,
      expandedTools: [],
      cacheSize: JSON.stringify(this.cache).length,
    };
  }

  /**
   * Detailed cache metrics for reporting
   */
  getCacheMetrics(): CacheMetrics {
    const entries = this.getCacheEntries();

    const perServer: CacheMetrics['perServer'] = {};
    let totalOriginalChars = 0;
    let totalCompressedChars = 0;
    let missingOriginals = 0;
    let latestCompressedAt: string | undefined;

    for (const entry of entries) {
      const originalLength = entry.original?.length ?? 0;
      const compressedLength = entry.compressed.length;

      if (!perServer[entry.serverName]) {
        perServer[entry.serverName] = {
          cached: 0,
          totalOriginalChars: 0,
          totalCompressedChars: 0,
          missingOriginals: 0,
          latestCompressedAt: undefined,
        };
      }

      perServer[entry.serverName].cached += 1;
      perServer[entry.serverName].totalOriginalChars += originalLength;
      perServer[entry.serverName].totalCompressedChars += compressedLength;
      if (!entry.original) {
        perServer[entry.serverName].missingOriginals += 1;
      }
      const serverLatest = perServer[entry.serverName].latestCompressedAt;
      if (entry.compressedAt && (!serverLatest || serverLatest < entry.compressedAt)) {
        perServer[entry.serverName].latestCompressedAt = entry.compressedAt;
      }

      totalOriginalChars += originalLength;
      totalCompressedChars += compressedLength;
      if (!entry.original) missingOriginals += 1;
      if (!latestCompressedAt || latestCompressedAt < entry.compressedAt) {
        latestCompressedAt = entry.compressedAt;
      }
    }

    return {
      totalCached: entries.length,
      totalOriginalChars,
      totalCompressedChars,
      missingOriginals,
      latestCompressedAt,
      cacheSizeBytes: Buffer.byteLength(JSON.stringify(this.cache)),
      perServer,
    };
  }

  /**
   * Clear all compressed descriptions
   */
  clear(): void {
    this.cache = {};
    this.logger.info('Cleared compression cache');
  }

  /**
   * Get all cached tools
   */
  getAllCached(): Array<{ serverName: string; toolName: string }> {
    return Object.keys(this.cache).map((key) => {
      const [serverName, toolName] = key.split(':');
      return { serverName, toolName };
    });
  }

  /**
   * Load cache from disk
   */
  async loadFromDisk(): Promise<void> {
    const loadedCache = await this.persistence.load();

    // Convert Map to cache object
    for (const [key, value] of loadedCache.entries()) {
      this.cache[key] = value;
    }

    this.logger.info(
      { count: Object.keys(this.cache).length },
      'Loaded compression cache into memory'
    );
  }

  /**
   * Save cache to disk
   */
  async saveToDisk(): Promise<void> {
    // Convert cache object to Map
    const cacheMap = new Map(Object.entries(this.cache));
    await this.persistence.save(cacheMap);
  }

  /**
   * Clear cache from both memory and disk
   */
  async clearAll(): Promise<void> {
    this.clear();
    await this.persistence.clear();
  }

  /**
   * Get on-disk cache file path if available
   */
  getCacheFilePath(): string {
    return this.persistence.getCacheFilePath();
  }
}
