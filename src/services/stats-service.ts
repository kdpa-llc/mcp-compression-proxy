import type { Logger } from 'pino';
import type { MCPClientManager } from '../mcp/client-manager.js';
import type { CompressionCache } from './compression-cache.js';
import type { SessionManager } from './session-manager.js';
import type { ConfigResult } from '../config/loader.js';
import { matchesIgnorePattern, loadJSONServersCached } from '../config/loader.js';

type DetailLevel = 'summary' | 'full';

type ServerToolStats = {
  name: string;
  connected: boolean;
  error?: string;
  toolsTotal: number;
  toolsCompressed: number;
  toolsUncompressed: number;
  toolsExcluded: number;
  coveragePercent: number;
  originalChars: number;
  compressedChars: number;
  estimatedTokensSaved: number;
};

export type StatsPayload = {
  summary: {
    serversConfigured: number;
    serversConnected: number;
    serversWithErrors: number;
    toolsTotal: number;
    toolsCompressed: number;
    toolsUncompressed: number;
    coveragePercent: number;
    originalChars: number;
    compressedChars: number;
    estimatedTokensSaved: number;
  };
  servers: ServerToolStats[];
  compression: {
    cacheEntries: number;
    cacheFilePath?: string;
    cacheSizeBytes: number;
    missingOriginals: number;
    latestCompressedAt?: string;
    totalOriginalChars: number;
    totalCompressedChars: number;
    estimatedTokensSaved: number;
  };
  sessions: {
    activeSessions: number;
    expandedToolsTotal: number;
    sessions?: Array<{ sessionId: string; expandedToolsCount: number }>;
  };
  config: {
    excludePatterns: string[];
    noCompressPatterns: string[];
  };
};

/** A tool as seen during aggregation, before its description is rewritten. */
export type ObservedTool = {
  serverName: string;
  toolName: string;
  description?: string;
};

/** Compression coverage over a set of tools, computed without extra I/O. */
export type LiveCoverage = {
  totalTools: number;
  compressedTools: number;
  uncompressedTools: number;
  coveragePercent: number;
  originalChars: number;
  compressedChars: number;
  estimatedTokensSaved: number;
  latestCompressedAt?: string;
};

/** Render a token/char count compactly (1234 -> "1.2k"). */
function compact(value: number): string {
  if (value < 1000) return `${value}`;
  if (value < 1_000_000) return `${(value / 1000).toFixed(1)}k`;
  return `${(value / 1_000_000).toFixed(1)}M`;
}

export class StatsService {
  private logger: Logger;
  private clientManager: MCPClientManager;
  private compressionCache: CompressionCache;
  private sessionManager: SessionManager;
  private configLoader: () => ConfigResult;

  constructor(
    logger: Logger,
    clientManager: MCPClientManager,
    compressionCache: CompressionCache,
    sessionManager: SessionManager,
    configLoader: () => ConfigResult = loadJSONServersCached
  ) {
    this.logger = logger;
    this.clientManager = clientManager;
    this.compressionCache = compressionCache;
    this.sessionManager = sessionManager;
    this.configLoader = configLoader;
  }

