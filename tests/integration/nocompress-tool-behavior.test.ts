/**
 * Integration test for noCompress tool behavior
 * Tests the specific bug where noCompress tools keep appearing in get_uncompressed_tools
 * even after being cached
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { tmpdir } from 'os';
import { join } from 'path';
import { mkdirSync, writeFileSync, rmSync } from 'fs';

describe('NoCompress Tool Behavior', () => {
  let mcpClient: Client;
  let transport: StdioClientTransport;
  let testHome: string;
  let configDir: string;
  let configPath: string;
  let originalHome: string | undefined;

  beforeAll(async () => {
    // Create a temporary HOME directory so the config loader finds our test config
    testHome = join(tmpdir(), `mcp-nocompress-test-${Date.now()}`);
    configDir = join(testHome, '.mcp-compression-proxy');
    configPath = join(configDir, 'servers.json');

    mkdirSync(configDir, { recursive: true });

    // Create test servers.json with noCompress configuration
    const testConfig = {
      mcpServers: [
        {
          name: 'test-server',
          command: 'node',
          args: [join(process.cwd(), 'tests/__mocks__/single-tool-server.js')],
          enabled: true,
        },
      ],
      noCompressTools: [
        'test-server__single_tool'  // This tool should be compressed but display original
      ],
    };

    writeFileSync(configPath, JSON.stringify(testConfig, null, 2));

    // Start the MCP Compression Proxy server
    const serverScript = join(process.cwd(), 'dist/index.js');

    // Set HOME to test directory so config loader finds our test config
    originalHome = process.env.HOME;
    process.env.HOME = testHome;

    transport = new StdioClientTransport({
      command: 'node',
      args: [serverScript],
      env: {
        ...process.env,
        HOME: testHome,
        LOG_LEVEL: 'warn',
      },
    });

    mcpClient = new Client(
      {
        name: 'nocompress-test-client',
        version: '1.0.0',
      },
      {
        capabilities: {},
      }
    );

    await mcpClient.connect(transport);
  }, 10000);

  afterAll(async () => {
    // Restore HOME
    if (originalHome !== undefined) {
      process.env.HOME = originalHome;
    }

    if (mcpClient) {
      await mcpClient.close();
    }

    // Clean up test home directory
    try {
      rmSync(testHome, { recursive: true, force: true });
    } catch (error) {
      // Ignore cleanup errors
    }
  });

  it('should handle noCompress tool caching correctly', async () => {
    console.log('\n🔍 Testing noCompress tool behavior...');

    // Step 1: Get initial uncompressed tools - should include the noCompress tool
    console.log('1. Getting initial uncompressed tools...');
    const initialResult = await mcpClient.callTool({
      name: 'mcp-compression-proxy__get_uncompressed_tools',
      arguments: { limit: 10 },
    });

    expect(initialResult.content).toBeDefined();
    const initialText = (initialResult.content as any[])[0].text as string;
    console.log('   Initial result:', initialText.substring(0, 200) + '...');

    // Parse the tools from the response
    const initialToolsMatch = initialText.match(/Tools to compress:\s*(\[[\s\S]*?\])/);
    expect(initialToolsMatch).not.toBeNull();
    const initialTools = JSON.parse(initialToolsMatch![1]);
    
    console.log('   Found tools:', initialTools.map((t: any) => `${t.serverName}__${t.toolName}`));
    
    // Should contain our test tool
    const testTool = initialTools.find((t: any) => t.toolName === 'single_tool');
    expect(testTool).toBeDefined();
    expect(testTool.serverName).toBe('test-server');
    console.log('   ✓ noCompress tool appears in initial get_uncompressed_tools');

    // Step 2: Cache the compressed tool description
    console.log('2. Caching compressed description...');
    const cacheResult = await mcpClient.callTool({
      name: 'mcp-compression-proxy__cache_compressed_tools',
      arguments: {
        descriptions: [
          {
            serverName: 'test-server',
            toolName: 'single_tool',
            description: 'Compressed description for single tool'
          }
        ]
      },
    });

    expect(cacheResult.content).toBeDefined();
    const cacheText = (cacheResult.content as any[])[0].text as string;
    console.log('   Cache result:', cacheText);
    expect(cacheText).toContain('Cached 1 compressed tool descriptions successfully');

    // Step 3: Get uncompressed tools again - should NOT include the cached tool
    console.log('3. Getting uncompressed tools after caching...');
    const afterCacheResult = await mcpClient.callTool({
      name: 'mcp-compression-proxy__get_uncompressed_tools',
      arguments: { limit: 10 },
    });

    expect(afterCacheResult.content).toBeDefined();
    const afterCacheText = (afterCacheResult.content as any[])[0].text as string;
    console.log('   After cache result:', afterCacheText);

    // BUG: This should show 0 tools, but currently shows 1 due to the bug
    // The test will fail here, proving the bug exists
    expect(afterCacheText).toContain('Found 0 tools without compressed descriptions');
    console.log('   ✓ noCompress tool no longer appears in get_uncompressed_tools after caching');

    // Step 4: Verify tool listing still shows original description
    console.log('4. Verifying tool listing shows original description...');
    const toolsResult = await mcpClient.listTools();
    const testToolInList = toolsResult.tools.find(t => t.name === 'test-server__single_tool');
    
    expect(testToolInList).toBeDefined();
    // Should show original description, not compressed
    expect(testToolInList!.description).not.toBe('Compressed description for single tool');
    console.log('   ✓ Tool listing shows original description for noCompress tool');

    console.log('✅ noCompress tool behavior test passed!');
  }, 30000);
});
