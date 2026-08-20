import { readFileSync, existsSync, statSync } from 'fs';
import { join } from 'path';
import { homedir as osHomedir } from 'os';
import type { MCPServerConfig } from '../types/index.js';
import {
  serverConfigSchema,
  type ServerConfigJSON,
  type InheritEnv,
  type CompressionFallbackBehavior,
} from './schema.js';
import Ajv from 'ajv';

const ajv = new Ajv({ allErrors: true });
const validate = ajv.compile(serverConfigSchema);

/**
 * Get home directory (testable)
 */
function homedir(): string {
  return process.env.HOME || osHomedir();
}

/**
 * Expands environment variables in a string.
 *
 * Supported syntax:
 * - `${VAR}`           - substitutes the variable, or '' when it is not set
 * - `${VAR:-fallback}` - substitutes the variable, or `fallback` when unset/empty
 * - `$${VAR}`          - escape hatch, produces the literal text `${VAR}`
 *
 * Names of `${VAR}` references that could not be resolved are collected into
 * `unresolved` so the caller can warn instead of silently injecting an empty
 * string (a common cause of confusing downstream 401s).
 */
function expandEnvVars(value: string, unresolved: Set<string>): string {
  return value.replace(
    /(\$?)\$\{([^}]+)\}/g,
    (match, escape: string, expression: string) => {
      // `$${VAR}` is an escape for a literal `${VAR}`
      if (escape) {
        return match.slice(1);
      }

      const separatorIndex = expression.indexOf(':-');
      const varName =
        separatorIndex === -1 ? expression : expression.slice(0, separatorIndex);
      const defaultValue =
        separatorIndex === -1 ? undefined : expression.slice(separatorIndex + 2);

      const resolved = process.env[varName];
      if (resolved) {
        return resolved;
      }

      if (defaultValue !== undefined) {
        return defaultValue;
      }

      unresolved.add(varName);
      return '';
    }
  );
}

/**
 * Recursively expands environment variables in an object
 */
function expandEnvVarsInObject(obj: any, unresolved: Set<string>): any {
  if (typeof obj === 'string') {
    return expandEnvVars(obj, unresolved);
  }
  if (Array.isArray(obj)) {
    return obj.map((item) => expandEnvVarsInObject(item, unresolved));
  }
  if (obj !== null && typeof obj === 'object') {
    const result: any = {};
    for (const [key, value] of Object.entries(obj)) {
      result[key] = expandEnvVarsInObject(value, unresolved);
    }
    return result;
  }
  return obj;
}

/**
 * Validates JSON config against schema
 */
function validateConfig(config: unknown): ServerConfigJSON {
  if (!validate(config)) {
    const errors = validate.errors
      ?.map((err) => {
        const path = err.instancePath || 'root';
        const data = err.data ? JSON.stringify(err.data, null, 2) : 'undefined';
        return `  - ${path}: ${err.message}\n    Data: ${data}`;
      })
      .join('\n');
    console.error(`[Config] Validation failed:\n${errors}`);
    throw new Error(`Invalid server configuration:\n${errors}`);
  }
  return config as ServerConfigJSON;
}

/**
 * Load and parse JSON config from a file
 */
function loadJSONConfig(filePath: string): ServerConfigJSON | null {
  if (!existsSync(filePath)) {
    return null;
  }

  try {
    const content = readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(content);
    const validated = validateConfig(parsed);

    // Expand environment variables
    const unresolved = new Set<string>();
    const expanded = expandEnvVarsInObject(validated, unresolved);

    if (unresolved.size > 0) {
      console.error(
        `[Config] WARNING: ${filePath} references environment variable(s) that are not set: ` +
          `${[...unresolved].join(', ')}. They were replaced with an empty string, which usually ` +
          `surfaces later as an authentication failure in the downstream server. Export them before ` +
          `starting your MCP client, or use \${VAR:-default} to supply a fallback.`
      );
    }

    return expanded;
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error(`Invalid JSON in ${filePath}: ${error.message}`);
    }
    throw error;
  }
}

/**
 * Get config file paths
 * User-level: ~/.mcp-compression-proxy/servers.json
 * Project-level: ./servers.json
 */
