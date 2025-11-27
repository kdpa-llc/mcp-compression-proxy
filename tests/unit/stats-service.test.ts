import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import type { Logger } from 'pino';
import type { MCPClientManager } from '../../src/mcp/client-manager.js';
import type { CompressionPersistence } from '../../src/services/compression-persistence.js';
import { CompressionCache } from '../../src/services/compression-cache.js';
import { SessionManager } from '../../src/services/session-manager.js';
import { StatsService } from '../../src/services/stats-service.js';

describe('StatsService', () => {
  let mockLogger: Logger;
  let mockClientManager: jest.Mocked<MCPClientManager>;
  let mockPersistence: jest.Mocked<CompressionPersistence>;
  let cache: CompressionCache;
  let sessionManager: SessionManager;

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
      getCacheFilePath: jest.fn().mockReturnValue('/tmp/cache.json'),
    } as unknown as jest.Mocked<CompressionPersistence>;

    cache = new CompressionCache(mockLogger, mockPersistence);
    sessionManager = new SessionManager(mockLogger);

    mockClientManager = {
      getConnectedClients: jest.fn(),
      getServerStatuses: jest.fn(),
      initializeServers: jest.fn(),
      disconnectAll: jest.fn(),
      getClient: jest.fn(),
      hasConnectedServers: jest.fn(),
    } as unknown as jest.Mocked<MCPClientManager>;
  });

  afterEach(() => {
    sessionManager.destroy();
  });

  it('returns summary and full stats including coverage, cache, sessions, and config', async () => {
    const listTools = async () => ({
      tools: [
        { name: 'read', description: 'read original' },
        { name: 'write', description: 'write original' },
        { name: 'skip_me', description: 'skip original' },
      ],
    });

    mockClientManager.getConnectedClients.mockReturnValue([
      { name: 'serverA', client: { listTools } as any },
    ]);
    mockClientManager.getServerStatuses.mockReturnValue([
      { name: 'serverA', connected: true },
    ]);

    // One compressed tool with original
    cache.saveCompressed('serverA', 'write', 'write cmp', 'write original');

    // Active session with an expanded tool
    const sessionId = sessionManager.createSession();
    sessionManager.expandTool(sessionId, 'serverA', 'read');

    const configLoader = () => ({
      servers: [{ name: 'serverA', command: 'cmd' }],
      excludePatterns: ['serverA__skip_*'],
      noCompressPatterns: ['serverA__no_compress_*'],
      defaultTimeout: 30,
      compressionFallbackBehavior: 'original' as const,
    });

    const service = new StatsService(
      mockLogger,
      mockClientManager,
      cache,
      sessionManager,
      configLoader
    );

    const stats = await service.getStats({ detailLevel: 'full' });

    // Summary
    expect(stats.summary.serversConfigured).toBe(1);
    expect(stats.summary.serversConnected).toBe(1);
    expect(stats.summary.toolsTotal).toBe(2); // one excluded
    expect(stats.summary.toolsCompressed).toBe(1);
    expect(stats.summary.toolsUncompressed).toBe(1);
    expect(stats.summary.coveragePercent).toBe(50);

    // Per-server
    expect(stats.servers).toHaveLength(1);
    const server = stats.servers[0];
    expect(server.name).toBe('serverA');
    expect(server.toolsExcluded).toBe(1);
    expect(server.toolsTotal).toBe(2);
    expect(server.toolsCompressed).toBe(1);
    expect(server.toolsUncompressed).toBe(1);
    expect(server.coveragePercent).toBe(50);

    // Cache/compression details
    expect(stats.compression.cacheEntries).toBe(1);
    expect(stats.compression.cacheFilePath).toBe('/tmp/cache.json');
    expect(stats.compression.cacheSizeBytes).toBeGreaterThan(0);
    expect(stats.compression.totalOriginalChars).toBeGreaterThan(0);
    expect(stats.compression.totalCompressedChars).toBeGreaterThan(0);

    // Sessions
    expect(stats.sessions.activeSessions).toBe(1);
    expect(stats.sessions.expandedToolsTotal).toBe(1);
    expect(stats.sessions.sessions?.[0].sessionId).toBe(sessionId);

    // Config echo
    expect(stats.config.excludePatterns).toContain('serverA__skip_*');
    expect(stats.config.noCompressPatterns).toContain('serverA__no_compress_*');
  });

  it('throws a clear error for unknown servers', async () => {
    mockClientManager.getConnectedClients.mockReturnValue([]);
    mockClientManager.getServerStatuses.mockReturnValue([]);

    const service = new StatsService(
      mockLogger,
      mockClientManager,
      cache,
      sessionManager,
      () => ({
        servers: [],
        excludePatterns: [],
        noCompressPatterns: [],
        compressionFallbackBehavior: 'original' as const
      })
    );

    await expect(service.getStats({ serverName: 'missing' })).rejects.toThrow(
      "Server 'missing' is not configured or not initialized"
    );
  });

  it('keeps disconnected servers in the report with errors noted', async () => {
    mockClientManager.getConnectedClients.mockReturnValue([]);
    mockClientManager.getServerStatuses.mockReturnValue([
      { name: 'offline', connected: false, lastError: 'Connection failed' } as any,
    ]);

    const service = new StatsService(
      mockLogger,
      mockClientManager,
      cache,
      sessionManager,
      () => ({
        servers: [],
        excludePatterns: [],
        noCompressPatterns: [],
        compressionFallbackBehavior: 'original' as const
      })
    );

    const stats = await service.getStats();

    expect(stats.servers).toHaveLength(1);
    expect(stats.servers[0].connected).toBe(false);
    expect(stats.servers[0].error).toBe('Connection failed');
    expect(stats.summary.serversWithErrors).toBe(1);
  });
});
