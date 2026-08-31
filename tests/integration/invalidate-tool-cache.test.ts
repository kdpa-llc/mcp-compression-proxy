/**
 * Per-tool cache invalidation.
 *
 * Before this the only lever was clear_compressed_tools_cache, which wipes
 * everything - there was no way to redo a single bad compression.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { tmpdir } from 'os';
import { join } from 'path';
import { mkdirSync, writeFileSync, rmSync } from 'fs';

describe('invalidate_tool_cache', () => {
  let mcpClient: Client;
  let transport: StdioClientTransport;
  let testHome: string;
  let originalHome: string | undefined;

  function textOf(result: unknown): string {
    const content = (result as { content?: Array<{ type: string; text?: string }> }).content;
    return (content ?? [])
      .filter((part) => part.type === 'text')
      .map((part) => part.text ?? '')
      .join('\n');
  }

  beforeAll(async () => {
    testHome = join(tmpdir(), `mcp-invalidate-test-${Date.now()}`);
    const configDir = join(testHome, '.mcp-compression-proxy');
    mkdirSync(configDir, { recursive: true });

    writeFileSync(
      join(configDir, 'servers.json'),
      JSON.stringify(
        {
          mcpServers: [
            {
              name: 'multi',
              command: 'node',
              args: [join(process.cwd(), 'tests/__mocks__/multi-tool-server.js')],
              enabled: true,
            },
          ],
          excludeTools: ['multi__tool_002'],
        },
        null,
        2
      )
    );

    originalHome = process.env.HOME;
    process.env.HOME = testHome;

    transport = new StdioClientTransport({
      command: 'node',
      args: [join(process.cwd(), 'dist/index.js')],
      env: { ...process.env, HOME: testHome, MOCK_TOOL_COUNT: '3', LOG_LEVEL: 'error' },
    });

    mcpClient = new Client({ name: 'invalidate-test-client', version: '1.0.0' }, { capabilities: {} });
    await mcpClient.connect(transport);
  }, 20000);

  afterAll(async () => {
    if (originalHome !== undefined) {
      process.env.HOME = originalHome;
    }
    if (mcpClient) {
      await mcpClient.close();
    }
    try {
      rmSync(testHome, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  it('returns a tool to the compression queue', async () => {
    await mcpClient.callTool({
      name: 'mcp-compression-proxy__cache_compressed_tools',
      arguments: {
        descriptions: [
          { serverName: 'multi', toolName: 'tool_000', description: 'Compressed 000' },
          { serverName: 'multi', toolName: 'tool_001', description: 'Compressed 001' },
        ],
      },
    });

    const before = await mcpClient.callTool({
      name: 'mcp-compression-proxy__get_uncompressed_tools',
      arguments: { limit: 100 },
    });
    expect(textOf(before)).toContain('Found 0 tools without compressed descriptions');

    const invalidated = await mcpClient.callTool({
      name: 'mcp-compression-proxy__invalidate_tool_cache',
      arguments: { serverName: 'multi', toolName: 'tool_000' },
    });
    expect(textOf(invalidated)).toContain('Invalidated the cached compression');

    const after = await mcpClient.callTool({
      name: 'mcp-compression-proxy__get_uncompressed_tools',
      arguments: { limit: 100 },
    });

    // Only the invalidated one comes back; its sibling stays compressed.
    expect(textOf(after)).toContain('Found 1 tools without compressed descriptions');
    expect(textOf(after)).toContain('tool_000');
    expect(textOf(after)).not.toContain('tool_001');
  });

  it('reports when there was nothing cached to invalidate', async () => {
    const result = await mcpClient.callTool({
      name: 'mcp-compression-proxy__invalidate_tool_cache',
      arguments: { serverName: 'multi', toolName: 'never_compressed' },
    });

    expect(textOf(result)).toContain('No cached compression found');
  });

  it('never surfaces an excluded tool, compressed or not', async () => {
    // Cross-step guard: exclusion is applied before staleness is ever
    // consulted, so an excluded tool cannot re-enter the queue by going stale.
    const result = await mcpClient.callTool({
      name: 'mcp-compression-proxy__get_uncompressed_tools',
      arguments: { limit: 100 },
    });

    expect(textOf(result)).not.toContain('tool_002');

    const { tools } = await mcpClient.listTools();
    expect(tools.map((tool) => tool.name)).not.toContain('multi__tool_002');
  });
});
