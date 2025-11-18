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
        },
        required: ['name', 'command'],
        additionalProperties: false,
      },
    },
    ignoreTools: {
      type: 'array',
      description: 'Tool name patterns to ignore/exclude (supports wildcards, case-insensitive). Examples: "server__*" (all tools from server), "*__set*" (tools with "set" in name)',
      items: {
        type: 'string',
      },
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
  }>;
  ignoreTools?: string[];
};
