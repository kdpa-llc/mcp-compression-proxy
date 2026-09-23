import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { Logger } from 'pino';
import type { BackendAccess } from './backend-access.js';

/**
 * Upper bound on `tools/list` pages read from one backend. A server that
 * keeps handing out fresh cursors would otherwise hold a listing open forever.
 */
export const MAX_TOOL_LIST_PAGES = 100;

/**
 * Read every page of a backend's `tools/list`.
 *
 * `client.listTools()` returns one page. A backend that paginates would
 * otherwise lose every tool after its first page, silently: nothing errors,
 * the tools are just never listed, searched or compressed.
 */
export async function listAllTools(
  client: Pick<Client, 'listTools'>,
  maxPages = MAX_TOOL_LIST_PAGES
): Promise<Tool[]> {
  const tools: Tool[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | undefined;

  for (let page = 0; page < maxPages; page++) {
    const result =
      cursor === undefined ? await client.listTools() : await client.listTools({ cursor });
    tools.push(...result.tools);

    const next = result.nextCursor;
    // A repeated cursor is a loop, not another page.
    if (!next || seenCursors.has(next)) {
      return tools;
    }
    seenCursors.add(next);
    cursor = next;
  }

  return tools;
}

/** A backend tool, with the metadata the proxy forwards or reasons about. */
export interface CatalogTool {
  serverName: string;
  toolName: string;
  description?: string;
  inputSchema: Tool['inputSchema'];
  title?: string;
  annotations?: Tool['annotations'];
}

function toCatalogTool(serverName: string, tool: Tool): CatalogTool {
  return {
    serverName,
    toolName: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
    ...(tool.title !== undefined ? { title: tool.title } : {}),
    ...(tool.annotations !== undefined ? { annotations: tool.annotations } : {}),
  };
}

/**
 * The combined, exclusion-filtered tool list of every backend.
 *
 * One snapshot shared by listing, search, compression and stats, so they all
 * agree on which tools exist. Backends are listed in parallel: a sequential
 * walk makes every search as slow as the sum of all servers.
 */
export class ToolCatalog {
  private cache: { expiresAt: number; key: string; tools: CatalogTool[] } | undefined;
  private inflight: { key: string; promise: Promise<CatalogTool[]> } | undefined;

  constructor(
    private readonly manager: BackendAccess,
    private readonly logger: Logger,
    private readonly ttlMs = 3000
  ) {}

  /**
   * Keyed on the connected set and the exclude patterns as well as the clock.
   * Hot-reload can add or drop a backend between ticks and an edited
   * servers.json can change what is filtered; serving either from a stale
   * snapshot would contradict what the caller is about to act on.
   */
  private cacheKey(): string {
    return JSON.stringify([
      this.manager.getExcludePatterns(),
      [...this.manager.getConfiguredServerNames()].sort(),
    ]);
  }

  /** Every non-excluded tool. A backend that fails to list contributes none. */
  async list(): Promise<CatalogTool[]> {
    const key = this.cacheKey();

    if (this.cache && this.cache.expiresAt > Date.now() && this.cache.key === key) {
      return this.cache.tools;
    }

    // Concurrent callers share one fan-out instead of each listing every
    // backend.
    if (this.inflight && this.inflight.key === key) {
      return this.inflight.promise;
    }

    const promise = this.fetchAll().then((tools) => {
      this.cache = { expiresAt: Date.now() + this.ttlMs, key, tools };
      return tools;
    });
    this.inflight = { key, promise };

    try {
      return await promise;
    } finally {
      if (this.inflight?.promise === promise) {
        this.inflight = undefined;
      }
    }
  }

  private async fetchAll(): Promise<CatalogTool[]> {
    const perServer = await Promise.all(
      this.manager.getConfiguredServerNames().map(async (name) => {
        try {
          return await this.listServer(name);
        } catch (error) {
          this.logger.error({ server: name, error }, 'Failed to list tools from server');
          return [];
        }
      })
    );
    return perServer.flat();
  }

  /** One backend's non-excluded tools. Throws when the backend cannot list. */
  async listServer(serverName: string): Promise<CatalogTool[]> {
    const tools = await this.manager.withClient(serverName, async ({ client }) =>
      listAllTools(client)
    );
    return tools
      .filter((tool) => !this.manager.isToolExcluded(serverName, tool.name))
      .map((tool) => toCatalogTool(serverName, tool));
  }

  /**
   * One tool, or undefined when it does not exist or is excluded - an excluded
   * tool is indistinguishable from a missing one on purpose.
   */
  async find(serverName: string, toolName: string): Promise<CatalogTool | undefined> {
    if (this.manager.isToolExcluded(serverName, toolName)) {
      return undefined;
    }
    const tools = await this.list();
    const cached = tools.find(
      (tool) => tool.serverName === serverName && tool.toolName === toolName
    );
    if (cached) {
      return cached;
    }
    // Not in the snapshot: the server may have failed to list during the
    // fan-out, so ask it directly and let a real failure surface.
    if (!this.manager.getConfiguredServerNames().includes(serverName)) {
      return undefined;
    }
    const direct = await this.listServer(serverName);
    return direct.find((tool) => tool.toolName === toolName);
  }

  /** Drop the snapshot so the next read lists every backend again. */
  invalidate(): void {
    this.cache = undefined;
  }
}