  async getStats(options?: {
    detailLevel?: DetailLevel;
    serverName?: string;
  }): Promise<StatsPayload> {
    const detailLevel: DetailLevel = options?.detailLevel === 'full' ? 'full' : 'summary';
    const serverFilter = options?.serverName;

    const config = this.configLoader() || {
      servers: [],
      excludePatterns: [],
      noCompressPatterns: [],
    };

    const excludePatterns = config.excludePatterns || [];
    const noCompressPatterns = config.noCompressPatterns || [];

    const serverStatuses = this.clientManager.getServerStatuses();
    const connectedClients = this.clientManager.getConnectedClients();

    const connectedClientMap = new Map(connectedClients.map((c) => [c.name, c.client]));

    const targetStatuses = serverFilter
      ? serverStatuses.filter((s) => s.name === serverFilter)
      : serverStatuses;

    if (serverFilter && targetStatuses.length === 0) {
      throw new Error(`Server '${serverFilter}' is not configured or not initialized`);
    }

    const serverStats: ServerToolStats[] = [];

    for (const status of targetStatuses) {
      if (!status.connected) {
        serverStats.push({
          name: status.name,
          connected: false,
          error: status.lastError || 'Not connected',
          toolsTotal: 0,
          toolsCompressed: 0,
          toolsUncompressed: 0,
          toolsExcluded: 0,
          coveragePercent: 0,
          originalChars: 0,
          compressedChars: 0,
          estimatedTokensSaved: 0,
        });
        continue;
      }

      const client = connectedClientMap.get(status.name);
      if (!client) {
        serverStats.push({
          name: status.name,
          connected: false,
          error: 'Client not available',
          toolsTotal: 0,
          toolsCompressed: 0,
          toolsUncompressed: 0,
          toolsExcluded: 0,
          coveragePercent: 0,
          originalChars: 0,
          compressedChars: 0,
          estimatedTokensSaved: 0,
        });
        continue;
      }

      try {
        const result = await client.listTools();
        const filtered = result.tools.filter(
          (tool) => !matchesIgnorePattern(`${status.name}__${tool.name}`, excludePatterns)
        );
        const excludedCount = result.tools.length - filtered.length;

        let toolsCompressed = 0;
        let originalChars = 0;
        let compressedChars = 0;

        for (const tool of filtered) {
          const original = this.compressionCache.getOriginalDescription(status.name, tool.name) ??
            tool.description ??
            '';
          const hasCompression = this.compressionCache.hasCompressed(status.name, tool.name);
          const compressed =
            this.compressionCache.getCompressedDescription(status.name, tool.name) ??
            (hasCompression ? '' : tool.description ?? '');

          if (hasCompression) {
            toolsCompressed += 1;
          }

          originalChars += original.length;
          compressedChars += compressed.length;
        }

        const toolsTotal = filtered.length;
        const toolsUncompressed = Math.max(toolsTotal - toolsCompressed, 0);
        const estimatedTokensSaved = this.calculateTokensSaved(originalChars, compressedChars);

        serverStats.push({
          name: status.name,
          connected: true,
          toolsTotal,
          toolsCompressed,
          toolsUncompressed,
          toolsExcluded: excludedCount,
          coveragePercent: this.coverage(toolsCompressed, toolsTotal),
          originalChars,
          compressedChars,
          estimatedTokensSaved,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        this.logger.warn({ server: status.name, error: message }, 'Failed to list tools for stats');

        serverStats.push({
          name: status.name,
          connected: true,
          error: message,
          toolsTotal: 0,
          toolsCompressed: 0,
          toolsUncompressed: 0,
          toolsExcluded: 0,
          coveragePercent: 0,
          originalChars: 0,
          compressedChars: 0,
          estimatedTokensSaved: 0,
        });
      }
    }

    const aggregateTotalTools = serverStats.reduce((sum, s) => sum + s.toolsTotal, 0);
    const aggregateCompressed = serverStats.reduce((sum, s) => sum + s.toolsCompressed, 0);
    const aggregateOriginalChars = serverStats.reduce((sum, s) => sum + s.originalChars, 0);
    const aggregateCompressedChars = serverStats.reduce((sum, s) => sum + s.compressedChars, 0);

    const cacheMetrics = this.compressionCache.getCacheMetrics();

    const sessions = this.sessionManager.getAllSessions();

    const payload: StatsPayload = {
      summary: {
        serversConfigured: config.servers?.length || serverStatuses.length,
        serversConnected: serverStatuses.filter((s) => s.connected).length,
        serversWithErrors: serverStatuses.filter((s) => !s.connected || s.lastError).length,
        toolsTotal: aggregateTotalTools,
        toolsCompressed: aggregateCompressed,
        toolsUncompressed: Math.max(aggregateTotalTools - aggregateCompressed, 0),
        coveragePercent: this.coverage(aggregateCompressed, aggregateTotalTools),
        originalChars: aggregateOriginalChars,
        compressedChars: aggregateCompressedChars,
        estimatedTokensSaved: this.calculateTokensSaved(
          aggregateOriginalChars,
          aggregateCompressedChars
        ),
      },
      servers: serverStats,
      compression: {
        cacheEntries: cacheMetrics.totalCached,
        cacheFilePath: this.compressionCache.getCacheFilePath(),
        cacheSizeBytes: cacheMetrics.cacheSizeBytes,
        missingOriginals: cacheMetrics.missingOriginals,
        latestCompressedAt: cacheMetrics.latestCompressedAt,
        totalOriginalChars: cacheMetrics.totalOriginalChars,
        totalCompressedChars: cacheMetrics.totalCompressedChars,
        estimatedTokensSaved: this.calculateTokensSaved(
          cacheMetrics.totalOriginalChars,
          cacheMetrics.totalCompressedChars
        ),
      },
      sessions: {
        activeSessions: sessions.length,
        expandedToolsTotal: sessions.reduce((sum, session) => sum + session.expandedTools.length, 0),
        sessions:
          detailLevel === 'full'
            ? sessions.map((session) => ({
                sessionId: session.sessionId,
                expandedToolsCount: session.expandedTools.length,
              }))
            : undefined,
      },
      config: {
        excludePatterns,
        noCompressPatterns,
      },
    };

    return payload;
  }

  /**
   * Compute coverage over tools already fetched during aggregation.
   *
   * Unlike {@link getStats} this issues no `listTools` calls, so it is cheap
   * enough to run on every `tools/list`.
   */
  computeCoverage(tools: ObservedTool[]): LiveCoverage {
    let compressedTools = 0;
    let originalChars = 0;
    let compressedChars = 0;
    let latestCompressedAt: string | undefined;

    for (const tool of tools) {
      const cachedOriginal = this.compressionCache.getOriginalDescription(
        tool.serverName,
        tool.toolName
      );
      const original = cachedOriginal ?? tool.description ?? '';
      const compressed = this.compressionCache.getCompressedDescription(
        tool.serverName,
        tool.toolName
      );

      originalChars += original.length;

      if (compressed !== undefined) {
        compressedTools += 1;
        compressedChars += compressed.length;
      } else {
        // Uncompressed tools still occupy their original description.
        compressedChars += original.length;
      }
    }

    for (const entry of this.compressionCache.getCacheEntries()) {
      if (!latestCompressedAt || latestCompressedAt < entry.compressedAt) {
        latestCompressedAt = entry.compressedAt;
      }
    }

    return {
      totalTools: tools.length,
      compressedTools,
      uncompressedTools: Math.max(tools.length - compressedTools, 0),
      coveragePercent: this.coverage(compressedTools, tools.length),
      originalChars,
      compressedChars,
      estimatedTokensSaved: this.calculateTokensSaved(originalChars, compressedChars),
      latestCompressedAt,
    };
  }

  /**
   * One-line coverage summary suitable for appending to a tool description.
   * Kept terse - it ships on every `tools/list`.
   */
  formatCoverage(coverage: LiveCoverage): string {
    if (coverage.totalTools === 0) {
      return '[live: no backend tools available]';
    }

    const parts = [
      `${coverage.compressedTools}/${coverage.totalTools} compressed (${coverage.coveragePercent}%)`,
      `${coverage.uncompressedTools} remaining`,
    ];

    if (coverage.estimatedTokensSaved > 0) {
      parts.push(`~${compact(coverage.estimatedTokensSaved)} tokens saved`);
    }

    return `[live: ${parts.join(' · ')}]`;
  }

  private coverage(done: number, total: number): number {
    if (!total) return 0;
    return Math.round((done / total) * 1000) / 10; // one decimal place
  }

  private calculateTokensSaved(originalChars: number, compressedChars: number): number {
    const savedChars = Math.max(originalChars - compressedChars, 0);
    return Math.round(savedChars / 4); // rough char->token estimate
  }
}
