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
            oneOf: [{ type: 'boolean' }, { type: 'array', items: { type: 'string' } }],
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
          softMaxConnectionAgeSeconds: {
            type: 'number',
            description:
              'Lazy recycle threshold in seconds. On the first use at or after this age, the old connection drains and a fresh backend is opened. 0 disables.',
            minimum: 0,
          },
          hardMaxConnectionAgeSeconds: {
            type: 'number',
            description:
              'Absolute connection lifetime in seconds. At this age the connection drains, closes after active calls finish, and remains closed until reused. 0 disables.',
            minimum: 0,
          },
          maxConnectionAgeSeconds: {
            type: 'number',
            description: 'Deprecated alias for softMaxConnectionAgeSeconds.',
            minimum: 0,
          },
          authErrorPatterns: {
            type: 'array',
            description:
              'Case-insensitive substrings that identify authentication failures in tool results or thrown errors.',
            items: {
              type: 'string',
              minLength: 1,
            },
          },
          authRetryTools: {
            type: 'array',
            description:
              'Tool-name wildcard patterns that are safe to retry once after an authentication failure reopens the backend.',
            items: {
              type: 'string',
              minLength: 1,
            },
          },
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
      description:
        'Tool name patterns to exclude from tool list entirely (supports wildcards, case-insensitive). Examples: "server__*" (all tools from server), "*__set*" (tools with "set" in name)',
      items: {
        type: 'string',
      },
    },
    noCompressTools: {
      type: 'array',
      description:
        'Tool name patterns whose original descriptions should always be shown to the LLM (supports wildcards, case-insensitive). Tools are still compressed and cached in the background for efficiency, but their original descriptions are always displayed when listing tools.',
      items: {
        type: 'string',
      },
    },
    defaultTimeout: {
      type: 'number',
      description:
        'Default timeout in seconds for all servers (can be overridden per-server). Default is 30 seconds if not specified.',
      minimum: 1,
    },
    softMaxConnectionAgeSeconds: {
      type: 'number',
      description:
        'Global lazy recycle threshold in seconds. Default is 3600 (1 hour). 0 disables.',
      minimum: 0,
    },
    hardMaxConnectionAgeSeconds: {
      type: 'number',
      description:
        'Global absolute connection lifetime in seconds. Default is 28800 (8 hours). 0 disables.',
      minimum: 0,
    },
    maxConnectionAgeSeconds: {
      type: 'number',
      description: 'Deprecated alias for softMaxConnectionAgeSeconds.',
      minimum: 0,
    },
    authErrorPatterns: {
      type: 'array',
      description: 'Global case-insensitive substrings that identify authentication failures.',
      items: {
        type: 'string',
        minLength: 1,
      },
    },
    authRetryTools: {
      type: 'array',
      description:
        'Global tool-name wildcard patterns that are safe to retry once after authentication recovery.',
      items: {
        type: 'string',
        minLength: 1,
      },
    },
    cli: {
      type: 'object',
      description: 'CLI (mcp-cli) configuration for lazy-loading mode',
      properties: {
        payloadThreshold: {
          type: 'number',
          description:
            'Character threshold for caching large tool outputs in private files. Default: 10000.',
          minimum: 0,
          default: 10000,
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
      oneOf: [{ type: 'boolean' }, { type: 'array', items: { type: 'string' } }],
    },
    toolExposure: {
      type: 'string',
      description:
        "How the native proxy presents backend tools. 'full' (default) lists every tool with its schema. 'lazy' lists only search_tools, get_tool and call_tool (plus pinnedTools), so schemas are loaded on demand like mcp-cli does.",
      enum: ['full', 'lazy'],
    },
    pinnedTools: {
      type: 'array',
      description:
        "Tool name patterns ('server__tool', wildcards allowed) still listed directly when toolExposure is 'lazy'.",
      items: { type: 'string', minLength: 1 },
    },
    search: {
      type: 'object',
      description: 'Tool search settings for mcp-cli search and the lazy-mode search_tools tool.',
      properties: {
        limit: {
          type: 'number',
          description: 'Results returned by default. Default: 15.',
          minimum: 1,
        },
        learnFromUsage: {
          type: 'boolean',
          description:
            'Record which tool an agent uses after a search (locally, owner-only) to rank those tools higher for similar queries and to report search quality. Default: false.',
        },
      },
      additionalProperties: false,
    },
    model: {
      type: 'object',
      description:
        'Optional local model (Cactus Needle 3) used for semantic search, call suggestions, text extraction and compression checks. Runs as a local subprocess; nothing is sent to a hosted service.',
      properties: {
        provider: {
          type: 'string',
          enum: ['needle'],
          description: 'Model provider. Only "needle" is supported.',
        },
        command: {
          type: 'string',
          description:
            'Interpreter that runs the bridge. Default: "python3". Point it at a virtualenv with cactus-needle installed.',
          minLength: 1,
        },
        args: {
          type: 'array',
          description: 'Arguments for the command. Default: the bundled needle_bridge.py.',
          items: { type: 'string' },
        },
        env: {
          type: 'object',
          description:
            'Extra environment variables for the bridge. Telemetry is always disabled (NEEDLE_TELEMETRY=0, DO_NOT_TRACK=1).',
          additionalProperties: { type: 'string' },
        },
        timeout: {
          type: 'number',
          description: 'Seconds to wait for one model request. Default: 60.',
          minimum: 1,
        },
        idleTimeout: {
          type: 'number',
          description: 'Seconds of inactivity before the bridge process is stopped. Default: 600. 0 keeps it running.',
          minimum: 0,
        },
        semanticSearch: {
          type: 'boolean',
          description: 'Blend model similarity into tool search. Default: true.',
        },
        confirmAuthFailures: {
          type: 'boolean',
          description:
            'When an auth error pattern appears inside a long, successful tool result, ask the model whether it is really an authentication failure before dropping the connection. Default: false.',
        },
      },
      required: ['provider'],
      additionalProperties: false,
    },
    compressor: {
      type: 'object',
      description:
        'An OpenAI-compatible chat completions endpoint (Ollama, LM Studio, vLLM, a hosted API) that writes compressed descriptions when the MCP client cannot lend its model through sampling.',
      properties: {
        url: {
          type: 'string',
          description: 'Base URL, e.g. "http://localhost:11434/v1". /chat/completions is appended.',
          minLength: 1,
        },
        model: { type: 'string', description: 'Model name, e.g. "llama3.2".', minLength: 1 },
        apiKey: {
          type: 'string',
          description: 'Bearer token, usually "${OPENAI_API_KEY}". Omit for local servers.',
        },
        headers: {
          type: 'object',
          description: 'Extra HTTP headers.',
          additionalProperties: { type: 'string' },
        },
        timeout: {
          type: 'number',
          description: 'Seconds to wait for one completion. Default: 120.',
          minimum: 1,
        },
      },
      required: ['url', 'model'],
      additionalProperties: false,
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

/** How the native proxy presents backend tools. */
export type ToolExposure = 'full' | 'lazy';

export interface SearchConfig {
  limit?: number;
  learnFromUsage?: boolean;
}

export interface ModelConfig {
  provider: 'needle';
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  timeout?: number;
  idleTimeout?: number;
  semanticSearch?: boolean;
  confirmAuthFailures?: boolean;
}

export interface CompressorConfig {
  url: string;
  model: string;
  apiKey?: string;
  headers?: Record<string, string>;
  timeout?: number;
}

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
    softMaxConnectionAgeSeconds?: number;
    hardMaxConnectionAgeSeconds?: number;
    maxConnectionAgeSeconds?: number;
    authErrorPatterns?: string[];
    authRetryTools?: string[];
    type?: string;
    autoApprove?: string[];
  }>;
  excludeTools?: string[];
  noCompressTools?: string[];
  defaultTimeout?: number;
  softMaxConnectionAgeSeconds?: number;
  hardMaxConnectionAgeSeconds?: number;
  maxConnectionAgeSeconds?: number;
  authErrorPatterns?: string[];
  authRetryTools?: string[];
  cli?: {
    payloadThreshold?: number;
    autoStartDaemon?: boolean;
    daemonLogLevel?: string;
  };
  inheritEnv?: InheritEnv;
  compressionFallbackBehavior?: CompressionFallbackBehavior;
  toolExposure?: ToolExposure;
  pinnedTools?: string[];
  search?: SearchConfig;
  model?: ModelConfig;
  compressor?: CompressorConfig;
};
