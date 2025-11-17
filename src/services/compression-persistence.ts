import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import type { Logger } from 'pino';

/**
 * Persistent storage format for compressed tool descriptions
 */
interface PersistedCompressionCache {
  version: number;
  lastUpdated: string;
  compressions: Array<{
    serverName: string;
    toolName: string;
    originalDescription?: string;
    compressedDescription: string;
    compressedAt: string;
  }>;
}

/**
 * Service for persisting compressed tool descriptions to disk
 */
export class CompressionPersistence {
  private logger: Logger;
  private cacheDir: string;
  private cacheFile: string;
  private readonly VERSION = 1;

  constructor(logger: Logger, cacheDir?: string) {
    this.logger = logger;
    this.cacheDir = cacheDir || path.join(os.homedir(), '.mcp-compression-proxy');
    this.cacheFile = path.join(this.cacheDir, 'cache.json');
  }

  /**
   * Load cached compressions from disk
   */
  async load(): Promise<Map<string, { original?: string; compressed: string; compressedAt: string }>> {
    const cache = new Map<string, { original?: string; compressed: string; compressedAt: string }>();

    try {
      // Check if cache file exists
      await fs.access(this.cacheFile);

      // Read and parse cache file
      const data = await fs.readFile(this.cacheFile, 'utf-8');
      const persisted: PersistedCompressionCache = JSON.parse(data);

      // Validate version
      if (persisted.version !== this.VERSION) {
        this.logger.warn(
          { fileVersion: persisted.version, currentVersion: this.VERSION },
          'Cache version mismatch, ignoring cached data'
        );
        return cache;
      }

      // Load compressions into map
      for (const comp of persisted.compressions) {
        const key = `${comp.serverName}:${comp.toolName}`;
        cache.set(key, {
          original: comp.originalDescription,
          compressed: comp.compressedDescription,
          compressedAt: comp.compressedAt,
        });
      }

      this.logger.info(
        { count: cache.size, file: this.cacheFile },
        'Loaded compression cache from disk'
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        this.logger.debug('No cache file found, starting with empty cache');
      } else {
        this.logger.error({ error, file: this.cacheFile }, 'Failed to load cache from disk');
      }
    }

    return cache;
  }

  /**
   * Save compressions to disk
   */
  async save(cache: Map<string, { original?: string; compressed: string; compressedAt: string }>): Promise<void> {
    try {
      // Ensure cache directory exists
      await fs.mkdir(this.cacheDir, { recursive: true });

      // Convert cache map to persisted format
      const compressions = Array.from(cache.entries()).map(([key, value]) => {
        const [serverName, toolName] = key.split(':');
        return {
          serverName,
          toolName,
          originalDescription: value.original,
          compressedDescription: value.compressed,
          compressedAt: value.compressedAt,
        };
      });

      const persisted: PersistedCompressionCache = {
        version: this.VERSION,
        lastUpdated: new Date().toISOString(),
        compressions,
      };

      // Write to file with pretty formatting for debuggability
      await fs.writeFile(this.cacheFile, JSON.stringify(persisted, null, 2), 'utf-8');

      this.logger.info(
        { count: compressions.length, file: this.cacheFile },
        'Saved compression cache to disk'
      );
    } catch (error) {
      this.logger.error({ error, file: this.cacheFile }, 'Failed to save cache to disk');
      throw error;
    }
  }

  /**
   * Clear the cache file from disk
   */
  async clear(): Promise<void> {
    try {
      await fs.unlink(this.cacheFile);
      this.logger.info({ file: this.cacheFile }, 'Cleared cache file from disk');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        this.logger.debug('Cache file does not exist, nothing to clear');
      } else {
        this.logger.error({ error, file: this.cacheFile }, 'Failed to clear cache file');
        throw error;
      }
    }
  }

  /**
   * Get the cache file path (useful for debugging)
   */
  getCacheFilePath(): string {
    return this.cacheFile;
  }
}
