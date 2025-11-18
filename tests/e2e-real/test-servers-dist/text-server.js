#!/usr/bin/env node
/**
 * Test MCP Server: Text Operations
 * Provides simple text manipulation tools for e2e testing
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema, } from '@modelcontextprotocol/sdk/types.js';
const server = new Server({
    name: 'text-server',
    version: '1.0.0',
}, {
    capabilities: {
        tools: {},
    },
});
// List tools handler
server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
        tools: [
            {
                name: 'uppercase',
                description: 'Convert text to uppercase. This tool takes a string input and returns it converted to all uppercase letters.',
                inputSchema: {
                    type: 'object',
                    properties: {
                        text: {
                            type: 'string',
                            description: 'Text to convert to uppercase',
                        },
                    },
                    required: ['text'],
                },
            },
            {
                name: 'lowercase',
                description: 'Convert text to lowercase. This tool takes a string input and returns it converted to all lowercase letters.',
                inputSchema: {
                    type: 'object',
                    properties: {
                        text: {
                            type: 'string',
                            description: 'Text to convert to lowercase',
                        },
                    },
                    required: ['text'],
                },
            },
            {
                name: 'reverse',
                description: 'Reverse text string. This tool takes a string input and returns the characters in reverse order.',
                inputSchema: {
                    type: 'object',
                    properties: {
                        text: {
                            type: 'string',
                            description: 'Text to reverse',
                        },
                    },
                    required: ['text'],
                },
            },
            {
                name: 'count_words',
                description: 'Count words in text. This tool analyzes a text string and returns the number of words it contains.',
                inputSchema: {
                    type: 'object',
                    properties: {
                        text: {
                            type: 'string',
                            description: 'Text to count words in',
                        },
                    },
                    required: ['text'],
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
            case 'uppercase': {
                const { text } = args;
                return {
                    content: [
                        {
                            type: 'text',
                            text: text.toUpperCase(),
                        },
                    ],
                };
            }
            case 'lowercase': {
                const { text } = args;
                return {
                    content: [
                        {
                            type: 'text',
                            text: text.toLowerCase(),
                        },
                    ],
                };
            }
            case 'reverse': {
                const { text } = args;
                return {
                    content: [
                        {
                            type: 'text',
                            text: text.split('').reverse().join(''),
                        },
                    ],
                };
            }
            case 'count_words': {
                const { text } = args;
                const words = text.trim().split(/\s+/).filter(w => w.length > 0);
                return {
                    content: [
                        {
                            type: 'text',
                            text: `Word count: ${words.length}`,
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
    }
    catch (error) {
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
//# sourceMappingURL=text-server.js.map