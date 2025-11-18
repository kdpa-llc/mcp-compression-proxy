#!/usr/bin/env node
/**
 * Test MCP Server: Math Operations
 * Provides simple math tools for e2e testing
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

const server = new Server(
  {
    name: 'math-server',
    version: '1.0.0',
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// List tools handler
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: 'add',
        description: 'Add two numbers together. This tool performs addition operation on two numeric values and returns their sum.',
        inputSchema: {
          type: 'object',
          properties: {
            a: {
              type: 'number',
              description: 'First number',
            },
            b: {
              type: 'number',
              description: 'Second number',
            },
          },
          required: ['a', 'b'],
        },
      },
      {
        name: 'multiply',
        description: 'Multiply two numbers together. This tool performs multiplication operation on two numeric values and returns their product.',
        inputSchema: {
          type: 'object',
          properties: {
            a: {
              type: 'number',
              description: 'First number',
            },
            b: {
              type: 'number',
              description: 'Second number',
            },
          },
          required: ['a', 'b'],
        },
      },
      {
        name: 'square',
        description: 'Calculate the square of a number. This tool takes a numeric value and returns its square (n * n).',
        inputSchema: {
          type: 'object',
          properties: {
            n: {
              type: 'number',
              description: 'Number to square',
            },
          },
          required: ['n'],
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
      case 'add': {
        const { a, b } = args as { a: number; b: number };
        const result = a + b;
        return {
          content: [
            {
              type: 'text',
              text: `Result: ${result}`,
            },
          ],
        };
      }
      case 'multiply': {
        const { a, b } = args as { a: number; b: number };
        const result = a * b;
        return {
          content: [
            {
              type: 'text',
              text: `Result: ${result}`,
            },
          ],
        };
      }
      case 'square': {
        const { n } = args as { n: number };
        const result = n * n;
        return {
          content: [
            {
              type: 'text',
              text: `Result: ${result}`,
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
