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

/**
 * MOCK_BARE_TOOL adds `bare`: no description, and a result with an image and
 * an empty text part, for the paths that handle a tool saying little.
 */
const BARE = process.env.MOCK_BARE_TOOL === '1';

server.setRequestHandler(ListToolsRequestSchema, async (request) => {
  const offset = Number.parseInt(request.params?.cursor ?? '0', 10) || 0;
  const end = Math.min(offset + PAGE_SIZE, TOOL_COUNT);
  const tools = [];
  for (let index = offset; index < end; index++) {
    tools.push(tool(index));
  }
  if (BARE && end >= TOOL_COUNT) {
    tools.push({ name: 'bare', inputSchema: { type: 'object', properties: {} } });
  }
  return {
    tools,
    ...(end < TOOL_COUNT ? { nextCursor: String(end) } : {}),
  };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name } = request.params;
  const input = request.params.arguments?.input;
  if (BARE && name === 'bare') {
    return {
      content: [
        { type: 'image', data: 'AAAA', mimeType: 'image/png' },
        { type: 'text', text: '' },
        { type: 'text', text: 'bare done' },
      ],
    };
  }

  // A JSON input is echoed back, so shaping can be tested on real output.
  // @pid, @cwd and @env:NAME report on this process, so a test can see which
  // process answered and what directory and environment it was given.
  let text = `${name} executed successfully`;
  if (typeof input === 'string' && /^[[{]/.test(input.trim())) {
    text = input;
  } else if (input === '@pid') {
    text = String(process.pid);
  } else if (input === '@cwd') {
    text = process.cwd();
  } else if (typeof input === 'string' && input.startsWith('@env:')) {
    text = process.env[input.slice(5)] ?? '(unset)';
  }

  return {
    content: [{ type: 'text', text }],
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
