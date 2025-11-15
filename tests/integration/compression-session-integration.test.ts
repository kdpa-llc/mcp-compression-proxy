import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import { CompressionCache } from '../../src/services/compression-cache.js';
import { SessionManager } from '../../src/services/session-manager.js';
import type { Logger } from 'pino';

describe('CompressionCache and SessionManager Integration', () => {
  let cache: CompressionCache;
  let sessionManager: SessionManager;
  let mockLogger: Logger;

  beforeEach(() => {
    mockLogger = {
      debug: jest.fn(),
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    } as unknown as Logger;

    cache = new CompressionCache(mockLogger);
    sessionManager = new SessionManager(mockLogger);
  });

  describe('Tool expansion workflow', () => {
    it('should show compressed description by default', () => {
      const serverName = 'filesystem';
      const toolName = 'read_file';
      const compressed = 'Read file (compressed)';
      const original = 'Reads the complete contents of a file from the filesystem';

      // Save compressed description
      cache.saveCompressed(serverName, toolName, compressed, original);

      // Without session, should show compressed
      const description = cache.getDescription(serverName, toolName, original, false);
      expect(description).toBe(compressed);
    });

    it('should show original description when tool is expanded in session', () => {
      const serverName = 'filesystem';
      const toolName = 'read_file';
      const compressed = 'Read file (compressed)';
      const original = 'Reads the complete contents of a file from the filesystem';

      // Save compressed description
      cache.saveCompressed(serverName, toolName, compressed, original);

      // Create session and expand tool
      const sessionId = sessionManager.createSession();
      sessionManager.expandTool(sessionId, serverName, toolName);

      // Check if tool is expanded
      const isExpanded = sessionManager.isToolExpanded(sessionId, serverName, toolName);

      // Get description with expanded state
      const description = cache.getDescription(
        serverName,
        toolName,
        original,
        isExpanded
      );

      expect(description).toBe(original);
    });

    it('should revert to compressed when tool is collapsed', () => {
      const serverName = 'filesystem';
      const toolName = 'read_file';
      const compressed = 'Read file (compressed)';
      const original = 'Reads the complete contents of a file from the filesystem';

      cache.saveCompressed(serverName, toolName, compressed, original);

      // Create session and expand tool
      const sessionId = sessionManager.createSession();
      sessionManager.expandTool(sessionId, serverName, toolName);

      // Verify it's expanded
      let isExpanded = sessionManager.isToolExpanded(sessionId, serverName, toolName);
      let description = cache.getDescription(serverName, toolName, original, isExpanded);
      expect(description).toBe(original);

      // Collapse the tool
      sessionManager.collapseTool(sessionId, serverName, toolName);

      // Verify it's collapsed
      isExpanded = sessionManager.isToolExpanded(sessionId, serverName, toolName);
      description = cache.getDescription(serverName, toolName, original, isExpanded);
      expect(description).toBe(compressed);
    });
  });

  describe('Multi-session isolation', () => {
    it('should maintain independent expansion state across sessions', () => {
      const serverName = 'filesystem';
      const toolName = 'read_file';
      const compressed = 'Read file (compressed)';
      const original = 'Read file (original)';

      cache.saveCompressed(serverName, toolName, compressed, original);

      // Create two sessions
      const session1 = sessionManager.createSession();
      const session2 = sessionManager.createSession();

      // Expand tool only in session1
      sessionManager.expandTool(session1, serverName, toolName);

      // Check expansion state
      const isExpandedInSession1 = sessionManager.isToolExpanded(
        session1,
        serverName,
        toolName
      );
      const isExpandedInSession2 = sessionManager.isToolExpanded(
        session2,
        serverName,
        toolName
      );

      expect(isExpandedInSession1).toBe(true);
      expect(isExpandedInSession2).toBe(false);

      // Get descriptions for each session
      const desc1 = cache.getDescription(
        serverName,
        toolName,
        original,
        isExpandedInSession1
      );
      const desc2 = cache.getDescription(
        serverName,
        toolName,
        original,
        isExpandedInSession2
      );

      expect(desc1).toBe(original); // Expanded in session1
      expect(desc2).toBe(compressed); // Compressed in session2
    });

    it('should handle multiple tools across multiple sessions', () => {
      // Setup multiple tools
      const tools = [
        { server: 'filesystem', name: 'read_file', compressed: 'Read', original: 'Read file' },
        { server: 'filesystem', name: 'write_file', compressed: 'Write', original: 'Write file' },
        { server: 'github', name: 'create_issue', compressed: 'Create', original: 'Create issue' },
      ];

      tools.forEach(({ server, name, compressed, original }) => {
        cache.saveCompressed(server, name, compressed, original);
      });

      // Create sessions
      const session1 = sessionManager.createSession();
      const session2 = sessionManager.createSession();

      // Expand different tools in different sessions
      sessionManager.expandTool(session1, 'filesystem', 'read_file');
      sessionManager.expandTool(session1, 'github', 'create_issue');
      sessionManager.expandTool(session2, 'filesystem', 'write_file');

      // Verify expansion states
      expect(sessionManager.isToolExpanded(session1, 'filesystem', 'read_file')).toBe(true);
      expect(sessionManager.isToolExpanded(session1, 'filesystem', 'write_file')).toBe(false);
      expect(sessionManager.isToolExpanded(session1, 'github', 'create_issue')).toBe(true);

      expect(sessionManager.isToolExpanded(session2, 'filesystem', 'read_file')).toBe(false);
      expect(sessionManager.isToolExpanded(session2, 'filesystem', 'write_file')).toBe(true);
      expect(sessionManager.isToolExpanded(session2, 'github', 'create_issue')).toBe(false);
    });
  });

  describe('Session lifecycle with compression', () => {
    it('should handle session deletion with expanded tools', () => {
      const serverName = 'filesystem';
      const toolName = 'read_file';
      const compressed = 'Read (compressed)';
      const original = 'Read file (original)';

      cache.saveCompressed(serverName, toolName, compressed, original);

      // Create session and expand tool
      const sessionId = sessionManager.createSession();
      sessionManager.expandTool(sessionId, serverName, toolName);

      expect(sessionManager.isToolExpanded(sessionId, serverName, toolName)).toBe(true);

      // Delete session
      sessionManager.deleteSession(sessionId);

      // Check that expansion state is gone
      expect(sessionManager.isToolExpanded(sessionId, serverName, toolName)).toBe(false);
    });

    it('should not affect compression cache when session is deleted', () => {
      const serverName = 'filesystem';
      const toolName = 'read_file';
      const compressed = 'Read (compressed)';
      const original = 'Read file (original)';

      cache.saveCompressed(serverName, toolName, compressed, original);

      const sessionId = sessionManager.createSession();
      sessionManager.expandTool(sessionId, serverName, toolName);
      sessionManager.deleteSession(sessionId);

      // Compression cache should still have the data
      expect(cache.hasCompressed(serverName, toolName)).toBe(true);
      expect(cache.getCompressedDescription(serverName, toolName)).toBe(compressed);
      expect(cache.getOriginalDescription(serverName, toolName)).toBe(original);
    });
  });

  describe('Compression without original description', () => {
    it('should handle compressed-only tools correctly', () => {
      const serverName = 'github';
      const toolName = 'create_pr';
      const compressed = 'Create PR';

      // Save compressed without original
      cache.saveCompressed(serverName, toolName, compressed);

      const sessionId = sessionManager.createSession();
      sessionManager.expandTool(sessionId, serverName, toolName);

      const isExpanded = sessionManager.isToolExpanded(sessionId, serverName, toolName);

      // When no original is cached, should return undefined
      const description = cache.getDescription(
        serverName,
        toolName,
        undefined,
        isExpanded
      );

      expect(description).toBeUndefined();
    });

    it('should use fallback original when provided', () => {
      const serverName = 'github';
      const toolName = 'create_pr';
      const compressed = 'Create PR';
      const fallbackOriginal = 'Creates a new pull request in GitHub';

      cache.saveCompressed(serverName, toolName, compressed);

      const sessionId = sessionManager.createSession();
      sessionManager.expandTool(sessionId, serverName, toolName);

      const isExpanded = sessionManager.isToolExpanded(sessionId, serverName, toolName);

      // Should use fallback when expanded
      const description = cache.getDescription(
        serverName,
        toolName,
        fallbackOriginal,
        isExpanded
      );

      expect(description).toBe(fallbackOriginal);
    });
  });

  describe('Statistics and monitoring', () => {
    it('should track expansion statistics per session', () => {
      const sessionId = sessionManager.createSession();

      sessionManager.expandTool(sessionId, 'filesystem', 'read_file');
      sessionManager.expandTool(sessionId, 'filesystem', 'write_file');
      sessionManager.expandTool(sessionId, 'github', 'create_issue');

      const stats = sessionManager.getSessionStats(sessionId);

      expect(stats?.expandedToolsCount).toBe(3);
      expect(stats?.expandedTools).toContain('filesystem:read_file');
      expect(stats?.expandedTools).toContain('filesystem:write_file');
      expect(stats?.expandedTools).toContain('github:create_issue');
    });

    it('should track compression cache statistics', () => {
      cache.saveCompressed('server1', 'tool1', 'c1', 'o1');
      cache.saveCompressed('server2', 'tool2', 'c2', 'o2');
      cache.saveCompressed('server3', 'tool3', 'c3', 'o3');

      const stats = cache.getStats();

      expect(stats.totalTools).toBe(3);
      expect(stats.compressedTools).toBe(3);
      expect(stats.cacheSize).toBeGreaterThan(0);
    });
  });
});
