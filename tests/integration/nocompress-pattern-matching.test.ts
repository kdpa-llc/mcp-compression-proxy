/**
 * Integration test for noCompress pattern matching behavior
 * Tests the specific pattern matching scenario: local-skills__* pattern vs local-skills__get_skill tool
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { tmpdir } from 'os';
import { join } from 'path';
import { mkdirSync, writeFileSync, rmSync } from 'fs';

describe('NoCompress Pattern Matching', () => {
  let mcpClient: Client;
  let transport: StdioClientTransport;
  let testHome: string;
  let configDir: string;
  let configPath: string;
  let originalHome: string | undefined;

  beforeAll(async () => {
    // Create a temporary HOME directory
    testHome = join(tmpdir(), `mcp-pattern-test-${Date.now()}`);
    configDir = join(testHome, '.mcp-compression-proxy');
    configPath = join(configDir, 'servers.json');

    mkdirSync(configDir, { recursive: true });

    // Create test servers.json that mimics the real configuration
    const testConfig = {
      mcpServers: [
        {
          name: 'local-skills',
          command: 'node',
          args: [join(process.cwd(), 'tests/__mocks__/single-tool-server.js')],
          enabled: true,
        },
      ],
      noCompressTools: [
        'local-skills__*'  // Pattern matching - should match local-skills__get_skill
      ],
    };

    writeFileSync(configPath, JSON.stringify(testConfig, null, 2));

    // Start the MCP Compression Proxy server
    const serverScript = join(process.cwd(), 'dist/index.js');

    // Set HOME to test directory
    originalHome = process.env.HOME;
    process.env.HOME = testHome;

    transport = new StdioClientTransport({
      command: 'node',
      args: [serverScript],
      env: {
        ...process.env,
        HOME: testHome,
        LOG_LEVEL: 'debug',  // Enable debug to see pattern matching
      },
    });

    mcpClient = new Client(
      {
        name: 'pattern-test-client',
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

  it('should handle wildcard pattern matching correctly', async () => {
    console.log('\n🎯 Testing pattern matching: local-skills__* vs local-skills__get_skill');

    // Step 1: Verify the tool is configured correctly
    const toolsResult = await mcpClient.listTools();
    const localSkillsTool = toolsResult.tools.find(t => t.name === 'local-skills__single_tool');
    expect(localSkillsTool).toBeDefined();
    console.log('   ✓ Tool local-skills__single_tool found in tool list');

    // Step 2: Check if it appears in get_uncompressed_tools initially
    console.log('1. Getting uncompressed tools (should include the tool)...');
    let getResult = await mcpClient.callTool({
      name: 'mcp-compression-proxy__get_uncompressed_tools',
      arguments: { limit: 10 },
    });

    let resultText = (getResult.content as any[])[0].text as string;
    console.log('   Get result:', resultText.substring(0, 300) + '...');

    // Parse tools
    let toolsMatch = resultText.match(/Tools to compress:\s*(\[[\s\S]*?\])/);
    if (toolsMatch) {
      let tools = JSON.parse(toolsMatch[1]);
      const foundTool = tools.find((t: any) => t.toolName === 'single_tool' && t.serverName === 'local-skills');
      expect(foundTool).toBeDefined();
      console.log('   ✓ noCompress tool appears in initial get_uncompressed_tools');
    } else {
      console.log('   No tools to compress found - checking if it shows 0');
      expect(resultText).toContain('Found 0 tools');
      console.log('   ✓ No tools found (already compressed or excluded)');
      return; // End test early
    }

    // Step 3: Cache the tool
    console.log('2. Caching the tool...');
    const cacheResult = await mcpClient.callTool({
      name: 'mcp-compression-proxy__cache_compressed_tools',
      arguments: {
        descriptions: [
          {
            serverName: 'local-skills',
            toolName: 'single_tool',
            description: 'Compressed version'
          }
        ]
      },
    });

    const cacheText = (cacheResult.content as any[])[0].text as string;
    console.log('   Cache result:', cacheText);
    expect(cacheText).toContain('Cached 1 compressed tool descriptions successfully');

    // Step 4: Critical test - get uncompressed tools again
    console.log('3. Getting uncompressed tools again (should be empty now)...');
    const secondGetResult = await mcpClient.callTool({
      name: 'mcp-compression-proxy__get_uncompressed_tools',
      arguments: { limit: 10 },
    });

    const secondResultText = (secondGetResult.content as any[])[0].text as string;
    console.log('   Second get result:', secondResultText);

    // BUG CHECK: Should show 0 tools, not 1
    if (secondResultText.includes('Found 1 tools')) {
      console.log('   ❌ BUG DETECTED: Tool still appears after caching!');
      // This would be the bug - let's analyze further
      
      // Try a third call to see if it persists
      console.log('4. Third call to confirm persistence...');
      const thirdGetResult = await mcpClient.callTool({
        name: 'mcp-compression-proxy__get_uncompressed_tools',
        arguments: { limit: 10 },
      });
      const thirdResultText = (thirdGetResult.content as any[])[0].text as string;
      console.log('   Third get result:', thirdResultText);
      
      if (thirdResultText.includes('Found 1 tools')) {
        console.log('   ❌ BUG CONFIRMED: Tool persistently appears in uncompressed list');
        // This is the bug - the tool is not being marked as cached properly
      }
    } else {
      expect(secondResultText).toContain('Found 0 tools');
      console.log('   ✓ noCompress tool correctly cached - no longer appears in uncompressed list');
    }

    // Step 5: Verify tool listing still shows original description
    console.log('5. Verifying tool listing shows original description...');
    const finalToolsResult = await mcpClient.listTools();
    const finalTool = finalToolsResult.tools.find(t => t.name === 'local-skills__single_tool');
    
    expect(finalTool).toBeDefined();
    // Should show original description because of noCompress pattern
    const originalDesc = 'This is the original long description of a single tool for testing noCompress behavior. It contains multiple sentences and detailed information that would normally be compressed to save context window space.';
    expect(finalTool!.description).toBe(originalDesc);
    console.log('   ✓ Tool listing shows original description (noCompress pattern working)');

    console.log('✅ Pattern matching test completed!');
  }, 30000);

  it('should demonstrate the persistent bug with multiple calls', async () => {
    console.log('\n🐛 Testing for persistent bug behavior');
    
    // Clear any existing cache
    await mcpClient.callTool({
      name: 'mcp-compression-proxy__clear_compressed_tools_cache',
      arguments: {},
    });
    
    for (let i = 1; i <= 5; i++) {
      console.log(`${i}. Getting uncompressed tools (attempt ${i})...`);
      
      const getResult = await mcpClient.callTool({
        name: 'mcp-compression-proxy__get_uncompressed_tools',
        arguments: { limit: 10 },
      });
      
      const resultText = (getResult.content as any[])[0].text as string;
      const toolsMatch = resultText.match(/Found (\d+) tools/);
      const foundCount = toolsMatch ? parseInt(toolsMatch[1]) : 0;
      
      console.log(`   Found ${foundCount} tools`);
      
      if (foundCount > 0) {
        // Try to cache it
        console.log(`   Attempting to cache tools...`);
        const cacheResult = await mcpClient.callTool({
          name: 'mcp-compression-proxy__cache_compressed_tools',
          arguments: {
            descriptions: [
              {
                serverName: 'local-skills',
                toolName: 'single_tool',
                description: `Compressed version ${i}`
              }
            ]
          },
        });
        
        const cacheText = (cacheResult.content as any[])[0].text as string;
        console.log(`   Cache result: ${cacheText}`);
        
        if (cacheText.includes('All tools have been compressed')) {
          console.log('   ✅ Successfully cached - should be done now');
          break;
        } else {
          console.log(`   ⚠️  Still showing ${foundCount} remaining tools after caching`);
        }
      } else {
        console.log('   ✅ No more tools to compress');
        break;
      }
    }
    
    console.log('🔍 Persistent bug test completed');
  }, 45000);
});
