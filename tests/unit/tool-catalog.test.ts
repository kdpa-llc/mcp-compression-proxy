import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { Logger } from 'pino';
import { MCPClientManager } from '../../src/mcp/client-manager.js';
import {
  listAllTools,
  MAX_TOOL_LIST_PAGES,
  ToolCatalog,
} from '../../src/mcp/tool-catalog.js';

jest.mock('@modelcontextprotocol/sdk/client/index.js');
jest.mock('@modelcontextprotocol/sdk/client/stdio.js');

type ListTools = Client['listTools'];

function tool(name: string, extra: Record<string, unknown> = {}) {
  return { name, description: `${name} description`, inputSchema: { type: 'object' as const }, ...extra };
}

describe('listAllTools', () => {
  it('returns a single page as is', async () => {
    const listTools = jest.fn<ListTools>().mockResolvedValue({ tools: [tool('a')] });
    const tools = await listAllTools({ listTools });
    expect(tools.map((t) => t.name)).toEqual(['a']);
    expect(listTools).toHaveBeenCalledTimes(1);
    expect(listTools).toHaveBeenCalledWith();
  });

  it('follows cursors until the backend stops returning one', async () => {
    const listTools = jest
      .fn<ListTools>()
      .mockResolvedValueOnce({ tools: [tool('a')], nextCursor: 'p2' })
      .mockResolvedValueOnce({ tools: [tool('b')], nextCursor: 'p3' })
      .mockResolvedValueOnce({ tools: [tool('c')] });

    const tools = await listAllTools({ listTools });

    expect(tools.map((t) => t.name)).toEqual(['a', 'b', 'c']);
    expect(listTools).toHaveBeenNthCalledWith(2, { cursor: 'p2' });
    expect(listTools).toHaveBeenNthCalledWith(3, { cursor: 'p3' });
  });

  it('stops on a repeated cursor instead of looping', async () => {
    const listTools = jest
      .fn<ListTools>()
      .mockResolvedValue({ tools: [tool('a')], nextCursor: 'same' });

    const tools = await listAllTools({ listTools });

    expect(listTools).toHaveBeenCalledTimes(2);
    expect(tools).toHaveLength(2);
  });

  it('stops at the page cap', async () => {
    let page = 0;
    const listTools = jest.fn<ListTools>().mockImplementation(async () => ({
      tools: [tool(`t${page}`)],
      nextCursor: `c${++page}`,
    }));

    const tools = await listAllTools({ listTools }, 3);

    expect(tools).toHaveLength(3);
    expect(MAX_TOOL_LIST_PAGES).toBeGreaterThan(3);
  });
});

describe('ToolCatalog', () => {
  let manager: MCPClientManager;
  let logger: Logger;
  let listA: jest.MockedFunction<ListTools>;
  let listB: jest.MockedFunction<ListTools>;

  beforeEach(async () => {
    jest.clearAllMocks();
    logger = {
      debug: jest.fn(),
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    } as unknown as Logger;
    manager = new MCPClientManager(logger);

    listA = jest.fn<ListTools>().mockResolvedValue({
      tools: [
        tool('read', { title: 'Read', annotations: { readOnlyHint: true } }),
        tool('delete_all'),
      ],
    });
    listB = jest.fn<ListTools>().mockResolvedValue({ tools: [tool('send')] });

    const clients = [listA, listB].map(
      (listTools) =>
        ({
          connect: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
          close: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
          listTools,
        }) as unknown as jest.Mocked<Client>
    );
    const { Client: ClientCtor } = await import('@modelcontextprotocol/sdk/client/index.js');
    let index = 0;
    (ClientCtor as unknown as jest.Mock).mockImplementation(() => clients[index++]);

    await manager.initializeServers([
      { name: 'a', command: 'a', softMaxConnectionAgeSeconds: 0, hardMaxConnectionAgeSeconds: 0 },
      { name: 'b', command: 'b', softMaxConnectionAgeSeconds: 0, hardMaxConnectionAgeSeconds: 0 },
    ]);
  });

  it('lists every backend and keeps title and annotations', async () => {
    const catalog = new ToolCatalog(manager, logger);
    const tools = await catalog.list();

    expect(tools.map((t) => `${t.serverName}/${t.toolName}`).sort()).toEqual([
      'a/delete_all',
      'a/read',
      'b/send',
    ]);
    const read = tools.find((t) => t.toolName === 'read');
    expect(read?.title).toBe('Read');
    expect(read?.annotations).toEqual({ readOnlyHint: true });
    expect(tools.find((t) => t.toolName === 'send')).not.toHaveProperty('title');
  });

  it('drops excluded tools', async () => {
    manager.setExcludePatterns(['*__delete_*']);
    const catalog = new ToolCatalog(manager, logger);

    const names = (await catalog.list()).map((t) => t.toolName);

    expect(names).not.toContain('delete_all');
    expect(await catalog.find('a', 'delete_all')).toBeUndefined();
  });

  it('serves a snapshot until it expires, and re-lists when exclusions change', async () => {
    const catalog = new ToolCatalog(manager, logger, 60_000);

    await catalog.list();
    await catalog.list();
    expect(listA).toHaveBeenCalledTimes(1);

    manager.setExcludePatterns(['a__read']);
    const names = (await catalog.list()).map((t) => t.toolName);
    expect(listA).toHaveBeenCalledTimes(2);
    expect(names).not.toContain('read');

    catalog.invalidate();
    await catalog.list();
    expect(listA).toHaveBeenCalledTimes(3);
  });

  it('shares one fan-out between concurrent callers', async () => {
    const catalog = new ToolCatalog(manager, logger);

    await Promise.all([catalog.list(), catalog.list(), catalog.list()]);

    expect(listA).toHaveBeenCalledTimes(1);
    expect(listB).toHaveBeenCalledTimes(1);
  });

  it('skips a backend that fails to list, but surfaces the failure on a direct lookup', async () => {
    listB.mockRejectedValue(new Error('backend down'));
    const catalog = new ToolCatalog(manager, logger);

    const names = (await catalog.list()).map((t) => t.toolName);
    expect(names).toEqual(['read', 'delete_all']);
    expect(logger.error).toHaveBeenCalled();

    await expect(catalog.find('b', 'send')).rejects.toThrow('backend down');
  });

  it('finds a tool, and reports unknown servers and tools as missing', async () => {
    const catalog = new ToolCatalog(manager, logger);

    expect((await catalog.find('b', 'send'))?.description).toBe('send description');
    expect(await catalog.find('b', 'nope')).toBeUndefined();
    expect(await catalog.find('zzz', 'send')).toBeUndefined();
  });
});