function getConfigPaths(): { user: string; project: string } {
  return {
    user: join(homedir(), '.mcp-compression-proxy', 'servers.json'),
    project: join(process.cwd(), 'servers.json'),
  };
}

/**
 * Convert wildcard pattern to regex
 * Supports * wildcard, case-insensitive
 */
function patternToRegex(pattern: string): RegExp {
  // Escape regex special chars except *
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
  // Convert * to .*
  const regexPattern = escaped.replace(/\*/g, '.*');
  // Case insensitive
  return new RegExp(`^${regexPattern}$`, 'i');
}

/**
 * Check if tool name matches any ignore pattern
 */
export function matchesIgnorePattern(toolName: string, patterns: string[]): boolean {
  if (!patterns || patterns.length === 0) {
    return false;
  }

  return patterns.some(pattern => {
    const regex = patternToRegex(pattern);
    return regex.test(toolName);
  });
}

export type ConfigResult = {
  servers: MCPServerConfig[];
  excludePatterns: string[];
  noCompressPatterns: string[];
  defaultTimeout?: number;
  cli?: {
    payloadThreshold?: number;
    autoStartDaemon?: boolean;
    daemonLogLevel?: string;
  };
  inheritEnv?: InheritEnv;
  compressionFallbackBehavior?: CompressionFallbackBehavior;
} | null;

/**
 * Load and aggregate server configuration from JSON files
 * 1. Load user-level config and collect patterns
 * 2. Load project-level config and append servers
 * 3. Aggregate exclude and noCompress patterns from both configs
 */
export function loadJSONServers(): ConfigResult {
  const paths = getConfigPaths();
  let aggregatedServers: MCPServerConfig[] = [];
  let aggregatedExcludePatterns: string[] = [];
  let aggregatedNoCompressPatterns: string[] = [];
  let defaultTimeout: number | undefined;
  let cliConfig: { payloadThreshold?: number; autoStartDaemon?: boolean; daemonLogLevel?: string } | undefined;
  let inheritEnv: InheritEnv | undefined;
  let compressionFallbackBehavior: CompressionFallbackBehavior = 'original';
  let hasAnyConfig = false;

  // Step 1: Load user-level config
  const userConfig = loadJSONConfig(paths.user);
  if (userConfig) {
    hasAnyConfig = true;
    console.error(`[Config] Loaded user-level configuration from: ${paths.user}`);
    console.error(`[Config] User config contains ${userConfig.mcpServers.length} servers`);

    aggregatedServers = [...userConfig.mcpServers];
    if (userConfig.excludeTools) {
      aggregatedExcludePatterns = [...userConfig.excludeTools];
    }
    if (userConfig.noCompressTools) {
      aggregatedNoCompressPatterns = [...userConfig.noCompressTools];
    }
    if (userConfig.defaultTimeout) {
      defaultTimeout = userConfig.defaultTimeout;
    }
    if (userConfig.cli) {
      cliConfig = { ...userConfig.cli };
    }
    if (userConfig.inheritEnv !== undefined) {
      inheritEnv = userConfig.inheritEnv;
    }
    if (userConfig.compressionFallbackBehavior) {
      compressionFallbackBehavior = userConfig.compressionFallbackBehavior;
    }
  } else {
    console.error(`[Config] No user-level config found at: ${paths.user}`);
  }

  // Step 2: Load project-level config and append
  const projectConfig = loadJSONConfig(paths.project);
  if (projectConfig) {
    hasAnyConfig = true;
    console.error(`[Config] Loaded project-level configuration from: ${paths.project}`);
    console.error(`[Config] Project config contains ${projectConfig.mcpServers.length} servers`);

    // Append project servers
    aggregatedServers = [...aggregatedServers, ...projectConfig.mcpServers];

    // Append project exclude patterns
    if (projectConfig.excludeTools) {
      aggregatedExcludePatterns = [...aggregatedExcludePatterns, ...projectConfig.excludeTools];
    }

    // Append project noCompress patterns
    if (projectConfig.noCompressTools) {
      aggregatedNoCompressPatterns = [...aggregatedNoCompressPatterns, ...projectConfig.noCompressTools];
    }

    // Project-level settings override user-level
    if (projectConfig.defaultTimeout) {
      defaultTimeout = projectConfig.defaultTimeout;
    }

    // Project-level CLI config overrides user-level
    if (projectConfig.cli) {
      cliConfig = { ...cliConfig, ...projectConfig.cli };
    }
    if (projectConfig.inheritEnv !== undefined) {
      inheritEnv = projectConfig.inheritEnv;
    }
    if (projectConfig.compressionFallbackBehavior) {
      compressionFallbackBehavior = projectConfig.compressionFallbackBehavior;
    }
  } else {
    console.error(`[Config] No project-level config found at: ${paths.project}`);
  }

  if (!hasAnyConfig) {
    return null;
  }

  // Log disabled servers
  const disabled = aggregatedServers.filter(s => s.enabled === false);
  if (disabled.length > 0) {
    console.error(`[Config] Found ${disabled.length} disabled server(s): ${disabled.map(s => s.name).join(', ')}`);
  }

  // Log exclude patterns
  if (aggregatedExcludePatterns.length > 0) {
    console.error(`[Config] Tool exclude patterns: ${aggregatedExcludePatterns.join(', ')}`);
  }

  // Log noCompress patterns
  if (aggregatedNoCompressPatterns.length > 0) {
    console.error(`[Config] Tool noCompress patterns: ${aggregatedNoCompressPatterns.join(', ')}`);
  }

  // Log default timeout
  if (defaultTimeout) {
    console.error(`[Config] Default timeout: ${defaultTimeout} seconds`);
  }

  // Log environment inheritance policy when it deviates from the default
  if (inheritEnv !== undefined && inheritEnv !== true) {
    console.error(
      `[Config] Environment inheritance: ${
        inheritEnv === false ? 'safe defaults only' : `allowlist (${inheritEnv.join(', ')})`
      }`
    );
  }

  // Log fallback behavior when it deviates from the default
  if (compressionFallbackBehavior !== 'original') {
    console.error(`[Config] Compression fallback behavior: ${compressionFallbackBehavior}`);
  }

  console.error(`[Config] Total servers after aggregation: ${aggregatedServers.length}`);

  return {
    servers: aggregatedServers,
    excludePatterns: aggregatedExcludePatterns,
    noCompressPatterns: aggregatedNoCompressPatterns,
    defaultTimeout,
    cli: cliConfig,
    inheritEnv,
    compressionFallbackBehavior,
  };
}

