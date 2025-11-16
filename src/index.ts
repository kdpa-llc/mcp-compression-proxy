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
import { getEnabledServers } from './config/servers.js';
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
      name: 'create_session',
      description: 'Create a new session for independent tool expansion control',
      inputSchema: {
        type: 'object',
        properties: {},
      },
    },
    {
      name: 'delete_session',
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
      name: 'set_session',
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
      name: 'compress_tools',
      description: 'Get tools for compression. After calling this, compress the descriptions and call save_compressed_tools.',
      inputSchema: {
        type: 'object',
        properties: {},
      },
    },
    {
      name: 'save_compressed_tools',
      description: 'Save compressed tool descriptions to cache',
      inputSchema: {
        type: 'object',
        properties: {
          descriptions: {
            type: 'array',
            description: 'Array of compressed tool descriptions',
            items: {
              type: 'object',
              properties: {
                serverName: { type: 'string' },
                toolName: { type: 'string' },
                compressedDescription: { type: 'string' },
              },
              required: ['serverName', 'toolName', 'compressedDescription'],
            },
          },
        },
        required: ['descriptions'],
      },
    },
    {
      name: 'expand_tool',
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
      name: 'collapse_tool',
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

  logger.debug({ count: allTools.length }, 'Returning tools');

  return { tools: allTools };
});

/**
 * Call a tool (either management tool or aggregated MCP tool)
 */
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  logger.debug({ tool: name, args }, 'Handling tools/call request');

  // Management tools
  if (name === 'create_session') {
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

  if (name === 'delete_session') {
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

  if (name === 'set_session') {
    const { sessionId } = args as { sessionId: string };

    if (!sessionManager.hasSession(sessionId)) {
      return {
        content: [
          {
            type: 'text',
            text: `Error: Session ${sessionId} not found. Create a session first with create_session.`,
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

  if (name === 'compress_tools') {
    const clients = clientManager.getConnectedClients();
    const toolPromises = clients.map(async ({ name, client }) => {
      try {
        const result = await client.listTools();
        return result.tools.map((tool) => ({
          serverName: name,
          toolName: tool.name,
          description: tool.description || '',
        }));
      } catch (error) {
        return [];
      }
    });

    const toolArrays = await Promise.all(toolPromises);
    const allTools = toolArrays.flat();

    return {
      content: [
        {
          type: 'text',
          text: `Found ${allTools.length} tools to compress.\n\nPlease compress the following tool descriptions:\n\n${JSON.stringify(allTools, null, 2)}\n\nAfter compressing, call save_compressed_tools with the compressed descriptions.`,
        },
      ],
    };
  }

  if (name === 'save_compressed_tools') {
    const { descriptions } = args as {
      descriptions: Array<{
        serverName: string;
        toolName: string;
        compressedDescription: string;
      }>;
    };

    let savedCount = 0;

    for (const desc of descriptions) {
      const { serverName, toolName, compressedDescription } = desc;

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

    return {
      content: [
        {
          type: 'text',
          text: `Saved ${savedCount} compressed tool descriptions. These will now be used when listing tools.`,
        },
      ],
    };
  }

  if (name === 'expand_tool') {
    const { serverName, toolName } = args as {
      serverName: string;
      toolName: string;
    };

    if (!currentSessionId) {
      return {
        content: [
          {
            type: 'text',
            text: 'Error: No active session. Create a session first with create_session.',
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

  if (name === 'collapse_tool') {
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
 * Start the server
 */
async function main() {
  logger.info('Starting MCP Tool Aggregator Server');

  // Initialize MCP clients
  const servers = getEnabledServers();
  await clientManager.initializeServers(servers);

  // Start server with stdio transport
  const transport = new StdioServerTransport();
  await server.connect(transport);

  logger.info('MCP Tool Aggregator Server running on stdio');
}

main().catch((error) => {
  logger.error({ error }, 'Server failed to start');
  process.exit(1);
});
