import type { MCPServerConfig } from '../types/index.js';

/**
 * Configuration for MCP servers to aggregate
 * Add or modify servers here to customize your setup
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
 */
export function getEnabledServers(): MCPServerConfig[] {
  return mcpServers.filter(server => server.enabled !== false);
}
