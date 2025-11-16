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
        return `  - ${path}: ${err.message}`;
      })
      .join('\n');
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
 * Get config file paths in priority order
 * 1. ./servers.json (project-level)
 * 2. ~/.mcp-aggregator/servers.json (user-level)
 */
function getConfigPaths(): string[] {
  return [
    join(process.cwd(), 'servers.json'),
    join(homedir(), '.mcp-aggregator', 'servers.json'),
  ];
}

/**
 * Load server configuration from JSON files
 * Checks project-level first, then falls back to user-level
 */
export function loadJSONServers(): MCPServerConfig[] | null {
  const paths = getConfigPaths();

  for (const path of paths) {
    const config = loadJSONConfig(path);
    if (config) {
      // Log disabled servers
      const disabled = config.mcpServers.filter(s => s.enabled === false);
      if (disabled.length > 0) {
        console.warn(`[Config] Found ${disabled.length} disabled server(s): ${disabled.map(s => s.name).join(', ')}`);
      }

      console.log(`[Config] Loaded configuration from: ${path}`);
      return config.mcpServers;
    }
  }

  return null;
}

/**
 * Get the path that would be used for config
 * (for migration script purposes)
 */
export function getConfigPath(): string {
  return join(homedir(), '.mcp-aggregator', 'servers.json');
}
