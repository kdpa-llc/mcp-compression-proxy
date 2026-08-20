#!/usr/bin/env node

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  Tool,
} from '@modelcontextprotocol/sdk/types.js';
import { MCPClientManager } from './mcp/client-manager.js';
import { CompressionCache } from './services/compression-cache.js';
import { SessionManager } from './services/session-manager.js';
import { loadJSONServersCached, matchesIgnorePattern } from './config/loader.js';
import { writeFileSync, readFileSync } from 'fs';
import { resolve } from 'path';
import pino from 'pino';
import { StatsService, type ObservedTool } from './services/stats-service.js';
import { CompressionSampler } from './services/compression-sampler.js';
import { SERVER_NAME, VERSION } from './version.js';

/**
 * MCP Server that aggregates tools from multiple MCP servers
 * with LLM-based description compression
 */

const logger = pino({
  name: 'mcp-compression-proxy',
  level: process.env.LOG_LEVEL || 'info',
  transport: {
    target: 'pino-pretty',
    options: {
      colorize: false,
      translateTime: 'HH:MM:ss Z',
      ignore: 'pid,hostname',
      destination: 2, // Forces output to stderr (FD 2) to keep stdout clean for MCP JSON-RPC
    },
  },
});

// Initialize services
const clientManager = new MCPClientManager(logger);
const compressionCache = new CompressionCache(logger);
const sessionManager = new SessionManager(logger);
const statsService = new StatsService(
  logger,
  clientManager,
  compressionCache,
  sessionManager
);

// Current session context (set by tools)
let currentSessionId: string | undefined;

