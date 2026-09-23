import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { Logger } from 'pino';
import { MCPClientManager } from '../../src/mcp/client-manager.js';
import { callToolWithAuthRecovery, ToolExcludedError } from '../../src/mcp/tool-call-executor.js';

jest.mock('@modelcontextprotocol/sdk/client/index.js');
jest.mock('@modelcontextprotocol/sdk/client/stdio.js');

describe('callToolWithAuthRecovery', () => {
  let manager: MCPClientManager;
  let logger: Logger;

  beforeEach(() => {
    jest.clearAllMocks();
    logger = {
      debug: jest.fn(),
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    } as unknown as Logger;
    manager = new MCPClientManager(logger);
  });

  async function initializeWithClients(clients: Array<jest.Mocked<Client>>): Promise<void> {
    const { Client: ClientCtor } = await import('@modelcontextprotocol/sdk/client/index.js');
    let index = 0;
    (ClientCtor as unknown as jest.Mock).mockImplementation(() => clients[index++]);

    await manager.initializeServers([
      {
        name: 'builder-mcp',
        command: 'builder-mcp',
        softMaxConnectionAgeSeconds: 0,
        hardMaxConnectionAgeSeconds: 0,
        authErrorPatterns: [
          'received midway login page',
          "authentication failed. please run 'mwinit'",
        ],
        authRetryTools: ['InternalSearch'],
      },
    ]);
  }

  function clientWithCall(
    callTool: jest.MockedFunction<Client['callTool']>
  ): jest.Mocked<Client> {
    return {
      connect: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
      close: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
      callTool,
      listTools: jest.fn<Client['listTools']>(),
    } as unknown as jest.Mocked<Client>;
  }

  it('invalidates and retries a configured read-only tool after an auth result', async () => {
    const stale = clientWithCall(
      jest.fn<Client['callTool']>().mockResolvedValue({
        content: [{
          type: 'text',
          text: '{"error":"Received Midway login page instead of expected response"}',
        }],
      })
    );
    const fresh = clientWithCall(
      jest.fn<Client['callTool']>().mockResolvedValue({
        content: [{ type: 'text', text: 'search result' }],
      })
    );
    await initializeWithClients([stale, fresh]);

    const result = await callToolWithAuthRecovery(
      manager,
      logger,
      'builder-mcp',
      'InternalSearch',
      { query: 'test' }
    );

    expect(result.content).toEqual([{ type: 'text', text: 'search result' }]);
    expect(stale.close).toHaveBeenCalledTimes(1);
    expect(stale.callTool).toHaveBeenCalledTimes(1);
    expect(fresh.callTool).toHaveBeenCalledTimes(1);
    expect(manager.getServerStatuses()[0].authInvalidations).toBe(1);
  });

  it('invalidates but does not replay a tool that is not configured as read-only', async () => {
    const stale = clientWithCall(
      jest.fn<Client['callTool']>().mockResolvedValue({
        content: [{
          type: 'text',
          text: "Authentication failed. Please run 'mwinit' to refresh your credentials.",
        }],
      })
    );
    await initializeWithClients([stale]);

    const result = await callToolWithAuthRecovery(
      manager,
      logger,
      'builder-mcp',
      'TaskeiCreateTask',
      { name: 'do not replay' }
    );

    expect(result.content[0]).toEqual(expect.objectContaining({
      type: 'text',
      text: expect.stringContaining('Authentication failed'),
    }));
    expect(stale.callTool).toHaveBeenCalledTimes(1);
    expect(stale.close).toHaveBeenCalledTimes(1);
  });

  it('retries a configured read-only tool when the first call throws an auth error', async () => {
    const stale = clientWithCall(
      jest.fn<Client['callTool']>().mockRejectedValue(
        new Error("Authentication failed. Please run 'mwinit'")
      )
    );
    const fresh = clientWithCall(
      jest.fn<Client['callTool']>().mockResolvedValue({
        content: [{ type: 'text', text: 'recovered' }],
      })
    );
    await initializeWithClients([stale, fresh]);

    const result = await callToolWithAuthRecovery(
      manager,
      logger,
      'builder-mcp',
      'InternalSearch',
      { query: 'test' }
    );

    expect(result.content).toEqual([{ type: 'text', text: 'recovered' }]);
    expect(stale.close).toHaveBeenCalledTimes(1);
    expect(fresh.callTool).toHaveBeenCalledTimes(1);
  });

  it('retries at most once and leaves a second auth failure invalidated', async () => {
    const authResult = {
      content: [{
        type: 'text' as const,
        text: '{"error":"Received Midway login page instead of expected response"}',
      }],
    };
    const stale = clientWithCall(
      jest.fn<Client['callTool']>().mockResolvedValue(authResult)
    );
    const stillStale = clientWithCall(
      jest.fn<Client['callTool']>().mockResolvedValue(authResult)
    );
    await initializeWithClients([stale, stillStale]);

    const result = await callToolWithAuthRecovery(
      manager,
      logger,
      'builder-mcp',
      'InternalSearch',
      { query: 'test' }
    );

    expect(result).toEqual(authResult);
    expect(stale.callTool).toHaveBeenCalledTimes(1);
    expect(stillStale.callTool).toHaveBeenCalledTimes(1);
    expect(manager.getServerStatuses()[0].authInvalidations).toBe(2);
  });

  it('records a normal tool error without recycling the connection', async () => {
    const client = clientWithCall(
      jest.fn<Client['callTool']>().mockResolvedValue({
        content: [{ type: 'text', text: 'validation failed' }],
        isError: true,
      })
    );
    await initializeWithClients([client]);

    const result = await callToolWithAuthRecovery(
      manager,
      logger,
      'builder-mcp',
      'InternalSearch',
      { query: 'test' }
    );

    expect(result.isError).toBe(true);
    expect(client.close).not.toHaveBeenCalled();
    expect(manager.getServerStatuses()[0].consecutiveFailures).toBe(1);
  });

  it('refuses a tool matched by excludeTools without calling the backend', async () => {
    const callTool = jest.fn<Client['callTool']>();
    await initializeWithClients([clientWithCall(callTool)]);
    manager.setExcludePatterns(['builder-mcp__Internal*']);

    await expect(
      callToolWithAuthRecovery(manager, logger, 'builder-mcp', 'InternalSearch', {})
    ).rejects.toBeInstanceOf(ToolExcludedError);
    await expect(
      callToolWithAuthRecovery(manager, logger, 'builder-mcp', 'InternalSearch', {})
    ).rejects.toThrow("Tool 'builder-mcp__InternalSearch' is excluded");
    expect(callTool).not.toHaveBeenCalled();
  });

  describe('auth failure confirmation', () => {
    const quoted = `Wiki page. ${'Background. '.repeat(200)}If you see "Received Midway login page" run mwinit.`;

    function contentClient() {
      return clientWithCall(
        jest.fn<Client['callTool']>().mockResolvedValue({
          content: [{ type: 'text', text: quoted }],
        })
      );
    }

    it('keeps the connection when the confirmer says a long result is only content', async () => {
      const client = contentClient();
      await initializeWithClients([client]);
      const confirmer = jest.fn(async (_text: string) => false);
      manager.setAuthFailureConfirmer(confirmer);

      const result = await callToolWithAuthRecovery(manager, logger, 'builder-mcp', 'InternalSearch', {});

      expect(confirmer).toHaveBeenCalledWith(quoted);
      expect(result.content).toEqual([{ type: 'text', text: quoted }]);
      expect(client.callTool).toHaveBeenCalledTimes(1);
      expect(manager.getServerStatuses()[0].authInvalidations ?? 0).toBe(0);
      expect(manager.getAuthFailureConfirmer()).toBe(confirmer);
    });

    it('reads only the text parts of a result for the confirmer', async () => {
      const client = clientWithCall(
        jest.fn<Client['callTool']>().mockResolvedValue({
          content: [
            { type: 'image', data: 'AAAA', mimeType: 'image/png' },
            { type: 'text', text: quoted },
          ],
        })
      );
      await initializeWithClients([client]);
      const confirmer = jest.fn(async (_text: string) => false);
      manager.setAuthFailureConfirmer(confirmer);

      await callToolWithAuthRecovery(manager, logger, 'builder-mcp', 'InternalSearch', {});

      expect(confirmer).toHaveBeenCalledWith(quoted);
    });

    it('lets the pattern stand when the confirmer fails', async () => {
      await initializeWithClients([contentClient(), contentClient(), contentClient()]);
      manager.setAuthFailureConfirmer(async () => {
        throw new Error('model down');
      });

      await callToolWithAuthRecovery(manager, logger, 'builder-mcp', 'InternalSearch', {});

      expect(manager.getServerStatuses()[0].authInvalidations).toBeGreaterThan(0);
    });

    it('does not consult the confirmer for short results', async () => {
      const stale = clientWithCall(
        jest.fn<Client['callTool']>().mockResolvedValue({
          content: [{ type: 'text', text: '{"error":"Received Midway login page"}' }],
        })
      );
      const fresh = clientWithCall(
        jest.fn<Client['callTool']>().mockResolvedValue({ content: [{ type: 'text', text: 'ok' }] })
      );
      await initializeWithClients([stale, fresh]);
      const confirmer = jest.fn(async (_text: string) => false);
      manager.setAuthFailureConfirmer(confirmer);

      const result = await callToolWithAuthRecovery(manager, logger, 'builder-mcp', 'InternalSearch', {});

      expect(confirmer).not.toHaveBeenCalled();
      expect(result.content).toEqual([{ type: 'text', text: 'ok' }]);
    });
  });
});
