import type { MCPServerConfig } from '../types/index.js';
import { loadJSONServers } from './loader.js';

/**
 * Configuration for MCP servers to aggregate
 * @deprecated Use JSON configuration files instead:
 *   - Project-level: ./servers.json
 *   - User-level: ~/.mcp-aggregator/servers.json
 * This TypeScript configuration is maintained for backward compatibility only.
 */
export const mcpServers: MCPServerConfig[] = [
  {
    name: 'filesystem',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-filesystem', '/tmp'],
    enabled: true,
  },
  // Example: Add more servers here
  // {
  //   name: 'github',
  //   command: 'npx',
  //   args: ['-y', '@modelcontextprotocol/server-github'],
  //   env: {
  //     GITHUB_PERSONAL_ACCESS_TOKEN: process.env.GITHUB_TOKEN || '',
  //   },
  //   enabled: false,
  // },
];

/**
 * Filter and return only enabled servers
 * Checks for JSON config first, falls back to TypeScript config
 */
export function getEnabledServers(): MCPServerConfig[] {
  // Try to load from JSON config first
  const jsonServers = loadJSONServers();

  if (jsonServers !== null) {
    // JSON config found, use it
    return jsonServers.filter(server => server.enabled !== false);
  }

  // Fall back to TypeScript config with deprecation warning
  console.warn('[Config] Using deprecated TypeScript configuration. Please migrate to JSON config using the migration script.');
  console.warn('[Config] Run: npm run migrate-config');

  return mcpServers.filter(server => server.enabled !== false);
}
