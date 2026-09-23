import type { Tool } from '@modelcontextprotocol/sdk/types.js';

/**
 * The proxy's own management tools, as listed to a client. `liveStats` is the
 * coverage line appended to the compression tools' descriptions, so an agent
 * sees how much is left to compress without calling stats first.
 */
export function managementTools(liveStats: string): Tool[] {
  return [
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
      description:
        'Set the active session for subsequent tool calls (affects which tools show expanded descriptions)',
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
      description:
        'Clear all cached compressed tool descriptions. Use this to start fresh with compression or when tool descriptions have changed significantly.',
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
            description:
              'Array of compressed tool descriptions (max 100). Use this OR inputFile, not both.',
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
            description:
              'File path to read compressed tools JSON. Use this OR descriptions, not both.',
          },
        },
      },
    },
    {
      name: 'mcp-compression-proxy__invalidate_tool_cache',
      description:
        "Drop one tool's cached compressed description so it is compressed again. Use when a compression lost something important; descriptions that merely went stale are re-queued automatically.",
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
      description:
        'Get compression and server statistics. Optional inputs: serverName filter and detailLevel ("summary" | "full", default summary). Returns JSON with coverage, cache, and session details.',
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
    {
      name: 'mcp-compression-proxy__read_output',
      description:
        'Read a cached large tool output by payload ID. Reads 10K characters by default; use offset/length to page or all=true to return the remainder.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Payload ID returned by a tool call' },
          offset: { type: 'number', minimum: 0, default: 0 },
          length: { type: 'number', minimum: 1, default: 10000 },
          all: { type: 'boolean', default: false },
        },
        required: ['id'],
      },
    },
    {
      name: 'mcp-compression-proxy__find_output',
      description:
        'Find literal text inside a cached large tool output without loading the full payload into context.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Payload ID returned by a tool call' },
          query: { type: 'string', minLength: 1 },
          caseSensitive: { type: 'boolean', default: false },
          maxMatches: { type: 'number', minimum: 1, maximum: 100, default: 20 },
          contextChars: { type: 'number', minimum: 0, maximum: 2000, default: 200 },
        },
        required: ['id', 'query'],
      },
    },
    {
      name: 'mcp-compression-proxy__run_script',
      description:
        'Run up to 20 MCP calls sequentially. Later arguments may reference prior JSON output with {"$ref":"stepId#/json/pointer"}. This is declarative and does not execute shell or JavaScript.',
      inputSchema: {
        type: 'object',
        properties: {
          steps: {
            type: 'array',
            minItems: 1,
            maxItems: 20,
            items: {
              type: 'object',
              properties: {
                id: { type: 'string', minLength: 1 },
                server: { type: 'string', minLength: 1 },
                tool: { type: 'string', minLength: 1 },
                arguments: { type: 'object' },
                continueOnError: { type: 'boolean', default: false },
              },
              required: ['id', 'server', 'tool'],
            },
          },
        },
        required: ['steps'],
      },
    },
  ];
}
