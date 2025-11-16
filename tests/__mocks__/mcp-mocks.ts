import type { Tool } from '@modelcontextprotocol/sdk/types.js';

/**
 * Mock MCP Client for testing
 */
export class MockMCPClient {
  private tools: Tool[];
  private connected: boolean = false;

  constructor(tools: Tool[] = []) {
    this.tools = tools;
  }

  async connect(): Promise<void> {
    this.connected = true;
  }

  async close(): Promise<void> {
    this.connected = false;
  }

  async listTools() {
    if (!this.connected) {
      throw new Error('Client not connected');
    }
    return { tools: this.tools };
  }

  async callTool(params: { name: string; arguments?: Record<string, unknown> }) {
    if (!this.connected) {
      throw new Error('Client not connected');
    }

    const tool = this.tools.find((t) => t.name === params.name);
    if (!tool) {
      throw new Error(`Tool not found: ${params.name}`);
    }

    return {
      content: [
        {
          type: 'text',
          text: `Mock result for ${params.name}`,
        },
      ],
    };
  }

  isConnected(): boolean {
    return this.connected;
  }

  addTool(tool: Tool): void {
    this.tools.push(tool);
  }

  removeTool(toolName: string): void {
    this.tools = this.tools.filter((t) => t.name !== toolName);
  }
}

/**
 * Create a mock filesystem server client
 */
export function createMockFilesystemClient(): MockMCPClient {
  const tools: Tool[] = [
    {
      name: 'read_file',
      description:
        'Reads the complete contents of a file at the specified path. The file must exist and be readable. Returns the file contents as text. Supports absolute and relative paths. Maximum file size is 10MB.',
      inputSchema: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'Path to the file to read',
          },
        },
        required: ['path'],
      },
    },
    {
      name: 'write_file',
      description:
        'Writes content to a file at the specified path. Creates the file if it does not exist. Overwrites existing files. Creates parent directories as needed.',
      inputSchema: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'Path to the file to write',
          },
          content: {
            type: 'string',
            description: 'Content to write to the file',
          },
        },
        required: ['path', 'content'],
      },
    },
    {
      name: 'list_directory',
      description:
        'Lists all files and directories in the specified directory path. Returns names, types, and sizes.',
      inputSchema: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'Directory path to list',
          },
        },
        required: ['path'],
      },
    },
  ];

  return new MockMCPClient(tools);
}

/**
 * Create a mock GitHub server client
 */
export function createMockGitHubClient(): MockMCPClient {
  const tools: Tool[] = [
    {
      name: 'create_issue',
      description:
        'Creates a new GitHub issue with the specified title, body, labels, and assignees. Requires authentication with GitHub API.',
      inputSchema: {
        type: 'object',
        properties: {
          title: {
            type: 'string',
            description: 'Issue title',
          },
          body: {
            type: 'string',
            description: 'Issue body/description',
          },
          labels: {
            type: 'array',
            items: { type: 'string' },
            description: 'Labels to add to the issue',
          },
        },
        required: ['title'],
      },
    },
    {
      name: 'create_pull_request',
      description:
        'Creates a new pull request from the source branch to the target branch with title and description.',
      inputSchema: {
        type: 'object',
        properties: {
          title: {
            type: 'string',
            description: 'Pull request title',
          },
          head: {
            type: 'string',
            description: 'Source branch name',
          },
          base: {
            type: 'string',
            description: 'Target branch name',
          },
        },
        required: ['title', 'head', 'base'],
      },
    },
  ];

  return new MockMCPClient(tools);
}

/**
 * Create a failing mock client that fails to connect
 */
export function createFailingMockClient(): MockMCPClient {
  const client = new MockMCPClient([]);

  // Override connect to fail
  client.connect = async () => {
    throw new Error('Connection failed');
  };

  return client;
}

/**
 * Get mock logger for testing
 */
export function getMockLogger() {
  return {
    debug: (() => {}) as any,
    info: (() => {}) as any,
    warn: (() => {}) as any,
    error: (() => {}) as any,
    fatal: (() => {}) as any,
    trace: (() => {}) as any,
  };
}

/**
 * Sample compressed descriptions for testing
 */
export const SAMPLE_COMPRESSIONS = {
  'filesystem:read_file': {
    original:
      'Reads the complete contents of a file at the specified path. The file must exist and be readable. Returns the file contents as text. Supports absolute and relative paths. Maximum file size is 10MB.',
    compressed: 'Read file (text, max 10MB, abs/rel paths)',
  },
  'filesystem:write_file': {
    original:
      'Writes content to a file at the specified path. Creates the file if it does not exist. Overwrites existing files. Creates parent directories as needed.',
    compressed: 'Write file (create/overwrite, auto-mkdir)',
  },
  'filesystem:list_directory': {
    original:
      'Lists all files and directories in the specified directory path. Returns names, types, and sizes.',
    compressed: 'List dir (names, types, sizes)',
  },
  'github:create_issue': {
    original:
      'Creates a new GitHub issue with the specified title, body, labels, and assignees. Requires authentication with GitHub API.',
    compressed: 'Create GH issue (title, body, labels, assignees), needs auth',
  },
  'github:create_pull_request': {
    original:
      'Creates a new pull request from the source branch to the target branch with title and description.',
    compressed: 'Create PR (title, head->base)',
  },
};
