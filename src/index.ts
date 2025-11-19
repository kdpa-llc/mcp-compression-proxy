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
import { loadJSONServers, matchesIgnorePattern } from './config/loader.js';
import { writeFileSync, readFileSync } from 'fs';
import { resolve } from 'path';
import pino from 'pino';

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

// Current session context (set by tools)
let currentSessionId: string | undefined;

// Create MCP server
const server = new Server(
  {
    name: 'mcp-compression-proxy',
    version: '0.1.0',
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

/**
 * List all tools from aggregated MCP servers + management tools
 */
server.setRequestHandler(ListToolsRequestSchema, async () => {
  logger.debug('Handling tools/list request');

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
      description: 'Get tools that need compression (those without cached compressed descriptions). Returns up to the specified limit of tools that need compression. After compressing these descriptions, call mcp-compression-proxy__cache_compressed_tools. Repeat this process until no uncached tools remain.',
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
      description: 'Save compressed tool descriptions to cache (max 100 tools per call). Provide either descriptions array or inputFile path. After caching, call mcp-compression-proxy__get_uncompressed_tools again to get the next batch if any remain uncached. Continue until all tools are compressed.',
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
  ];

  // Get tools from all connected MCP servers
  const clients = clientManager.getConnectedClients();
  logger.info({ connectedCount: clients.length, clients: clients.map(c => c.name) }, 'Connected clients for tools/list');
  
  const toolPromises = clients.map(async ({ name, client }) => {
    try {
      const result = await client.listTools();
      return result.tools.map((tool) => {
        // Check if tool is expanded in current session
        const isExpanded = sessionManager.isToolExpanded(
          currentSessionId,
          name,
          tool.name
        );

        // Get description: compressed by default, original if expanded
        const description = compressionCache.getDescription(
          name,
          tool.name,
          tool.description,
          isExpanded
        );

        return {
          name: `${name}__${tool.name}`,
          description,
          inputSchema: tool.inputSchema,
        };
      });
    } catch (error) {
      logger.error({ server: name, error }, 'Failed to list tools from server');
      return [];
    }
  });

  const toolArrays = await Promise.all(toolPromises);
  const aggregatedTools = toolArrays.flat();

  const allTools = [...aggregatorTools, ...aggregatedTools];

  // Apply exclude patterns to filter out tools
  const config = loadJSONServers();
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

    const clients = clientManager.getConnectedClients();
    const toolPromises = clients.map(async ({ name, client }) => {
      try {
        const result = await client.listTools();
        return result.tools
          .filter((tool) => !compressionCache.hasCompressed(name, tool.name))
          .map((tool) => ({
            serverName: name,
            toolName: tool.name,
            description: tool.description || '',
          }));
      } catch (error) {
        return [];
      }
    });

    const toolArrays = await Promise.all(toolPromises);
    const allUncompressedTools = toolArrays.flat();
    
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
              text: `Found ${allUncompressedTools.length} tools without compressed descriptions.\n\nWrote ${toolsToCompress.length} tools to file: ${filePath}\n\nRemaining uncached tools: ${remaining}\n\nAfter compressing the descriptions in the file, call mcp-compression-proxy__cache_compressed_tools with inputFile parameter.${remaining > 0 ? '\n\nThen call mcp-compression-proxy__get_uncompressed_tools again to get the next batch.' : ''}`,
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
          text: `Found ${allUncompressedTools.length} tools without compressed descriptions.\n\nReturning ${toolsToCompress.length} tools for compression (limit: ${actualLimit}).\n\nRemaining uncached tools: ${remaining}\n\nTools to compress:\n\n${JSON.stringify(toolsToCompress, null, 2)}\n\nAfter compressing these descriptions, call mcp-compression-proxy__cache_compressed_tools with the results.${remaining > 0 ? '\n\nThen call mcp-compression-proxy__get_uncompressed_tools again to get the next batch.' : ''}`,
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

    let toolsToCache: Array<{
      serverName: string;
      toolName: string;
      description: string;
    }> = [];

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

    let savedCount = 0;

    for (const desc of toolsToCache) {
      const { serverName, toolName, description: compressedDescription } = desc;

      // Get original description from MCP server
      const client = clientManager.getClient(serverName);
      let originalDescription: string | undefined;

      if (client) {
        try {
          const result = await client.listTools();
          const tool = result.tools.find((t) => t.name === toolName);
          originalDescription = tool?.description;
        } catch (error) {
          logger.error({ serverName, toolName, error }, 'Failed to fetch original');
        }
      }

      compressionCache.saveCompressed(
        serverName,
        toolName,
        compressedDescription,
        originalDescription
      );

      savedCount++;
    }

    // Check for remaining uncached tools
    const clients = clientManager.getConnectedClients();
    const remainingPromises = clients.map(async ({ name, client }) => {
      try {
        const result = await client.listTools();
        return result.tools.filter((tool) => !compressionCache.hasCompressed(name, tool.name));
      } catch (error) {
        return [];
      }
    });

    const remainingArrays = await Promise.all(remainingPromises);
    const remainingTools = remainingArrays.flat().length;

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
          text: `Cached ${savedCount} compressed tool descriptions successfully ${sourceInfo}.\n\n${remainingTools > 0 ? `Remaining tools to compress: ${remainingTools}\n\nCall mcp-compression-proxy__get_uncompressed_tools to continue with the next batch.` : 'All tools have been compressed! 🎉'}`,
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

  // Aggregated MCP tool call
  // Tool name format: "serverName__toolName"
  const parts = name.split('__');

  if (parts.length !== 2) {
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

  const [serverName, toolName] = parts;
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
  const config = loadJSONServers();

  // Initialize backend MCP servers BEFORE connecting to Q CLI
  // This ensures all tools are available when the MCP client queries us
  if (!config) {
    logger.warn('No valid configuration found. Server will start with no backend MCP servers. Please create a servers.json file to add MCP servers.');
    // Continue with empty configuration - server will only provide management tools
  } else {
    // Configure noCompress patterns
    compressionCache.setNoCompressPatterns(config.noCompressPatterns);

    // Initialize MCP clients (only enabled servers)
    const enabledServers = config.servers.filter(server => {
      // Server is disabled if disabled=true, regardless of enabled field
      if ((server as any).disabled === true) return false;
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
      await clientManager.initializeServers(enabledServers, config.defaultTimeout);
      logger.info('Backend MCP servers initialization complete');
    } catch (error) {
      logger.error({ error }, 'Error during backend server initialization');
    }
  }

  // Now connect to Q CLI - all backend servers are ready (or timed out)
  const transport = new StdioServerTransport();
  await server.connect(transport);

  logger.info('MCP Tool Aggregator Server ready and connected to stdio');
}

main().catch((error) => {
  logger.error({ error }, 'Server failed to start');
  process.exit(1);
});