/**
 * Fingerprint of the config files, used to detect edits between reads.
 * Missing files are part of the fingerprint so creating one invalidates too.
 */
function configSignature(): string {
  const paths = getConfigPaths();

  return [paths.user, paths.project]
    .map((path) => {
      try {
        const stat = statSync(path);
        return `${path}:${stat.mtimeMs}:${stat.size}`;
      } catch {
        return `${path}:missing`;
      }
    })
    .join('|');
}

let configCache: { signature: string; result: ConfigResult } | null = null;

/**
 * Cached wrapper around {@link loadJSONServers}.
 *
 * `tools/list` runs on every client refresh, and re-reading, re-validating and
 * re-logging both config files each time is pure overhead. The cache is keyed
 * on file mtime/size, so edits are still picked up without a restart.
 */
export function loadJSONServersCached(): ConfigResult {
  const signature = configSignature();

  if (configCache && configCache.signature === signature) {
    return configCache.result;
  }

  const result = loadJSONServers();
  configCache = { signature, result };
  return result;
}

/**
 * Drop the cached config. Primarily for tests that swap config files
 * within a single process.
 */
export function clearConfigCache(): void {
  configCache = null;
}

/**
 * Get the path that would be used for config
 * (for migration script purposes)
 */
export function getConfigPath(): string {
  return join(homedir(), '.mcp-compression-proxy', 'servers.json');
}

/**
 * Get the daemon Unix socket path
 */
export function getSocketPath(): string {
  return join(homedir(), '.mcp-compression-proxy', 'daemon.sock');
}

/**
 * Get the daemon PID file path
 */
export function getPidFilePath(): string {
  return join(homedir(), '.mcp-compression-proxy', 'daemon.pid');
}