// Create MCP server
const server = new Server(
  {
    name: SERVER_NAME,
    version: VERSION,
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// Compresses via the host's own LLM when the client supports sampling.
const compressionSampler = new CompressionSampler(logger, {
  getClientCapabilities: () => server.getClientCapabilities(),
  createMessage: (params) => server.createMessage(params),
});

/** A backend tool plus the metadata needed to namespace and compress it. */
type BackendTool = ObservedTool & { inputSchema: Tool['inputSchema'] };

/**
 * Fetch every tool from every connected backend server, once.
 *
 * Callers that need both the tool list and derived counts should reuse a single
 * snapshot rather than calling `listTools` per tool.
 */
async function fetchAllBackendTools(): Promise<BackendTool[]> {
  const clients = clientManager.getConnectedClients();

  const perServer = await Promise.all(
    clients.map(async ({ name, client }): Promise<BackendTool[]> => {
      try {
        const result = await client.listTools();
        return result.tools.map((tool) => ({
          serverName: name,
          toolName: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema,
        }));
      } catch (error) {
        logger.error({ server: name, error }, 'Failed to list tools from server');
        return [];
      }
    })
  );

  return perServer.flat();
}

/**
 * List all tools from aggregated MCP servers + management tools
 */
server.setRequestHandler(ListToolsRequestSchema, async () => {
  logger.debug('Handling tools/list request');

  // Fetch backend tools first so the management tools can advertise live
  // coverage numbers derived from this same snapshot.
  const backendTools = await fetchAllBackendTools();
  const coverage = statsService.computeCoverage(backendTools);
  const liveStats = statsService.formatCoverage(coverage);

  const aggregatorTools: Tool[] = [
    {
      name: 'mcp-compression-proxy__create_session',
      description: 'Create a new session for independent tool expansion control',
      inputSchema: {
        type: 'object',
        properties: {},
      },
    },
    {
      name: 'mcp-compression-proxy__delete_session',
      description: 'Delete a session',
      inputSchema: {
        type: 'object',
        properties: {
          sessionId: {
            type: 'string',
            description: 'Session ID to delete',
          },
        },
        required: ['sessionId'],
      },
    },
    {
      name: 'mcp-compression-proxy__set_session',
      description: 'Set the active session for subsequent tool calls (affects which tools show expanded descriptions)',
      inputSchema: {
        type: 'object',
        properties: {
          sessionId: {
            type: 'string',
            description: 'Session ID to use (from create_session)',
          },
        },
        required: ['sessionId'],
      },
    },
    {
      name: 'mcp-compression-proxy__clear_compressed_tools_cache',
      description: 'Clear all cached compressed tool descriptions. Use this to start fresh with compression or when tool descriptions have changed significantly.',
      inputSchema: {
        type: 'object',
        properties: {},
      },
    },
    {
      name: 'mcp-compression-proxy__get_uncompressed_tools',
      description: `Get tools that need compression (those without cached compressed descriptions). Returns up to the specified limit of tools that need compression. After compressing these descriptions, call mcp-compression-proxy__cache_compressed_tools. Repeat this process until no uncached tools remain. ${liveStats}`,
      inputSchema: {
        type: 'object',
        properties: {
          limit: {
            type: 'number',
            description: 'Maximum number of tools to return (default: 25, max: 100)',
            minimum: 1,
            maximum: 100,
            default: 25,
          },
          outputFile: {
            type: 'string',
            description: 'Optional file path to write tools JSON instead of returning as text',
          },
        },
      },
    },
    {
      name: 'mcp-compression-proxy__cache_compressed_tools',
      description: `Save compressed tool descriptions to cache (max 100 tools per call). Provide either descriptions array or inputFile path. After caching, call mcp-compression-proxy__get_uncompressed_tools again to get the next batch if any remain uncached. Continue until all tools are compressed. ${liveStats}`,
      inputSchema: {
        type: 'object',
        properties: {
          descriptions: {
            type: 'array',
            description: 'Array of compressed tool descriptions (max 100). Use this OR inputFile, not both.',
            maxItems: 100,
            items: {
              type: 'object',
              properties: {
                serverName: { type: 'string' },
                toolName: { type: 'string' },
                description: { type: 'string' },
              },
              required: ['serverName', 'toolName', 'description'],
            },
          },
          inputFile: {
            type: 'string',
            description: 'File path to read compressed tools JSON. Use this OR descriptions, not both.',
          },
        },
      },
    },
    {
      name: 'mcp-compression-proxy__expand_tool',
      description: 'Expand a tool to show its full original description (session-specific)',
      inputSchema: {
        type: 'object',
        properties: {
          serverName: {
            type: 'string',
            description: 'Server name (e.g., "filesystem")',
          },
          toolName: {
            type: 'string',
            description: 'Tool name (e.g., "read_file")',
          },
        },
        required: ['serverName', 'toolName'],
      },
    },
    {
      name: 'mcp-compression-proxy__collapse_tool',
      description: 'Collapse a tool back to compressed description (session-specific)',
      inputSchema: {
        type: 'object',
        properties: {
          serverName: {
            type: 'string',
            description: 'Server name',
          },
          toolName: {
            type: 'string',
            description: 'Tool name',
          },
        },
        required: ['serverName', 'toolName'],
      },
    },
    {
      name: 'mcp-compression-proxy__compress_via_sampling',
      description: `Compress uncached tool descriptions automatically using this client's own LLM, via MCP sampling. Requires a client that supports sampling; returns an error explaining the manual alternative if it does not. No API key or extra configuration needed. ${liveStats}`,
      inputSchema: {
        type: 'object',
        properties: {
          limit: {
            type: 'number',
            description: 'Maximum number of tools to compress in this call (default: 25, max: 100)',
            minimum: 1,
            maximum: 100,
            default: 25,
          },
        },
      },
    },
    {
      name: 'mcp-compression-proxy__stats',
      description: 'Get compression and server statistics. Optional inputs: serverName filter and detailLevel ("summary" | "full", default summary). Returns JSON with coverage, cache, and session details.',
      inputSchema: {
        type: 'object',
        properties: {
          serverName: {
            type: 'string',
            description: 'Optional server name to scope stats to a single backend server',
          },
          detailLevel: {
            type: 'string',
            description: 'Detail level for stats ("summary" | "full")',
            enum: ['summary', 'full'],
            default: 'summary',
          },
        },
      },
    },
  ];

  const aggregatedTools: Tool[] = backendTools.map((tool) => {
    // Check if tool is expanded in current session
    const isExpanded = sessionManager.isToolExpanded(
      currentSessionId,
      tool.serverName,
      tool.toolName
    );

    // Get description: compressed by default, original if expanded
    const description = compressionCache.getDescription(
      tool.serverName,
      tool.toolName,
      tool.description,
      isExpanded
    );

    return {
      name: `${tool.serverName}__${tool.toolName}`,
      description,
      inputSchema: tool.inputSchema,
    };
  });

  const allTools = [...aggregatorTools, ...aggregatedTools];

  // Apply exclude patterns to filter out tools
  const config = loadJSONServersCached();
  const excludePatterns = config?.excludePatterns || [];
  const filteredTools = allTools.filter(tool => {
    const isExcluded = matchesIgnorePattern(tool.name, excludePatterns);
    if (isExcluded) {
      logger.debug({ tool: tool.name }, 'Tool excluded by pattern');
    }
    return !isExcluded;
  });

  logger.debug({ count: filteredTools.length, excluded: allTools.length - filteredTools.length }, 'Returning tools');

  return { tools: filteredTools };
});

/**
 * Call a tool (either management tool or aggregated MCP tool)
 */
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  logger.debug({ tool: name, args }, 'Handling tools/call request');

  // Management tools
  if (name === 'mcp-compression-proxy__create_session') {
    const sessionId = sessionManager.createSession();
    currentSessionId = sessionId;

    return {
      content: [
        {
          type: 'text',
          text: `Session created: ${sessionId}\n\nThis session is now active. Tools expanded in this session will show full descriptions.`,
        },
      ],
    };
  }

  if (name === 'mcp-compression-proxy__delete_session') {
    const { sessionId } = args as { sessionId: string };
    const deleted = sessionManager.deleteSession(sessionId);

    if (currentSessionId === sessionId) {
      currentSessionId = undefined;
    }

    return {
      content: [
        {
          type: 'text',
          text: deleted
            ? `Session ${sessionId} deleted successfully.`
            : `Session ${sessionId} not found.`,
        },
      ],
    };
  }

  if (name === 'mcp-compression-proxy__set_session') {
    const { sessionId } = args as { sessionId: string };

    if (!sessionManager.hasSession(sessionId)) {
      return {
        content: [
          {
            type: 'text',
            text: `Error: Session ${sessionId} not found. Create a session first with mcp-compression-proxy__create_session.`,
          },
        ],
        isError: true,
      };
    }

    currentSessionId = sessionId;

    return {
      content: [
        {
          type: 'text',
          text: `Active session set to: ${sessionId}`,
        },
      ],
    };
  }

  if (name === 'mcp-compression-proxy__clear_compressed_tools_cache') {
    try {
      await compressionCache.clearAll();
      logger.info('Compression cache cleared');
      
      return {
        content: [
          {
            type: 'text',
            text: 'Successfully cleared all cached compressed tool descriptions.',
          },
        ],
      };
    } catch (error) {
      logger.error({ error }, 'Failed to clear cache');
      return {
        content: [
          {
            type: 'text',
            text: `Error clearing cache: ${error instanceof Error ? error.message : 'Unknown error'}`,
          },
        ],
        isError: true,
      };
    }
  }

  if (name === 'mcp-compression-proxy__get_uncompressed_tools') {
    const { limit = 25, outputFile } = args as { limit?: number; outputFile?: string };
    const actualLimit = Math.min(Math.max(limit, 1), 100);

    const backendTools = await fetchAllBackendTools();
    const coverage = statsService.computeCoverage(backendTools);
    const liveStats = statsService.formatCoverage(coverage);

    const allUncompressedTools = backendTools
      .filter((tool) => !compressionCache.hasCompressed(tool.serverName, tool.toolName))
      .map((tool) => ({
        serverName: tool.serverName,
        toolName: tool.toolName,
        description: tool.description || '',
      }));

    // Apply limit
    const toolsToCompress = allUncompressedTools.slice(0, actualLimit);
    const remaining = Math.max(0, allUncompressedTools.length - actualLimit);

    if (outputFile) {
      // Write tools to file instead of returning as text
      try {
        const filePath = resolve(outputFile);
        writeFileSync(filePath, JSON.stringify(toolsToCompress, null, 2), 'utf-8');
        
        logger.info({ filePath, count: toolsToCompress.length }, 'Wrote tools to file');

        return {
          content: [
            {
              type: 'text',
              text: `Found ${allUncompressedTools.length} tools without compressed descriptions.\n\nWrote ${toolsToCompress.length} tools to file: ${filePath}\n\nRemaining uncached tools: ${remaining}\n\n${liveStats}\n\nAfter compressing the descriptions in the file, call mcp-compression-proxy__cache_compressed_tools with inputFile parameter.${remaining > 0 ? '\n\nThen call mcp-compression-proxy__get_uncompressed_tools again to get the next batch.' : ''}`,
            },
          ],
        };
      } catch (error) {
        logger.error({ outputFile, error }, 'Failed to write tools to file');
        return {
          content: [
            {
              type: 'text',
              text: `Error writing tools to file: ${error instanceof Error ? error.message : 'Unknown error'}`,
            },
          ],
          isError: true,
        };
      }
    }

    // Original behavior: return as text
    return {
      content: [
        {
          type: 'text',
          text: `Found ${allUncompressedTools.length} tools without compressed descriptions.\n\nReturning ${toolsToCompress.length} tools for compression (limit: ${actualLimit}).\n\nRemaining uncached tools: ${remaining}\n\n${liveStats}\n\nTools to compress:\n\n${JSON.stringify(toolsToCompress, null, 2)}\n\nAfter compressing these descriptions, call mcp-compression-proxy__cache_compressed_tools with the results.${remaining > 0 ? '\n\nThen call mcp-compression-proxy__get_uncompressed_tools again to get the next batch.' : ''}`,
        },
      ],
    };
  }

  if (name === 'mcp-compression-proxy__cache_compressed_tools') {
    const { descriptions, inputFile } = args as {
      descriptions?: Array<{
        serverName: string;
        toolName: string;
        description: string;
      }>;
      inputFile?: string;
    };

    // Validate that exactly one parameter is provided
    if (!descriptions && !inputFile) {
      return {
        content: [
          {
            type: 'text',
            text: 'Error: Must provide either descriptions array or inputFile path.',
          },
        ],
        isError: true,
      };
    }

    if (descriptions && inputFile) {
      return {
        content: [
          {
            type: 'text',
            text: 'Error: Cannot provide both descriptions and inputFile. Choose one method.',
          },
        ],
        isError: true,
      };
    }

    // Assigned by both branches below; no initializer, or the empty array is
    // dead on every path.
    let toolsToCache: Array<{
      serverName: string;
      toolName: string;
      description: string;
    }>;

    if (inputFile) {
      // Read from file
      try {
        const filePath = resolve(inputFile);
        const fileContent = readFileSync(filePath, 'utf-8');
        toolsToCache = JSON.parse(fileContent);
        
        if (!Array.isArray(toolsToCache)) {
          return {
            content: [
              {
                type: 'text',
                text: 'Error: File must contain a JSON array of tools.',
              },
            ],
            isError: true,
          };
        }

        logger.info({ filePath, count: toolsToCache.length }, 'Read tools from file');
      } catch (error) {
        logger.error({ inputFile, error }, 'Failed to read tools from file');
        return {
          content: [
            {
              type: 'text',
              text: `Error reading tools from file: ${error instanceof Error ? error.message : 'Unknown error'}`,
            },
          ],
          isError: true,
        };
      }
    } else {
      // Use descriptions parameter
      toolsToCache = descriptions!;
    }

    if (toolsToCache.length > 100) {
      return {
        content: [
          {
            type: 'text',
            text: `Error: Cannot cache more than 100 tools at once. Received ${toolsToCache.length} tools.`,
          },
        ],
        isError: true,
      };
    }

    // Snapshot every backend tool once. Looking the original description up per
    // tool would issue one listTools round-trip per entry (up to 100 per call).
    const backendTools = await fetchAllBackendTools();
    const originalsByKey = new Map(
      backendTools.map((tool) => [`${tool.serverName}:${tool.toolName}`, tool.description])
    );

    const coverageBefore = statsService.computeCoverage(backendTools);

    let savedCount = 0;

    for (const desc of toolsToCache) {
      const { serverName, toolName, description: compressedDescription } = desc;

      compressionCache.saveCompressed(
        serverName,
        toolName,
        compressedDescription,
        originalsByKey.get(`${serverName}:${toolName}`)
      );

      savedCount++;
    }

    // Recompute against the same snapshot to report before/after coverage
    const coverageAfter = statsService.computeCoverage(backendTools);
    const remainingTools = coverageAfter.uncompressedTools;

    // Persist to disk
    try {
      await compressionCache.saveToDisk();
      logger.info('Compression cache persisted to disk');
    } catch (error) {
      logger.error({ error }, 'Failed to persist cache to disk');
    }

    const sourceInfo = inputFile ? `from file: ${inputFile}` : 'from descriptions parameter';

    return {
      content: [
        {
          type: 'text',
          text: `Cached ${savedCount} compressed tool descriptions successfully ${sourceInfo}.\n\nCoverage: ${coverageBefore.compressedTools}/${coverageBefore.totalTools} (${coverageBefore.coveragePercent}%) → ${coverageAfter.compressedTools}/${coverageAfter.totalTools} (${coverageAfter.coveragePercent}%)\nEstimated tokens saved: ~${coverageAfter.estimatedTokensSaved} (was ~${coverageBefore.estimatedTokensSaved})\n\n${remainingTools > 0 ? `Remaining tools to compress: ${remainingTools}\n\nCall mcp-compression-proxy__get_uncompressed_tools to continue with the next batch.` : 'All tools have been compressed! 🎉'}`,
        },
      ],
    };
  }

  if (name === 'mcp-compression-proxy__expand_tool') {
    const { serverName, toolName } = args as {
      serverName: string;
      toolName: string;
    };

    if (!currentSessionId) {
      return {
        content: [
          {
            type: 'text',
            text: 'Error: No active session. Create a session first with mcp-compression-proxy__create_session.',
          },
        ],
        isError: true,
      };
    }

    if (!compressionCache.hasCompressed(serverName, toolName)) {
      return {
        content: [
          {
            type: 'text',
            text: `Error: No compressed description found for ${serverName}:${toolName}`,
          },
        ],
        isError: true,
      };
    }

    sessionManager.expandTool(currentSessionId, serverName, toolName);

    const original = compressionCache.getOriginalDescription(serverName, toolName);
    const compressed = compressionCache.getCompressedDescription(serverName, toolName);

    return {
      content: [
        {
          type: 'text',
          text: `Tool ${serverName}:${toolName} expanded in session ${currentSessionId}.\n\nOriginal: ${original}\nCompressed: ${compressed}`,
        },
      ],
    };
  }

  if (name === 'mcp-compression-proxy__collapse_tool') {
    const { serverName, toolName } = args as {
      serverName: string;
      toolName: string;
    };

    if (!currentSessionId) {
      return {
        content: [
          {
            type: 'text',
            text: 'Error: No active session.',
          },
        ],
        isError: true,
      };
    }

    sessionManager.collapseTool(currentSessionId, serverName, toolName);

    return {
      content: [
        {
          type: 'text',
          text: `Tool ${serverName}:${toolName} collapsed in session ${currentSessionId}.`,
        },
      ],
    };
  }

  if (name === 'mcp-compression-proxy__compress_via_sampling') {
    const { limit = 25 } = args as { limit?: number };
    const actualLimit = Math.min(Math.max(limit, 1), 100);

    if (!compressionSampler.isSupported()) {
      return {
        content: [
          {
            type: 'text',
            text: 'Error: This client does not support MCP sampling, so the proxy cannot borrow its LLM.\n\nUse the manual flow instead: call mcp-compression-proxy__get_uncompressed_tools, compress the descriptions yourself, then post them back with mcp-compression-proxy__cache_compressed_tools.',
          },
        ],
        isError: true,
      };
    }

    const backendTools = await fetchAllBackendTools();
    const coverageBefore = statsService.computeCoverage(backendTools);

    const uncompressed = backendTools
      .filter((tool) => !compressionCache.hasCompressed(tool.serverName, tool.toolName))
      .slice(0, actualLimit);

    if (uncompressed.length === 0) {
      return {
        content: [
          {
            type: 'text',
            text: `Nothing to compress - all ${coverageBefore.totalTools} tools already have compressed descriptions.\n\n${statsService.formatCoverage(coverageBefore)}`,
          },
        ],
      };
    }

    const { descriptions, batchesAttempted, batchesFailed } =
      await compressionSampler.compress(uncompressed);

    for (const entry of descriptions) {
      const original = backendTools.find(
        (tool) => tool.serverName === entry.serverName && tool.toolName === entry.toolName
      )?.description;

      compressionCache.saveCompressed(
        entry.serverName,
        entry.toolName,
        entry.description,
        original
      );
    }

    if (descriptions.length > 0) {
      try {
        await compressionCache.saveToDisk();
      } catch (error) {
        logger.error({ error }, 'Failed to persist sampled compressions to disk');
      }
    }

    const coverageAfter = statsService.computeCoverage(backendTools);
    const failureNote =
      batchesFailed > 0
        ? `\n\n${batchesFailed} of ${batchesAttempted} sampling batches produced no usable result. Re-run to retry them, or fall back to the manual flow.`
        : '';

    return {
      content: [
        {
          type: 'text',
          text: `Compressed ${descriptions.length} of ${uncompressed.length} tools using this client's LLM.\n\nCoverage: ${coverageBefore.compressedTools}/${coverageBefore.totalTools} (${coverageBefore.coveragePercent}%) → ${coverageAfter.compressedTools}/${coverageAfter.totalTools} (${coverageAfter.coveragePercent}%)\nEstimated tokens saved: ~${coverageAfter.estimatedTokensSaved}${failureNote}\n\n${
            coverageAfter.uncompressedTools > 0
              ? `Remaining: ${coverageAfter.uncompressedTools}. Call this tool again for the next batch.`
              : 'All tools have been compressed! 🎉'
          }`,
        },
      ],
    };
  }

  if (name === 'mcp-compression-proxy__stats') {
    const { serverName, detailLevel } = args as {
      serverName?: string;
      detailLevel?: 'summary' | 'full';
    };

    try {
      const stats = await statsService.getStats({ serverName, detailLevel });

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(stats, null, 2),
          },
        ],
      };
    } catch (error) {
      logger.error({ error, serverName }, 'Failed to compute stats');
      return {
        content: [
          {
            type: 'text',
            text: `Error generating stats: ${error instanceof Error ? error.message : 'Unknown error'}`,
          },
        ],
        isError: true,
      };
    }
  }

  // Aggregated MCP tool call
  // Tool name format: "serverName__toolName". Split on the first separator
  // only - backend tools are free to have "__" in their own names.
  const separatorIndex = name.indexOf('__');

  if (separatorIndex <= 0 || separatorIndex + 2 >= name.length) {
    return {
      content: [
        {
          type: 'text',
          text: `Error: Invalid tool name format. Expected "serverName__toolName", got "${name}"`,
        },
      ],
      isError: true,
    };
  }

  const serverName = name.slice(0, separatorIndex);
  const toolName = name.slice(separatorIndex + 2);
  const client = clientManager.getClient(serverName);

  if (!client) {
    return {
      content: [
        {
          type: 'text',
          text: `Error: Server '${serverName}' not found or not connected`,
        },
      ],
      isError: true,
    };
  }

  try {
    const result = await client.callTool({
      name: toolName,
      arguments: args || {},
    });

    return result;
  } catch (error) {
    logger.error({ serverName, toolName, error }, 'Tool call failed');

    return {
      content: [
        {
          type: 'text',
          text: `Error calling tool: ${error instanceof Error ? error.message : 'Unknown error'}`,
        },
      ],
      isError: true,
    };
  }
});

