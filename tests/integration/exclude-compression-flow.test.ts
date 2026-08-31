/**
 * excludeTools must apply to the compression flow, not just the tool listing.
 *
 * Excluding a tool used to hide it from tools/list while still offering it to
 * get_uncompressed_tools, so an agent spent LLM calls compressing something the
 * client would never see, and the coverage percentages counted tools that were
 * not actually being served.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { tmpdir } from 'os';
import { join } from 'path';
import { mkdirSync, writeFileSync, rmSync } from 'fs';

describe('excludeTools in the compression flow', () => {
  let mcpClient: Client;
  let transport: StdioClientTransport;
  let testHome: string;
  let originalHome: string | undefined;

  /** Text payload of the first content block of a tool result. */
  function textOf(result: unknown): string {
    const content = (result as { content?: Array<{ type: string; text?: string }> }).content;
    return (content ?? [])
      .filter((part) => part.type === 'text')
      .map((part) => part.text ?? '')
      .join('\n');
  }

  beforeAll(async () => {
    testHome = join(tmpdir(), `mcp-exclude-test-${Date.now()}`);
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
          // Drops tool_000 and leaves tool_001 / tool_002 untouched.
          excludeTools: ['multi__tool_000'],
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

    mcpClient = new Client({ name: 'exclude-test-client', version: '1.0.0' }, { capabilities: {} });
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

  it('hides an excluded tool from tools/list but keeps its siblings', async () => {
    const { tools } = await mcpClient.listTools();
    const names = tools.map((tool) => tool.name);

    expect(names).not.toContain('multi__tool_000');
    expect(names).toContain('multi__tool_001');
    expect(names).toContain('multi__tool_002');
  });

  it('never offers an excluded tool for compression', async () => {
    const result = await mcpClient.callTool({
      name: 'mcp-compression-proxy__get_uncompressed_tools',
      arguments: { limit: 100 },
    });

    const text = textOf(result);

    expect(text).not.toContain('tool_000');
    expect(text).toContain('tool_001');
    expect(text).toContain('tool_002');
  });

  it('counts only served tools in the coverage numbers', async () => {
    const result = await mcpClient.callTool({
      name: 'mcp-compression-proxy__get_uncompressed_tools',
      arguments: { limit: 100 },
    });

    // Two backend tools survive the exclude pattern; the count reported here
    // has to match what tools/list actually advertises or the percentages are
    // describing a tool set nobody can call.
    expect(textOf(result)).toContain('Found 2 tools without compressed descriptions');
  });

  it('reports the excluded tool as neither total nor compressed in stats', async () => {
    const result = await mcpClient.callTool({
      name: 'mcp-compression-proxy__stats',
      arguments: {},
    });

    const stats = JSON.parse(textOf(result)) as {
      summary: { toolsTotal: number };
      servers: Array<{ name: string; toolsTotal: number; toolsExcluded: number }>;
    };

    const multi = stats.servers.find((server) => server.name === 'multi');
    expect(multi?.toolsTotal).toBe(2);
    expect(multi?.toolsExcluded).toBe(1);
  });
});
