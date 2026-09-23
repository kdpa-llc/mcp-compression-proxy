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

/**
 * MOCK_PAGE_SIZE makes the backend itself paginate tools/list, so the proxy's
 * cursor handling toward its backends is exercised, not just its own paging.
 */
const pageParsed = Number.parseInt(process.env.MOCK_PAGE_SIZE ?? '', 10);
const PAGE_SIZE = Number.isInteger(pageParsed) && pageParsed > 0 ? pageParsed : TOOL_COUNT;

function tool(index) {
  return {
    name: toolName(index),
    description: `Original verbose description for ${toolName(index)}, long enough that compressing it would visibly change the character count reported by the coverage numbers.`,
    inputSchema: {
      type: 'object',
      properties: {
        input: { type: 'string', description: 'Test input parameter' },
      },
    },
    // tool_001 carries metadata so the proxy's passthrough can be checked.
    ...(index === 1
      ? { title: 'Tool One', annotations: { readOnlyHint: true } }
      : {}),
  };
}

server.setRequestHandler(ListToolsRequestSchema, async (request) => {
  const offset = Number.parseInt(request.params?.cursor ?? '0', 10) || 0;
  const end = Math.min(offset + PAGE_SIZE, TOOL_COUNT);
  const tools = [];
  for (let index = offset; index < end; index++) {
    tools.push(tool(index));
  }
  return {
    tools,
    ...(end < TOOL_COUNT ? { nextCursor: String(end) } : {}),
  };
});

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
