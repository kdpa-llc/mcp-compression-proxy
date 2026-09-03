import { existsSync } from 'fs';
import { join } from 'path';

export function isManagedRouterConfigured(baseDir: string): boolean {
  return existsSync(join(baseDir, 'active-release.json'));
}

export function managedRouterUnavailableMessage(env: NodeJS.ProcessEnv = process.env): string {
  if (env.CODEX_SANDBOX_NETWORK_DISABLED === '1') {
    return 'The managed MCP router may be healthy outside this restricted Codex shell. Retry the same mcp-cli command with host/elevated execution (sandbox_permissions=require_escalated); do not run mcp-cli daemon start.';
  }
  return 'The managed MCP router is not reachable. Run mcp-proxy-upgrade status, then restart the router owner only if host execution also fails.';
}
