/**
 * Types for compression and session management
 */

export interface CompressedToolCache {
  [key: string]: {
    original?: string;
    compressed: string;
    compressedAt: string;
  };
}

export interface CompressionStats {
  totalTools: number;
  compressedTools: number;
  expandedTools: string[];
  cacheSize: number;
}

export interface SessionInfo {
  sessionId: string;
  createdAt: string;
  lastAccessedAt: string;
  expandedTools: string[];
}
