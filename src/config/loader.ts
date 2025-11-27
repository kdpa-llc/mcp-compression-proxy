import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir as osHomedir } from 'os';
import type { MCPServerConfig } from '../types/index.js';
import { serverConfigSchema, type ServerConfigJSON } from './schema.js';
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
 * Expands environment variables in a string
 * Supports ${VAR_NAME} syntax
 */
function expandEnvVars(value: string): string {
  return value.replace(/\$\{([^}]+)\}/g, (_, varName) => {
    return process.env[varName] || '';
  });
}

/**
 * Recursively expands environment variables in an object
 */
function expandEnvVarsInObject(obj: any): any {
  if (typeof obj === 'string') {
    return expandEnvVars(obj);
  }
  if (Array.isArray(obj)) {
    return obj.map(expandEnvVarsInObject);
  }
  if (obj !== null && typeof obj === 'object') {
    const result: any = {};
    for (const [key, value] of Object.entries(obj)) {
      result[key] = expandEnvVarsInObject(value);
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
    const expanded = expandEnvVarsInObject(validated);

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
  compressionFallbackBehavior: 'original' | 'blank';
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
  let compressionFallbackBehavior: 'original' | 'blank' = 'original';
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

    // Project-level defaultTimeout overrides user-level
    if (projectConfig.defaultTimeout) {
      defaultTimeout = projectConfig.defaultTimeout;
    }

    // Project-level compressionFallbackBehavior overrides user-level
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

  // Log fallback behavior
  if (compressionFallbackBehavior !== 'original') {
    console.error(`[Config] Compression fallback behavior: ${compressionFallbackBehavior}`);
  }

  console.error(`[Config] Total servers after aggregation: ${aggregatedServers.length}`);

  return {
    servers: aggregatedServers,
    excludePatterns: aggregatedExcludePatterns,
    noCompressPatterns: aggregatedNoCompressPatterns,
    defaultTimeout,
    compressionFallbackBehavior,
  };
}

/**
 * Get the path that would be used for config
 * (for migration script purposes)
 */
export function getConfigPath(): string {
  return join(homedir(), '.mcp-compression-proxy', 'servers.json');
}
