import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { SessionManager } from '../../src/services/session-manager.js';
import type { Logger } from 'pino';

describe('SessionManager', () => {
  let sessionManager: SessionManager;
  let mockLogger: Logger;

  beforeEach(() => {
    jest.useFakeTimers();

    mockLogger = {
      debug: jest.fn(),
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    } as unknown as Logger;

    sessionManager = new SessionManager(mockLogger);
  });

  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  describe('createSession', () => {
    it('should create a new session with UUID', () => {
      const sessionId = sessionManager.createSession();

      expect(sessionId).toBeDefined();
      expect(typeof sessionId).toBe('string');
      expect(sessionId.length).toBeGreaterThan(0);
    });

    it('should create unique session IDs', () => {
      const sessionId1 = sessionManager.createSession();
      const sessionId2 = sessionManager.createSession();

      expect(sessionId1).not.toBe(sessionId2);
    });

    it('should initialize session with empty expanded tools', () => {
      const sessionId = sessionManager.createSession();
      const session = sessionManager.getSession(sessionId);

      expect(session).toBeDefined();
      expect(session?.expandedTools).toEqual([]);
    });

    it('should set createdAt and lastAccessedAt timestamps', () => {
      const sessionId = sessionManager.createSession();
      const session = sessionManager.getSession(sessionId);

      expect(session?.createdAt).toBeDefined();
      expect(session?.lastAccessedAt).toBeDefined();
      expect(new Date(session!.createdAt).getTime()).toBeLessThanOrEqual(Date.now());
    });
  });

  describe('getSession', () => {
    it('should return session info if exists', () => {
      const sessionId = sessionManager.createSession();
      const session = sessionManager.getSession(sessionId);

      expect(session).toBeDefined();
      expect(session?.sessionId).toBe(sessionId);
    });

    it('should return undefined if session does not exist', () => {
      const session = sessionManager.getSession('non-existent-id');
      expect(session).toBeUndefined();
    });

    it('should update lastAccessedAt when retrieving session', () => {
      const sessionId = sessionManager.createSession();
      const session1 = sessionManager.getSession(sessionId);
      const firstAccess = session1?.lastAccessedAt;

      jest.advanceTimersByTime(1000);

      const session2 = sessionManager.getSession(sessionId);
      const secondAccess = session2?.lastAccessedAt;

      expect(secondAccess).not.toBe(firstAccess);
    });
  });

  describe('hasSession', () => {
    it('should return true for existing session', () => {
      const sessionId = sessionManager.createSession();
      expect(sessionManager.hasSession(sessionId)).toBe(true);
    });

    it('should return false for non-existent session', () => {
      expect(sessionManager.hasSession('non-existent-id')).toBe(false);
    });
  });

  describe('deleteSession', () => {
    it('should delete existing session and return true', () => {
      const sessionId = sessionManager.createSession();
      const deleted = sessionManager.deleteSession(sessionId);

      expect(deleted).toBe(true);
      expect(sessionManager.hasSession(sessionId)).toBe(false);
    });

    it('should return false if session does not exist', () => {
      const deleted = sessionManager.deleteSession('non-existent-id');
      expect(deleted).toBe(false);
    });
  });

  describe('expandTool', () => {
    it('should expand tool in session', () => {
      const sessionId = sessionManager.createSession();
      const result = sessionManager.expandTool(sessionId, 'filesystem', 'read_file');

      expect(result).toBe(true);
      expect(sessionManager.isToolExpanded(sessionId, 'filesystem', 'read_file')).toBe(true);
    });

    it('should return false for non-existent session', () => {
      const result = sessionManager.expandTool('non-existent', 'filesystem', 'read_file');
      expect(result).toBe(false);
    });

    it('should not add duplicate expanded tools', () => {
      const sessionId = sessionManager.createSession();

      sessionManager.expandTool(sessionId, 'filesystem', 'read_file');
      sessionManager.expandTool(sessionId, 'filesystem', 'read_file');

      const stats = sessionManager.getSessionStats(sessionId);
      expect(stats?.expandedToolsCount).toBe(1);
    });

    it('should handle multiple different tools', () => {
      const sessionId = sessionManager.createSession();

      sessionManager.expandTool(sessionId, 'filesystem', 'read_file');
      sessionManager.expandTool(sessionId, 'filesystem', 'write_file');
      sessionManager.expandTool(sessionId, 'github', 'create_issue');

      const stats = sessionManager.getSessionStats(sessionId);
      expect(stats?.expandedToolsCount).toBe(3);
    });

    it('should update lastAccessedAt when expanding tool', () => {
      const sessionId = sessionManager.createSession();
      const session1 = sessionManager.getSession(sessionId);
      const firstAccess = session1?.lastAccessedAt;

      jest.advanceTimersByTime(1000);

      sessionManager.expandTool(sessionId, 'filesystem', 'read_file');
      const session2 = sessionManager.getSession(sessionId);
      const secondAccess = session2?.lastAccessedAt;

      expect(secondAccess).not.toBe(firstAccess);
    });
  });

  describe('collapseTool', () => {
    it('should collapse expanded tool in session', () => {
      const sessionId = sessionManager.createSession();

      sessionManager.expandTool(sessionId, 'filesystem', 'read_file');
      expect(sessionManager.isToolExpanded(sessionId, 'filesystem', 'read_file')).toBe(true);

      const result = sessionManager.collapseTool(sessionId, 'filesystem', 'read_file');

      expect(result).toBe(true);
      expect(sessionManager.isToolExpanded(sessionId, 'filesystem', 'read_file')).toBe(false);
    });

    it('should return false for non-existent session', () => {
      const result = sessionManager.collapseTool('non-existent', 'filesystem', 'read_file');
      expect(result).toBe(false);
    });

    it('should return false if tool not expanded', () => {
      const sessionId = sessionManager.createSession();
      const result = sessionManager.collapseTool(sessionId, 'filesystem', 'read_file');
      expect(result).toBe(false);
    });

    it('should only collapse specified tool', () => {
      const sessionId = sessionManager.createSession();

      sessionManager.expandTool(sessionId, 'filesystem', 'read_file');
      sessionManager.expandTool(sessionId, 'filesystem', 'write_file');

      sessionManager.collapseTool(sessionId, 'filesystem', 'read_file');

      expect(sessionManager.isToolExpanded(sessionId, 'filesystem', 'read_file')).toBe(false);
      expect(sessionManager.isToolExpanded(sessionId, 'filesystem', 'write_file')).toBe(true);
    });
  });

  describe('isToolExpanded', () => {
    it('should return true for expanded tools', () => {
      const sessionId = sessionManager.createSession();
      sessionManager.expandTool(sessionId, 'filesystem', 'read_file');

      expect(sessionManager.isToolExpanded(sessionId, 'filesystem', 'read_file')).toBe(true);
    });

    it('should return false for non-expanded tools', () => {
      const sessionId = sessionManager.createSession();
      expect(sessionManager.isToolExpanded(sessionId, 'filesystem', 'read_file')).toBe(false);
    });

    it('should return false for undefined sessionId', () => {
      expect(sessionManager.isToolExpanded(undefined, 'filesystem', 'read_file')).toBe(false);
    });

    it('should return false for non-existent session', () => {
      expect(sessionManager.isToolExpanded('non-existent', 'filesystem', 'read_file')).toBe(false);
    });
  });

  describe('getAllSessions', () => {
    it('should return empty array when no sessions', () => {
      const sessions = sessionManager.getAllSessions();
      expect(sessions).toEqual([]);
    });

    it('should return all sessions', () => {
      const sessionId1 = sessionManager.createSession();
      const sessionId2 = sessionManager.createSession();

      const sessions = sessionManager.getAllSessions();

      expect(sessions).toHaveLength(2);
      expect(sessions.map(s => s.sessionId)).toContain(sessionId1);
      expect(sessions.map(s => s.sessionId)).toContain(sessionId2);
    });
  });

  describe('getSessionStats', () => {
    it('should return stats for existing session', () => {
      const sessionId = sessionManager.createSession();
      sessionManager.expandTool(sessionId, 'filesystem', 'read_file');
      sessionManager.expandTool(sessionId, 'github', 'create_issue');

      const stats = sessionManager.getSessionStats(sessionId);

      expect(stats).toBeDefined();
      expect(stats?.expandedToolsCount).toBe(2);
      expect(stats?.expandedTools).toContain('filesystem:read_file');
      expect(stats?.expandedTools).toContain('github:create_issue');
    });

    it('should return null for non-existent session', () => {
      const stats = sessionManager.getSessionStats('non-existent');
      expect(stats).toBeNull();
    });

    it('should return zero count for session with no expanded tools', () => {
      const sessionId = sessionManager.createSession();
      const stats = sessionManager.getSessionStats(sessionId);

      expect(stats?.expandedToolsCount).toBe(0);
      expect(stats?.expandedTools).toEqual([]);
    });
  });

  describe('clearAllSessions', () => {
    it('should clear all sessions', () => {
      sessionManager.createSession();
      sessionManager.createSession();

      expect(sessionManager.getAllSessions()).toHaveLength(2);

      sessionManager.clearAllSessions();

      expect(sessionManager.getAllSessions()).toEqual([]);
    });
  });

  describe('session expiration', () => {
    it('should cleanup expired sessions after timeout', () => {
      const sessionId = sessionManager.createSession();

      expect(sessionManager.hasSession(sessionId)).toBe(true);

      // Advance time by 31 minutes (past 30 minute timeout)
      jest.advanceTimersByTime(31 * 60 * 1000);

      // Trigger cleanup (runs every 5 minutes)
      jest.advanceTimersByTime(5 * 60 * 1000);

      expect(sessionManager.hasSession(sessionId)).toBe(false);
    });

    it('should not cleanup active sessions', () => {
      const sessionId = sessionManager.createSession();

      // Access session every 10 minutes
      for (let i = 0; i < 3; i++) {
        jest.advanceTimersByTime(10 * 60 * 1000);
        sessionManager.getSession(sessionId); // Updates lastAccessedAt
      }

      // Trigger cleanup
      jest.advanceTimersByTime(5 * 60 * 1000);

      expect(sessionManager.hasSession(sessionId)).toBe(true);
    });

    it('should cleanup multiple expired sessions', () => {
      const sessionId1 = sessionManager.createSession();
      const sessionId2 = sessionManager.createSession();

      // Advance time past expiration
      jest.advanceTimersByTime(31 * 60 * 1000);

      // Trigger cleanup
      jest.advanceTimersByTime(5 * 60 * 1000);

      expect(sessionManager.hasSession(sessionId1)).toBe(false);
      expect(sessionManager.hasSession(sessionId2)).toBe(false);
    });
  });

  describe('edge cases', () => {
    it('should handle tools with special characters', () => {
      const sessionId = sessionManager.createSession();
      sessionManager.expandTool(sessionId, 'server-name', 'tool_name-123');

      expect(sessionManager.isToolExpanded(sessionId, 'server-name', 'tool_name-123')).toBe(true);
    });

    it('should distinguish between different servers with same tool name', () => {
      const sessionId = sessionManager.createSession();

      sessionManager.expandTool(sessionId, 'server1', 'read_file');
      sessionManager.expandTool(sessionId, 'server2', 'read_file');

      expect(sessionManager.isToolExpanded(sessionId, 'server1', 'read_file')).toBe(true);
      expect(sessionManager.isToolExpanded(sessionId, 'server2', 'read_file')).toBe(true);

      const stats = sessionManager.getSessionStats(sessionId);
      expect(stats?.expandedToolsCount).toBe(2);
    });
  });
});