/**
 * Shut down backend servers and exit.
 *
 * Without this the proxy leaves every spawned backend MCP server running when
 * its own client goes away, leaking a process tree per client restart.
 */
let shuttingDown = false;
async function shutdown(reason: string, exitCode = 0): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;

  logger.info({ reason }, 'Shutting down');

  try {
    await clientManager.disconnectAll();
  } catch (error) {
    logger.error({ error }, 'Error while disconnecting backend servers');
  }

  try {
    await server.close();
  } catch (error) {
    logger.debug({ error }, 'Error while closing server transport');
  }

  sessionManager.destroy();

  process.exit(exitCode);
}

/**
 * Parse command-line arguments
 */
function parseArgs(): { clearCache: boolean } {
  const args = process.argv.slice(2);
  return {
    clearCache: args.includes('--clear-cache'),
  };
}

/**
 * Start the server
 */
async function main() {
  logger.info('Starting MCP Tool Aggregator Server');

  // Parse command-line arguments
  const { clearCache } = parseArgs();

  // Handle --clear-cache flag
  if (clearCache) {
    logger.info('Clearing compression cache...');
    await compressionCache.clearAll();
    logger.info('Cache cleared successfully');
    process.exit(0);
  }

  // Load cached compressions from disk
  try {
    await compressionCache.loadFromDisk();
  } catch (error) {
    logger.warn({ error }, 'Failed to load cache, continuing with empty cache');
  }

  // Load configuration from JSON files
  const config = loadJSONServersCached();

  // Initialize backend MCP servers BEFORE connecting to Q CLI
  // This ensures all tools are available when the MCP client queries us
  if (!config) {
    logger.warn('No valid configuration found. Server will start with no backend MCP servers. Please create a servers.json file to add MCP servers.');
    // Continue with empty configuration - server will only provide management tools
  } else {
    // Configure noCompress patterns and uncompressed-tool fallback
    compressionCache.setNoCompressPatterns(config.noCompressPatterns);
    compressionCache.setFallbackBehavior(config.compressionFallbackBehavior ?? 'original');

    // Initialize MCP clients (only enabled servers)
    const enabledServers = config.servers.filter(server => {
      // Server is enabled if enabled field is not explicitly false
      return server.enabled !== false;
    });

    logger.info({
      total: config.servers.length,
      enabled: enabledServers.length,
      servers: enabledServers.map(s => s.name)
    }, 'Initializing backend MCP servers with timeout protection');

    // Wait for all servers to initialize or timeout before reporting ready
    try {
      await clientManager.initializeServers(
        enabledServers,
        config.defaultTimeout,
        config.inheritEnv
      );
      logger.info('Backend MCP servers initialization complete');
    } catch (error) {
      logger.error({ error }, 'Error during backend server initialization');
    }
  }

  // Now connect to the MCP client - all backend servers are ready (or timed out)
  const transport = new StdioServerTransport();

  // When the client disconnects, take the backend servers down with us.
  server.onclose = () => {
    void shutdown('client disconnected');
  };

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      void shutdown(signal);
    });
  }

  await server.connect(transport);

  logger.info('MCP Tool Aggregator Server ready and connected to stdio');
}

main().catch((error) => {
  logger.error({ error }, 'Server failed to start');
  process.exit(1);
});
