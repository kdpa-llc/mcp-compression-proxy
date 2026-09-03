#!/usr/bin/env node

/**
 * Mock MCP server exposing a configurable number of tools.
 *
 * Two suites need a backend with more than one tool: the exclude-pattern test
 * needs a tool to drop and a sibling that must survive, and the pagination test
 * needs more tools than a page holds. MOCK_TOOL_COUNT drives both so neither
 * has to ship its own server.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

const parsed = Number.parseInt(process.env.MOCK_TOOL_COUNT ?? '', 10);
const TOOL_COUNT = Number.isInteger(parsed) && parsed > 0 ? parsed : 3;

const server = new Server(
  { name: 'multi-tool-test-server', version: '1.0.0' },
  { capabilities: { tools: {} } }
);

/**
 * Tool names are zero-padded so lexical order matches numeric order - a
 * pagination assertion comparing page boundaries would otherwise trip on
 * tool_10 sorting before tool_2.
 */
function toolName(index) {
  return `tool_${String(index).padStart(3, '0')}`;
}

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: Array.from({ length: TOOL_COUNT }, (_unused, index) => ({
    name: toolName(index),
    description: `Original verbose description for ${toolName(index)}, long enough that compressing it would visibly change the character count reported by the coverage numbers.`,
    inputSchema: {
      type: 'object',
      properties: {
        input: { type: 'string', description: 'Test input parameter' },
      },
    },
  })),
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name } = request.params;

  return {
    content: [{ type: 'text', text: `${name} executed successfully` }],
    isError: !/^tool_\d{3}$/.test(name),
  };
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  console.error('Multi tool server failed:', error);
  process.exit(1);
});
