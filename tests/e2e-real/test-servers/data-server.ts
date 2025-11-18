#!/usr/bin/env node
/**
 * Test MCP Server: Data Operations
 * Provides simple data manipulation tools for e2e testing
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

const server = new Server(
  {
    name: 'data-server',
    version: '1.0.0',
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// In-memory data store for testing
const dataStore: Record<string, string> = {};

// List tools handler
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: 'store_data',
        description: 'Store a key-value pair in memory. This tool allows you to save data with a unique key for later retrieval.',
        inputSchema: {
          type: 'object',
          properties: {
            key: {
              type: 'string',
              description: 'Key to store data under',
            },
            value: {
              type: 'string',
              description: 'Value to store',
            },
          },
          required: ['key', 'value'],
        },
      },
      {
        name: 'get_data',
        description: 'Retrieve data by key from memory. This tool fetches the value associated with a given key.',
        inputSchema: {
          type: 'object',
          properties: {
            key: {
              type: 'string',
              description: 'Key to retrieve data for',
            },
          },
          required: ['key'],
        },
      },
      {
        name: 'list_keys',
        description: 'List all stored keys. This tool returns a list of all keys currently stored in memory.',
        inputSchema: {
          type: 'object',
          properties: {},
        },
      },
    ],
  };
});

// Call tool handler
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    switch (name) {
      case 'store_data': {
        const { key, value } = args as { key: string; value: string };
        dataStore[key] = value;
        return {
          content: [
            {
              type: 'text',
              text: `Stored data with key: ${key}`,
            },
          ],
        };
      }
      case 'get_data': {
        const { key } = args as { key: string };
        const value = dataStore[key];
        if (value === undefined) {
          return {
            content: [
              {
                type: 'text',
                text: `Error: No data found for key: ${key}`,
              },
            ],
            isError: true,
          };
        }
        return {
          content: [
            {
              type: 'text',
              text: value,
            },
          ],
        };
      }
      case 'list_keys': {
        const keys = Object.keys(dataStore);
        return {
          content: [
            {
              type: 'text',
              text: keys.length > 0 ? `Keys: ${keys.join(', ')}` : 'No keys stored',
            },
          ],
        };
      }
      default:
        return {
          content: [
            {
              type: 'text',
              text: `Error: Unknown tool ${name}`,
            },
          ],
          isError: true,
        };
    }
  } catch (error) {
    return {
      content: [
        {
          type: 'text',
          text: `Error: ${error instanceof Error ? error.message : String(error)}`,
        },
      ],
      isError: true,
    };
  }
});

// Start server
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  console.error('Server error:', error);
  process.exit(1);
});
