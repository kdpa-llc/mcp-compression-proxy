import { testProcessEnv } from '../helpers/test-process-env.js';
/**
 * Lazy tool exposure in the native proxy.
 *
 * With toolExposure "lazy" a client sees a handful of discovery tools instead
 * of every backend schema, and reaches backend tools through search_tools,
 * get_tool and call_tool - the mcp-cli flow, over plain MCP. Runs the built
 * proxy with the Node stand-in for the Needle bridge.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

describe('native proxy in lazy exposure', () => {
  let client: Client;
  let testHome: string;

  function textOf(result: unknown): string {
    const content = (result as { content?: Array<{ type: string; text?: string }> }).content;
    return (content ?? []).map((part) => part.text ?? '').join('\n');
  }

  async function call(name: string, args: Record<string, unknown>) {
    return client.callTool({ name, arguments: args });
  }

  beforeAll(async () => {
    testHome = mkdtempSync(join(tmpdir(), 'mcp-lazy-'));
    const configDir = join(testHome, '.mcp-compression-proxy');
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      join(configDir, 'servers.json'),
      JSON.stringify({
        mcpServers: [
          {
            name: 'multi',
            command: 'node',
            args: [join(process.cwd(), 'tests/__mocks__/multi-tool-server.js')],
          },
        ],
        toolExposure: 'lazy',
        pinnedTools: ['multi__tool_001'],
        excludeTools: ['multi__tool_002'],
        model: {
          provider: 'needle',
          command: process.execPath,
          args: [join(process.cwd(), 'tests/__mocks__/fake-model-bridge.js')],
        },
      })
    );

    const transport = new StdioClientTransport({
      command: 'node',
      args: [join(process.cwd(), 'dist/index.js')],
      env: { ...testProcessEnv(testHome), MOCK_TOOL_COUNT: '4', LOG_LEVEL: 'error' },
    });
    client = new Client({ name: 'lazy-test', version: '1.0.0' }, { capabilities: {} });
    await client.connect(transport);
  }, 20000);

  afterAll(async () => {
    await client?.close();
    rmSync(testHome, { recursive: true, force: true });
  });

  it('lists discovery tools and pinned tools instead of every backend schema', async () => {
    const { tools } = await client.listTools();
    const names = tools.map((tool) => tool.name);

    expect(names).toEqual(
      expect.arrayContaining([
        'mcp-compression-proxy__search_tools',
        'mcp-compression-proxy__get_tool',
        'mcp-compression-proxy__call_tool',
        'mcp-compression-proxy__suggest_tool',
        'mcp-compression-proxy__shape_output',
        'mcp-compression-proxy__read_output',
        'multi__tool_001',
      ])
    );
    expect(names).not.toContain('multi__tool_000');
    expect(names).not.toContain('multi__tool_003');
    expect(names).not.toContain('mcp-compression-proxy__get_uncompressed_tools');
    expect(names.length).toBeLessThan(12);
  });

  it('finds, describes and calls a tool that is not listed', async () => {
    const found = JSON.parse(textOf(await call('mcp-compression-proxy__search_tools', { query: 'tool_003' })));
    expect(found.tools[0]).toMatchObject({ server: 'multi', tool: 'tool_003' });
    expect(found.tools.map((tool: { tool: string }) => tool.tool)).not.toContain('tool_002');

    const described = JSON.parse(
      textOf(await call('mcp-compression-proxy__get_tool', { server: 'multi', tool: 'tool_003' }))
    );
    expect(described.inputSchema.properties.input).toBeDefined();

    const ran = await call('mcp-compression-proxy__call_tool', { server: 'multi', tool: 'tool_003' });
    expect(textOf(ran)).toBe('tool_003 executed successfully');
  });

  it('refuses an excluded tool through call_tool too', async () => {
    const result = await call('mcp-compression-proxy__call_tool', { server: 'multi', tool: 'tool_002' });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('excluded');
  });

  it('returns only the requested fields and items, keeping the full output', async () => {
    const output = JSON.stringify({
      items: [
        { id: 1, title: 'Login fails with SSO', body: 'x'.repeat(500) },
        { id: 2, title: 'Dark mode', body: 'y'.repeat(500) },
      ],
    });

    const shaped = JSON.parse(
      textOf(
        await call('mcp-compression-proxy__call_tool', {
          server: 'multi',
          tool: 'tool_003',
          arguments: { input: output },
          want: { items: [{ id: 'integer', title: 'string' }] },
          where: 'login',
        })
      )
    );

    expect(shaped.data).toEqual({ items: [{ id: 1, title: 'Login fails with SSO' }] });
    expect(shaped.meta.items).toMatchObject({ total: 2, kept: 1 });

    const source = JSON.parse(
      textOf(await call('mcp-compression-proxy__read_output', { id: shaped.source.id, all: true }))
    );
    expect(source.content).toBe(output);
  });

  it('suggests a call, and runs it only for a confident read-only proposal', async () => {
    const proposal = JSON.parse(
      textOf(await call('mcp-compression-proxy__suggest_tool', { request: 'multi tool 003 input=hello' }))
    );
    expect(proposal.suggestion.proposal).toMatchObject({ tool: 'tool_003', arguments: { input: 'hello' } });
    expect(proposal.suggestion.runnable).toBe(false);
    expect(proposal.suggestion.runBlockedBy).toContain('readOnlyHint');

    const ran = await call('mcp-compression-proxy__suggest_tool', {
      request: 'multi tool 001 input=hello',
      run: true,
    });
    expect(textOf(ran)).toContain('tool_001 executed successfully');
  });
});
