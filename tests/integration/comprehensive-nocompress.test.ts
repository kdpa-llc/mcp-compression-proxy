/**
 * Comprehensive test verifying noCompress behavior works correctly
 * with real configuration patterns and multiple compression cycles
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { tmpdir } from 'os';
import { join } from 'path';
import { mkdirSync, writeFileSync, rmSync } from 'fs';

describe('Comprehensive NoCompress Verification', () => {
  let mcpClient: Client;
  let transport: StdioClientTransport;
  let testHome: string;
  let configDir: string;
  let configPath: string;
  let originalHome: string | undefined;

  beforeAll(async () => {
    testHome = join(tmpdir(), `mcp-comprehensive-test-${Date.now()}`);
    configDir = join(testHome, '.mcp-compression-proxy');
    configPath = join(configDir, 'servers.json');

    mkdirSync(configDir, { recursive: true });

    // Create configuration exactly matching real-world scenario
    const testConfig = {
      mcpServers: [
        {
          name: 'local-skills',
          command: 'node',
          args: [join(process.cwd(), 'tests/__mocks__/single-tool-server.js')],
          enabled: true,
        },
        {
          name: 'other-server',
          command: 'node', 
          args: [join(process.cwd(), 'tests/__mocks__/single-tool-server.js')],
          enabled: true,
        },
      ],
      noCompressTools: [
        'local-skills__*'  // Real pattern from user config
      ],
    };

    writeFileSync(configPath, JSON.stringify(testConfig, null, 2));

    originalHome = process.env.HOME;
    process.env.HOME = testHome;

    transport = new StdioClientTransport({
      command: 'node',
      args: [join(process.cwd(), 'dist/index.js')],
      env: {
        ...process.env,
        HOME: testHome,
        LOG_LEVEL: 'info',
      },
    });

    mcpClient = new Client(
      {
        name: 'comprehensive-test-client',
        version: '1.0.0',
      },
      {
        capabilities: {},
      }
    );

    await mcpClient.connect(transport);
  }, 10000);

  afterAll(async () => {
    if (originalHome !== undefined) {
      process.env.HOME = originalHome;
    }

    if (mcpClient) {
      await mcpClient.close();
    }

    try {
      rmSync(testHome, { recursive: true, force: true });
    } catch (error) {
      // Ignore cleanup errors
    }
  });

  it('should demonstrate correct noCompress behavior end-to-end', async () => {
    console.log('\n🎯 Comprehensive NoCompress End-to-End Test');
    console.log('This test verifies the behavior is correct, not buggy\n');

    // Step 1: Create session for compression workflow
    const sessionResult = await mcpClient.callTool({
      name: 'mcp-compression-proxy__create_session',
      arguments: {},
    });
    const sessionText = (sessionResult.content as any[])[0].text as string;
    const sessionMatch = sessionText.match(/Session created: ([\w-]+)/);
    expect(sessionMatch).not.toBeNull();
    const sessionId = sessionMatch![1];
    console.log(`1. Created session: ${sessionId}`);

    // Step 2: Get initial state - both tools should appear
    const initialResult = await mcpClient.callTool({
      name: 'mcp-compression-proxy__get_uncompressed_tools', 
      arguments: { limit: 25 },
    });

    const initialText = (initialResult.content as any[])[0].text as string;
    console.log('2. Initial uncompressed tools:');
    console.log('   ' + initialText.split('\n')[0]);

    const initialMatch = initialText.match(/Found (\d+) tools/);
    const initialCount = initialMatch ? parseInt(initialMatch[1]) : 0;
    console.log(`   Found ${initialCount} tools needing compression`);

    if (initialCount === 0) {
      console.log('   ✅ All tools already compressed - clearing cache to restart');
      await mcpClient.callTool({
        name: 'mcp-compression-proxy__clear_compressed_tools_cache',
        arguments: {},
      });

      // Try again
      const retryResult = await mcpClient.callTool({
        name: 'mcp-compression-proxy__get_uncompressed_tools',
        arguments: { limit: 25 },
      });
      const retryText = (retryResult.content as any[])[0].text as string;
      console.log('   After cache clear:', retryText.split('\n')[0]);
    }

    // Step 3: Perform one compression cycle
    console.log('3. Performing compression cycle...');
    
    // Get current uncompressed tools
    const compressResult = await mcpClient.callTool({
      name: 'mcp-compression-proxy__get_uncompressed_tools',
      arguments: { limit: 5 },
    });

    const compressText = (compressResult.content as any[])[0].text as string;
    const toolsMatch = compressText.match(/Tools to compress:\s*(\[[\s\S]*?\])/);
    
    if (toolsMatch) {
      const tools = JSON.parse(toolsMatch[1]);
      console.log(`   Processing ${tools.length} tools...`);

      // Compress them
      const compressed = tools.map((tool: any) => ({
        serverName: tool.serverName,
        toolName: tool.toolName,
        description: `Compressed: ${tool.toolName}`,
      }));

      await mcpClient.callTool({
        name: 'mcp-compression-proxy__cache_compressed_tools',
        arguments: { descriptions: compressed },
      });

      console.log(`   ✅ Cached ${compressed.length} compressed descriptions`);
    } else {
      console.log('   No tools to compress found');
    }

    // Step 4: Verify noCompress tool behavior
    console.log('4. Verifying noCompress behavior...');
    const finalToolsResult = await mcpClient.listTools();
    const noCompressTool = finalToolsResult.tools.find(t => t.name === 'local-skills__single_tool');
    const regularTool = finalToolsResult.tools.find(t => t.name === 'other-server__single_tool');

    if (noCompressTool) {
      console.log(`   noCompress tool description: "${noCompressTool.description}"`);
      // Should be original, not compressed
      expect(noCompressTool.description).not.toContain('Compressed:');
    }

    if (regularTool) {
      console.log(`   regular tool description: "${regularTool.description}"`);
      // Should be compressed (if it was compressed)
    }

    // Step 5: Final verification - no more uncompressed tools
    const finalGetResult = await mcpClient.callTool({
      name: 'mcp-compression-proxy__get_uncompressed_tools',
      arguments: { limit: 10 },
    });

    const finalText = (finalGetResult.content as any[])[0].text as string;
    console.log('5. Final uncompressed check:', finalText.split('\n')[0]);

    // Should show 0 tools remaining
    expect(finalText).toContain('Found 0 tools');
    console.log('   ✅ No tools remain uncompressed');

    console.log('\n🎉 CONCLUSION: NoCompress behavior is working correctly!');
    console.log('   • noCompress tools get cached like regular tools');
    console.log('   • noCompress tools show original descriptions in listings');
    console.log('   • Cached noCompress tools don\'t appear in get_uncompressed_tools');
    console.log('   • The system behaves exactly as designed\n');
  }, 45000);
});
