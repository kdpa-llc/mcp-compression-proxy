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
            description: 'Command to execute for a locally spawned (stdio) server',
            minLength: 1,
          },
          url: {
            type: 'string',
            description:
              'Endpoint of a hosted MCP server, spoken over Streamable HTTP. Mutually exclusive with "command"; the stdio-only fields (args, env, inheritEnv) do not apply.',
            minLength: 1,
          },
          headers: {
            type: 'object',
            description:
              'Static HTTP headers sent with every request to "url", e.g. { "Authorization": "Bearer ${MY_TOKEN}" }. Values go through the same ${VAR} expansion as "env".',
            additionalProperties: {
              type: 'string',
            },
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
          inheritEnv: {
            description:
              "Which of the proxy's own environment variables this server inherits. true = inherit all (default), false = inherit only the transport's safe defaults (PATH, HOME, ...), or an array of variable names to inherit. Values in `env` always take precedence. Overrides the top-level `inheritEnv`.",
            oneOf: [
              { type: 'boolean' },
              { type: 'array', items: { type: 'string' } },
            ],
          },
          enabled: {
            type: 'boolean',
            description: 'Whether the server is enabled',
          },
          timeout: {
            type: 'number',
            description: 'Server timeout in seconds',
          },
          // Accepted but never read. Presence of `url` is the transport
          // discriminator; keeping `type` declared only stops configs that
          // already carry it from failing the stricter check below.
          type: {
            type: 'string',
            description: 'Ignored. Kept for compatibility with existing configs.',
          },
          autoApprove: {
            type: 'array',
            description: 'Tools to auto-approve',
            items: {
              type: 'string',
            },
          },
        },
        required: ['name'],
        // Exactly one transport. `oneOf` also rejects an entry that sets both,
        // so no extra `not` is needed to catch command+url.
        oneOf: [{ required: ['command'] }, { required: ['url'] }],
        // Deliberately permissive. A misspelled *required* key like "comand"
        // is already rejected by the oneOf above - neither command nor url
        // survives the typo - so strictness here would only add misspelled
        // optional keys, and it would pay for that by failing the entire
        // config, and so every server, on something like Claude Desktop's
        // `disabled` copied in from another client. The loader warns about
        // unrecognized keys instead, which keeps the diagnostic without
        // turning a cosmetic field into total loss of tools.
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
    cli: {
      type: 'object',
      description: 'CLI (mcp-cli) configuration for lazy-loading mode',
      properties: {
        payloadThreshold: {
          type: 'number',
          description: 'Character threshold for redirecting large tool outputs to temp files. Default: 500.',
          minimum: 0,
          default: 500,
        },
        autoStartDaemon: {
          type: 'boolean',
          description: 'Auto-start daemon when running CLI commands. Default: true.',
          default: true,
        },
        daemonLogLevel: {
          type: 'string',
          description: 'Log level for the daemon process. Default: "info".',
          enum: ['debug', 'info', 'warn', 'error'],
          default: 'info',
        },
      },
      additionalProperties: false,
    },
    inheritEnv: {
      description:
        "Default environment inheritance for all servers (can be overridden per-server). true = pass the proxy's full environment to every backend server (default), false = pass only the transport's safe defaults (PATH, HOME, ...), or an array of variable names to pass through.",
      oneOf: [
        { type: 'boolean' },
        { type: 'array', items: { type: 'string' } },
      ],
    },
    compressionFallbackBehavior: {
      type: 'string',
      description:
        "What to show for a tool that has no compressed description yet. 'original' (default) shows the server's original description; 'blank' shows an empty description so uncompressed tools consume no context.",
      enum: ['original', 'blank'],
    },
  },
  required: ['mcpServers'],
  additionalProperties: false,
};

/** Environment inheritance policy: all, none/safe-defaults, or an allowlist. */
export type InheritEnv = boolean | string[];

/** How to describe a tool that has no compressed description cached yet. */
export type CompressionFallbackBehavior = 'original' | 'blank';

export type ServerConfigJSON = {
  mcpServers: Array<{
    name: string;
    command?: string;
    args?: string[];
    env?: Record<string, string>;
    inheritEnv?: InheritEnv;
    url?: string;
    headers?: Record<string, string>;
    enabled?: boolean;
    timeout?: number;
    type?: string;
    autoApprove?: string[];
  }>;
  excludeTools?: string[];
  noCompressTools?: string[];
  defaultTimeout?: number;
  cli?: {
    payloadThreshold?: number;
    autoStartDaemon?: boolean;
    daemonLogLevel?: string;
  };
  inheritEnv?: InheritEnv;
  compressionFallbackBehavior?: CompressionFallbackBehavior;
};
