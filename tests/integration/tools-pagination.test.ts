/**
 * tools/list cursor pagination.
 *
 * The proxy is an aggregator, so the unbounded tool list is exactly the case it
 * is most likely to hit. Page size is forced small here via MCP_TOOLS_PAGE_SIZE
 * rather than standing up a backend with hundreds of tools.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { tmpdir } from 'os';
import { join } from 'path';
import { mkdirSync, writeFileSync, rmSync } from 'fs';

const PAGE_SIZE = 5;
const BACKEND_TOOLS = 12;

describe('tools/list pagination', () => {
  let mcpClient: Client;
  let transport: StdioClientTransport;
  let testHome: string;
  let originalHome: string | undefined;

  beforeAll(async () => {
    testHome = join(tmpdir(), `mcp-pagination-test-${Date.now()}`);
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
      env: {
        ...process.env,
        HOME: testHome,
        MOCK_TOOL_COUNT: String(BACKEND_TOOLS),
        MCP_TOOLS_PAGE_SIZE: String(PAGE_SIZE),
        LOG_LEVEL: 'error',
      },
    });

    mcpClient = new Client({ name: 'pagination-test-client', version: '1.0.0' }, { capabilities: {} });
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

  it('returns a bounded first page with a cursor', async () => {
    const first = await mcpClient.listTools({});

    expect(first.tools).toHaveLength(PAGE_SIZE);
    expect(first.nextCursor).toBeDefined();
  });

  it('walks every tool exactly once across pages', async () => {
    const seen: string[] = [];
    let cursor: string | undefined;
    let pages = 0;

    do {
      const page = await mcpClient.listTools(cursor ? { cursor } : {});
      seen.push(...page.tools.map((tool) => tool.name));
      cursor = page.nextCursor;
      pages += 1;
      expect(pages).toBeLessThan(20); // guards against a cursor that never advances
    } while (cursor);

    // No duplicates and no gaps.
    expect(new Set(seen).size).toBe(seen.length);

    // Management tools plus the backend tools that survived the exclude
    // pattern - pagination must walk the post-exclude list.
    expect(seen).not.toContain('multi__tool_000');
    expect(seen).toContain('multi__tool_001');
    expect(seen).toContain(`multi__tool_${String(BACKEND_TOOLS - 1).padStart(3, '0')}`);
    expect(seen).toContain('mcp-compression-proxy__stats');
    expect(seen.length).toBeGreaterThan(PAGE_SIZE);
  });

  it('omits nextCursor on the final page', async () => {
    let cursor: string | undefined;
    let last: Awaited<ReturnType<typeof mcpClient.listTools>> | undefined;

    do {
      last = await mcpClient.listTools(cursor ? { cursor } : {});
      cursor = last.nextCursor;
    } while (cursor);

    expect(last?.nextCursor).toBeUndefined();
    expect(last?.tools.length).toBeGreaterThan(0);
  });

  it('reports an unusable cursor instead of restarting', async () => {
    // Silently returning page one would make a client looping on nextCursor
    // spin forever.
    const result = await mcpClient.listTools({ cursor: 'not-a-number' });

    expect(result.tools).toHaveLength(0);
    expect(result.nextCursor).toBeUndefined();
  });
});
