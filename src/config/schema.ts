/**
 * JSON Schema for MCP server configuration
 */
export const serverConfigSchema = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  type: 'object',
  properties: {
    mcpServers: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: {
            type: 'string',
            description: 'Unique name for the MCP server',
            minLength: 1,
          },
          command: {
            type: 'string',
            description: 'Command to execute',
            minLength: 1,
          },
          args: {
            type: 'array',
            description: 'Command arguments',
            items: {
              type: 'string',
            },
          },
          env: {
            type: 'object',
            description: 'Environment variables',
            additionalProperties: {
              type: 'string',
            },
          },
          enabled: {
            type: 'boolean',
            description: 'Whether the server is enabled',
          },
          timeout: {
            type: 'number',
            description: 'Server timeout in seconds',
          },
          type: {
            type: 'string',
            description: 'Server transport type (usually "stdio")',
          },
          autoApprove: {
            type: 'array',
            description: 'Tools to auto-approve',
            items: {
              type: 'string',
            },
          },
        },
        required: ['name', 'command'],
        additionalProperties: true,
      },
    },
    excludeTools: {
      type: 'array',
      description: 'Tool name patterns to exclude from tool list entirely (supports wildcards, case-insensitive). Examples: "server__*" (all tools from server), "*__set*" (tools with "set" in name)',
      items: {
        type: 'string',
      },
    },
    noCompressTools: {
      type: 'array',
      description: 'Tool name patterns whose original descriptions should always be shown to the LLM (supports wildcards, case-insensitive). Tools are still compressed and cached in the background for efficiency, but their original descriptions are always displayed when listing tools.',
      items: {
        type: 'string',
      },
    },
    defaultTimeout: {
      type: 'number',
      description: 'Default timeout in seconds for all servers (can be overridden per-server). Default is 30 seconds if not specified.',
      minimum: 1,
    },
  },
  required: ['mcpServers'],
  additionalProperties: false,
};

export type ServerConfigJSON = {
  mcpServers: Array<{
    name: string;
    command: string;
    args?: string[];
    env?: Record<string, string>;
    enabled?: boolean;
    timeout?: number;
    type?: string;
    autoApprove?: string[];
  }>;
  excludeTools?: string[];
  noCompressTools?: string[];
  defaultTimeout?: number;
};
