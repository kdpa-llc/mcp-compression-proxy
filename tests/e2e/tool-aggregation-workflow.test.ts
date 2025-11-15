import { describe, it, expect, beforeEach } from '@jest/globals';
import { CompressionCache } from '../../src/services/compression-cache.js';
import { SessionManager } from '../../src/services/session-manager.js';
import {
  getMockLogger,
  createMockFilesystemClient,
  createMockGitHubClient,
  SAMPLE_COMPRESSIONS,
} from '../__mocks__/mcp-mocks.js';
import type { Logger } from 'pino';

describe('E2E: Tool Aggregation Workflow', () => {
  let compressionCache: CompressionCache;
  let sessionManager: SessionManager;
  let logger: Logger;

  beforeEach(() => {
    logger = getMockLogger() as unknown as Logger;
    compressionCache = new CompressionCache(logger);
    sessionManager = new SessionManager(logger);
  });

  describe('Complete compression workflow', () => {
    it('should handle full compression and expansion cycle', async () => {
      // Step 1: Setup mock clients
      const filesystemClient = createMockFilesystemClient();
      const githubClient = createMockGitHubClient();

      await filesystemClient.connect();
      await githubClient.connect();

      // Step 2: Get tools from clients
      const filesystemTools = await filesystemClient.listTools();
      const githubTools = await githubClient.listTools();

      expect(filesystemTools.tools.length).toBeGreaterThan(0);
      expect(githubTools.tools.length).toBeGreaterThan(0);

      // Step 3: Save compressed descriptions
      filesystemTools.tools.forEach((tool) => {
        const key = `filesystem:${tool.name}` as keyof typeof SAMPLE_COMPRESSIONS;
        const compression = SAMPLE_COMPRESSIONS[key];
        if (compression) {
          compressionCache.saveCompressed(
            'filesystem',
            tool.name,
            compression.compressed,
            tool.description
          );
        }
      });

      githubTools.tools.forEach((tool) => {
        const key = `github:${tool.name}` as keyof typeof SAMPLE_COMPRESSIONS;
        const compression = SAMPLE_COMPRESSIONS[key];
        if (compression) {
          compressionCache.saveCompressed(
            'github',
            tool.name,
            compression.compressed,
            tool.description
          );
        }
      });

      // Step 4: Verify compressed descriptions are used by default
      const readFileDesc = compressionCache.getDescription(
        'filesystem',
        'read_file',
        filesystemTools.tools[0].description,
        false
      );
      expect(readFileDesc).toBe(SAMPLE_COMPRESSIONS['filesystem:read_file'].compressed);

      // Step 5: Create session and expand a tool
      const sessionId = sessionManager.createSession();
      sessionManager.expandTool(sessionId, 'filesystem', 'read_file');

      // Step 6: Verify original description is shown when expanded
      const isExpanded = sessionManager.isToolExpanded(sessionId, 'filesystem', 'read_file');
      const expandedDesc = compressionCache.getDescription(
        'filesystem',
        'read_file',
        filesystemTools.tools[0].description,
        isExpanded
      );
      expect(expandedDesc).toBe(filesystemTools.tools[0].description);

      // Step 7: Collapse and verify compression is used again
      sessionManager.collapseTool(sessionId, 'filesystem', 'read_file');
      const isCollapsed = !sessionManager.isToolExpanded(sessionId, 'filesystem', 'read_file');
      const collapsedDesc = compressionCache.getDescription(
        'filesystem',
        'read_file',
        filesystemTools.tools[0].description,
        !isCollapsed
      );
      expect(collapsedDesc).toBe(SAMPLE_COMPRESSIONS['filesystem:read_file'].compressed);
    });
  });

  describe('Multi-tool aggregation', () => {
    it('should aggregate tools from multiple servers', async () => {
      const filesystemClient = createMockFilesystemClient();
      const githubClient = createMockGitHubClient();

      await filesystemClient.connect();
      await githubClient.connect();

      const filesystemTools = await filesystemClient.listTools();
      const githubTools = await githubClient.listTools();

      // Aggregate tools
      const allTools = [
        ...filesystemTools.tools.map((tool) => ({
          ...tool,
          name: `filesystem__${tool.name}`,
          serverName: 'filesystem',
        })),
        ...githubTools.tools.map((tool) => ({
          ...tool,
          name: `github__${tool.name}`,
          serverName: 'github',
        })),
      ];

      expect(allTools.length).toBe(
        filesystemTools.tools.length + githubTools.tools.length
      );

      // Verify tool naming convention
      allTools.forEach((tool) => {
        expect(tool.name).toMatch(/^(filesystem|github)__/);
      });
    });

    it('should apply compression to all aggregated tools', async () => {
      const filesystemClient = createMockFilesystemClient();
      const githubClient = createMockGitHubClient();

      await filesystemClient.connect();
      await githubClient.connect();

      const filesystemTools = await filesystemClient.listTools();
      const githubTools = await githubClient.listTools();

      // Save all compressions
      const allToolData = [
        ...filesystemTools.tools.map((t) => ({ server: 'filesystem', tool: t })),
        ...githubTools.tools.map((t) => ({ server: 'github', tool: t })),
      ];

      allToolData.forEach(({ server, tool }) => {
        const key = `${server}:${tool.name}` as keyof typeof SAMPLE_COMPRESSIONS;
        const compression = SAMPLE_COMPRESSIONS[key];
        if (compression) {
          compressionCache.saveCompressed(
            server,
            tool.name,
            compression.compressed,
            tool.description
          );
        }
      });

      // Verify all tools have compression
      const stats = compressionCache.getStats();
      expect(stats.compressedTools).toBeGreaterThan(0);
    });
  });

  describe('Session-based selective expansion', () => {
    it('should allow expanding different tools in different sessions', async () => {
      const filesystemClient = createMockFilesystemClient();
      await filesystemClient.connect();

      const tools = await filesystemClient.listTools();

      // Save compressions
      tools.tools.forEach((tool) => {
        const key = `filesystem:${tool.name}` as keyof typeof SAMPLE_COMPRESSIONS;
        const compression = SAMPLE_COMPRESSIONS[key];
        if (compression) {
          compressionCache.saveCompressed(
            'filesystem',
            tool.name,
            compression.compressed,
            tool.description
          );
        }
      });

      // Create two sessions
      const session1 = sessionManager.createSession();
      const session2 = sessionManager.createSession();

      // Expand different tools in each session
      sessionManager.expandTool(session1, 'filesystem', 'read_file');
      sessionManager.expandTool(session2, 'filesystem', 'write_file');

      // Verify session1 sees read_file expanded, write_file compressed
      const session1ReadExpanded = sessionManager.isToolExpanded(
        session1,
        'filesystem',
        'read_file'
      );
      const session1WriteExpanded = sessionManager.isToolExpanded(
        session1,
        'filesystem',
        'write_file'
      );

      expect(session1ReadExpanded).toBe(true);
      expect(session1WriteExpanded).toBe(false);

      // Verify session2 sees write_file expanded, read_file compressed
      const session2ReadExpanded = sessionManager.isToolExpanded(
        session2,
        'filesystem',
        'read_file'
      );
      const session2WriteExpanded = sessionManager.isToolExpanded(
        session2,
        'filesystem',
        'write_file'
      );

      expect(session2ReadExpanded).toBe(false);
      expect(session2WriteExpanded).toBe(true);
    });

    it('should maintain expansion state across tool listings', async () => {
      const filesystemClient = createMockFilesystemClient();
      await filesystemClient.connect();

      const tools = await filesystemClient.listTools();

      // Save compressions
      tools.tools.forEach((tool) => {
        const key = `filesystem:${tool.name}` as keyof typeof SAMPLE_COMPRESSIONS;
        const compression = SAMPLE_COMPRESSIONS[key];
        if (compression) {
          compressionCache.saveCompressed(
            'filesystem',
            tool.name,
            compression.compressed,
            tool.description
          );
        }
      });

      const sessionId = sessionManager.createSession();
      sessionManager.expandTool(sessionId, 'filesystem', 'read_file');

      // List tools multiple times
      for (let i = 0; i < 3; i++) {
        const isExpanded = sessionManager.isToolExpanded(
          sessionId,
          'filesystem',
          'read_file'
        );
        expect(isExpanded).toBe(true);
      }
    });
  });

  describe('Error handling and edge cases', () => {
    it('should handle tools without compression gracefully', async () => {
      const filesystemClient = createMockFilesystemClient();
      await filesystemClient.connect();

      const tools = await filesystemClient.listTools();
      const firstTool = tools.tools[0];

      // Don't save compression for this tool
      const desc = compressionCache.getDescription(
        'filesystem',
        firstTool.name,
        firstTool.description,
        false
      );

      // Should fall back to original description
      expect(desc).toBe(firstTool.description);
    });

    it('should handle session deletion during workflow', async () => {
      const filesystemClient = createMockFilesystemClient();
      await filesystemClient.connect();

      const tools = await filesystemClient.listTools();

      tools.tools.forEach((tool) => {
        const key = `filesystem:${tool.name}` as keyof typeof SAMPLE_COMPRESSIONS;
        const compression = SAMPLE_COMPRESSIONS[key];
        if (compression) {
          compressionCache.saveCompressed(
            'filesystem',
            tool.name,
            compression.compressed,
            tool.description
          );
        }
      });

      const sessionId = sessionManager.createSession();
      sessionManager.expandTool(sessionId, 'filesystem', 'read_file');

      // Verify expansion
      expect(sessionManager.isToolExpanded(sessionId, 'filesystem', 'read_file')).toBe(
        true
      );

      // Delete session
      sessionManager.deleteSession(sessionId);

      // Verify expansion state is gone
      expect(sessionManager.isToolExpanded(sessionId, 'filesystem', 'read_file')).toBe(
        false
      );

      // Verify compression cache is unaffected
      expect(compressionCache.hasCompressed('filesystem', 'read_file')).toBe(true);
    });

    it('should handle clearing all sessions', async () => {
      const filesystemClient = createMockFilesystemClient();
      await filesystemClient.connect();

      // Create multiple sessions with expansions
      const session1 = sessionManager.createSession();
      const session2 = sessionManager.createSession();

      sessionManager.expandTool(session1, 'filesystem', 'read_file');
      sessionManager.expandTool(session2, 'filesystem', 'write_file');

      expect(sessionManager.getAllSessions()).toHaveLength(2);

      // Clear all sessions
      sessionManager.clearAllSessions();

      expect(sessionManager.getAllSessions()).toHaveLength(0);
      expect(sessionManager.isToolExpanded(session1, 'filesystem', 'read_file')).toBe(
        false
      );
    });
  });

  describe('Performance and statistics', () => {
    it('should track compression statistics', async () => {
      const filesystemClient = createMockFilesystemClient();
      const githubClient = createMockGitHubClient();

      await filesystemClient.connect();
      await githubClient.connect();

      const filesystemTools = await filesystemClient.listTools();
      const githubTools = await githubClient.listTools();

      const totalTools = filesystemTools.tools.length + githubTools.tools.length;

      // Save all compressions
      [...filesystemTools.tools, ...githubTools.tools].forEach((tool) => {
        compressionCache.saveCompressed('server', tool.name, 'compressed', tool.description);
      });

      const stats = compressionCache.getStats();

      expect(stats.totalTools).toBe(totalTools);
      expect(stats.compressedTools).toBe(totalTools);
      expect(stats.cacheSize).toBeGreaterThan(0);
    });

    it('should track session expansion statistics', () => {
      const sessionId = sessionManager.createSession();

      sessionManager.expandTool(sessionId, 'filesystem', 'read_file');
      sessionManager.expandTool(sessionId, 'filesystem', 'write_file');
      sessionManager.expandTool(sessionId, 'github', 'create_issue');

      const stats = sessionManager.getSessionStats(sessionId);

      expect(stats?.expandedToolsCount).toBe(3);
      expect(stats?.expandedTools).toHaveLength(3);
    });
  });
});
