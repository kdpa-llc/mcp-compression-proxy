import type { CompressedToolCache, CompressionStats } from '../types/compression.js';
import type { Logger } from 'pino';
import { CompressionPersistence } from './compression-persistence.js';

/**
 * In-memory cache for compressed tool descriptions
 * Key format: "serverName:toolName"
 */
export class CompressionCache {
  private cache: CompressedToolCache = {};
  private logger: Logger;
  private persistence: CompressionPersistence;

  constructor(logger: Logger, persistence?: CompressionPersistence) {
    this.logger = logger;
    this.persistence = persistence || new CompressionPersistence(logger);
  }

  /**
   * Generate cache key from server and tool name
   */
  private getKey(serverName: string, toolName: string): string {
    return `${serverName}:${toolName}`;
  }

  /**
   * Save compressed description for a tool
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
    const key = this.getKey(serverName, toolName);

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
