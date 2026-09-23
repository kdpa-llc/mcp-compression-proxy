/**
 * Types for compression and session management
 */

/**
 * One tool's replacement description.
 *
 * `kind` tells a compression (shorter, same meaning) from a rewrite (clearer,
 * possibly longer, reviewed by the user). `parameters` holds rewritten
 * descriptions for top-level input properties; only description text is ever
 * replaced, never names, types or required fields.
 */
export interface CachedDescription {
  original?: string;
  compressed: string;
  compressedAt: string;
  kind?: 'compressed' | 'rewritten';
  parameters?: Record<string, string>;
}

export interface CompressedToolCache {
  [key: string]: CachedDescription;
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

export interface CacheMetrics {
  totalCached: number;
  totalOriginalChars: number;
  totalCompressedChars: number;
  missingOriginals: number;
  latestCompressedAt?: string;
  cacheSizeBytes: number;
  perServer: Record<
    string,
    {
      cached: number;
      totalOriginalChars: number;
      totalCompressedChars: number;
      missingOriginals: number;
      latestCompressedAt?: string;
    }
  >;
}
