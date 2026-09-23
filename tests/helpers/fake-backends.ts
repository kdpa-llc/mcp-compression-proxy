import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js';
import { matchesIgnorePattern } from '../../src/config/loader.js';
import type { BackendAccess } from '../../src/mcp/backend-access.js';
import type { AuthFailureConfirmer } from '../../src/mcp/client-manager.js';

export type FakeResponder = (
  server: string,
  tool: string,
  args: Record<string, unknown>
) => CallToolResult | Promise<CallToolResult>;

/**
 * In-memory backends for exercising a proxy session without processes: each
 * server lists the given tools and answers calls through `respond`.
 */
export function fakeBackends(
  servers: Record<string, Tool[]>,
  options: { exclude?: string[]; respond?: FakeResponder; confirmer?: AuthFailureConfirmer } = {}
): BackendAccess & { calls: Array<{ server: string; tool: string; args: Record<string, unknown> }> } {
  const calls: Array<{ server: string; tool: string; args: Record<string, unknown> }> = [];
  const exclude = options.exclude ?? [];
  const respond: FakeResponder =
    options.respond ?? ((server, tool) => ({ content: [{ type: 'text', text: `ran ${server}/${tool}` }] }));

  return {
    calls,
    getConfiguredServerNames: () => Object.keys(servers),
    async withClient(serverName, operation) {
      const tools = servers[serverName];
      if (!tools) throw new Error(`Server '${serverName}' is not configured`);
      const client = {
        listTools: async () => ({ tools }),
        callTool: async ({ name, arguments: args }: { name: string; arguments?: Record<string, unknown> }) => {
          calls.push({ server: serverName, tool: name, args: args ?? {} });
          return respond(serverName, name, args ?? {});
        },
      } as unknown as Client;
      return operation({ client, generation: 1, markFailure: () => undefined, invalidate: () => undefined });
    },
    isToolExcluded: (server, tool) => matchesIgnorePattern(`${server}__${tool}`, exclude),
    getExcludePatterns: () => [...exclude],
    getAuthRecoveryPolicy: () => ({ authErrorPatterns: [], authRetryTools: [] }),
    getAuthFailureConfirmer: () => options.confirmer,
    getServerStatuses: () => Object.keys(servers).map((name) => ({ name, connected: true, state: 'ready' as const })),
  };
}

export function tool(name: string, description?: string, extra: Partial<Tool> = {}): Tool {
  return {
    name,
    ...(description !== undefined ? { description } : {}),
    inputSchema: { type: 'object', properties: { path: { type: 'string', description: 'A path' } } },
    ...extra,
  };
}
