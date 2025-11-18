import type { CompressedToolCache, CompressionStats } from '../types/compression.js';
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

  constructor(logger: Logger, persistence?: CompressionPersistence) {
    this.logger = logger;
    this.persistence = persistence || new CompressionPersistence(logger);
  }

  /**
   * Set patterns for tools that should never be compressed
   */
  setNoCompressPatterns(patterns: string[]): void {
    this.noCompressPatterns = patterns;
    this.logger.debug(
      { patterns },
      'Set noCompress patterns'
    );
  }

  /**
   * Check if a tool should bypass compression
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
   * Skips compression if tool matches noCompress patterns
   */
  saveCompressed(
    serverName: string,
    toolName: string,
    compressedDescription: string,
    originalDescription?: string
  ): void {
    const fullToolName = `${serverName}__${toolName}`;

    // Skip compression for tools matching noCompress patterns
    if (this.shouldBypassCompression(fullToolName)) {
      this.logger.debug(
        { serverName, toolName },
        'Skipping compression (matches noCompress pattern)'
      );
      return;
    }

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
   * - If tool matches noCompress pattern: always use original
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

    // Otherwise use compressed if available, fallback to original
    return this.cache[key]?.compressed || originalDescription;
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
}
