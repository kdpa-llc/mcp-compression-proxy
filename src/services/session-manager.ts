import { randomUUID } from 'crypto';
import type { SessionInfo } from '../types/compression.js';
import type { Logger } from 'pino';

/**
 * Manages sessions for per-client tool expansion state
 */
export class SessionManager {
  private sessions: Map<string, SessionInfo> = new Map();
  private logger: Logger;
  private readonly SESSION_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes
  private cleanupTimer: NodeJS.Timeout;

  constructor(logger: Logger) {
    this.logger = logger;

    // Cleanup expired sessions every 5 minutes
    this.cleanupTimer = setInterval(() => this.cleanupExpiredSessions(), 5 * 60 * 1000);
  }

  /**
   * Create a new session
   */
  createSession(): string {
    const sessionId = randomUUID();
    const now = new Date().toISOString();

    this.sessions.set(sessionId, {
      sessionId,
      createdAt: now,
      lastAccessedAt: now,
      expandedTools: [],
    });

    this.logger.info({ sessionId }, 'Created new session');

    return sessionId;
  }

  /**
   * Get session info
   */
  getSession(sessionId: string): SessionInfo | undefined {
    const session = this.sessions.get(sessionId);

    if (session) {
      // Update last accessed time
      session.lastAccessedAt = new Date().toISOString();
    }

    return session;
  }

  /**
   * Check if session exists
   */
  hasSession(sessionId: string): boolean {
    return this.sessions.has(sessionId);
  }

  /**
   * Delete a session
   */
  deleteSession(sessionId: string): boolean {
    const existed = this.sessions.delete(sessionId);

    if (existed) {
      this.logger.info({ sessionId }, 'Deleted session');
    }

    return existed;
  }

  /**
   * Add expanded tool to session
   */
  expandTool(sessionId: string, serverName: string, toolName: string): boolean {
    const session = this.sessions.get(sessionId);

    if (!session) {
      this.logger.warn({ sessionId }, 'Session not found for expand');
      return false;
    }

    const toolKey = `${serverName}:${toolName}`;

    if (!session.expandedTools.includes(toolKey)) {
      session.expandedTools.push(toolKey);
      session.lastAccessedAt = new Date().toISOString();

      this.logger.debug(
        { sessionId, serverName, toolName },
        'Expanded tool in session'
      );
    }

    return true;
  }

  /**
   * Remove expanded tool from session
   */
  collapseTool(sessionId: string, serverName: string, toolName: string): boolean {
    const session = this.sessions.get(sessionId);

    if (!session) {
      this.logger.warn({ sessionId }, 'Session not found for collapse');
      return false;
    }

    const toolKey = `${serverName}:${toolName}`;
    const index = session.expandedTools.indexOf(toolKey);

    if (index !== -1) {
      session.expandedTools.splice(index, 1);
      session.lastAccessedAt = new Date().toISOString();

      this.logger.debug(
        { sessionId, serverName, toolName },
        'Collapsed tool in session'
      );

      return true;
    }

    return false;
  }

  /**
   * Check if a tool is expanded in a session
   */
  isToolExpanded(
    sessionId: string | undefined,
    serverName: string,
    toolName: string
  ): boolean {
    if (!sessionId) return false;

    const session = this.sessions.get(sessionId);
    if (!session) return false;

    const toolKey = `${serverName}:${toolName}`;
    return session.expandedTools.includes(toolKey);
  }

  /**
   * Get all sessions
   */
  getAllSessions(): SessionInfo[] {
    return Array.from(this.sessions.values());
  }

  /**
   * Get session statistics
   */
  getSessionStats(sessionId: string): {
    expandedToolsCount: number;
    expandedTools: string[];
  } | null {
    const session = this.sessions.get(sessionId);

    if (!session) return null;

    return {
      expandedToolsCount: session.expandedTools.length,
      expandedTools: session.expandedTools,
    };
  }

  /**
   * Cleanup expired sessions
   */
  private cleanupExpiredSessions(): void {
    const now = Date.now();
    let cleaned = 0;

    for (const [sessionId, session] of this.sessions.entries()) {
      const lastAccessed = new Date(session.lastAccessedAt).getTime();
      const age = now - lastAccessed;

      if (age > this.SESSION_TIMEOUT_MS) {
        this.sessions.delete(sessionId);
        cleaned++;
      }
    }

    if (cleaned > 0) {
      this.logger.info({ cleaned }, 'Cleaned up expired sessions');
    }
  }

  /**
   * Clear all sessions
   */
  clearAllSessions(): void {
    const count = this.sessions.size;
    this.sessions.clear();
    this.logger.info({ count }, 'Cleared all sessions');
  }

  /**
   * Destroy the session manager and cleanup resources
   */
  destroy(): void {
    clearInterval(this.cleanupTimer);
    this.clearAllSessions();
  }
}
