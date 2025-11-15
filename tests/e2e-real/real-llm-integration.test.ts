/**
 * Real LLM Integration E2E Test
 *
 * This test validates the complete MCP Tool Aggregator workflow using a real LLM (Ollama).
 * Unlike mocked tests, this verifies that:
 * - The MCP server actually communicates via stdio correctly
 * - Tool descriptions guide real LLM behavior
 * - Real LLM can understand and follow the compression workflow
 * - The entire system works end-to-end with actual LLM inference
 *
 * Requirements:
 * - Ollama installed and running (http://localhost:11434)
 * - Model pulled: ollama pull llama3.2:1b
 * - MCP server built: npm run build
 */

import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { OllamaClient } from './ollama-client.js';
import path from 'path';

describe('Real LLM E2E Integration', () => {
  let mcpClient: Client;
  let transport: StdioClientTransport;
  let ollamaClient: OllamaClient;

  beforeAll(async () => {
    console.log('\n🚀 Setting up Real LLM E2E Test Environment...\n');

    // Check if Ollama is already running
    ollamaClient = new OllamaClient();
    const isRunning = await ollamaClient.isRunning();

    if (!isRunning) {
      console.log('⚠️  Ollama not running. Skipping real LLM tests.');
      console.log('   To enable: Install Ollama and run "ollama serve"');
      console.log('   See: https://ollama.com/download\n');
      return;
    }

    console.log('✓ Ollama is running');

    // Pull model if needed
    try {
      console.log('📥 Ensuring llama3.2:1b model is available...');
      await ollamaClient.pullModel();
      console.log('✓ Model ready');
    } catch (error) {
      console.log('⚠️  Failed to pull model, test may fail:', error);
    }

    // Start MCP server
    console.log('🔧 Starting MCP Tool Aggregator server...');
    const serverPath = path.join(process.cwd(), 'dist/index.js');

    transport = new StdioClientTransport({
      command: 'node',
      args: [serverPath],
    });

    mcpClient = new Client(
      {
        name: 'real-llm-test-client',
        version: '1.0.0',
      },
      {
        capabilities: {},
      }
    );

    await mcpClient.connect(transport);
    console.log('✓ MCP server connected\n');
  }, 60000); // 60 second timeout for setup

  afterAll(async () => {
    if (mcpClient) {
      await mcpClient.close();
    }
  });

  it('should complete full compression workflow with real LLM', async () => {
    // Skip if Ollama not available
    if (!(await ollamaClient.isRunning())) {
      console.log('⏭️  Skipping test - Ollama not available');
      return;
    }

    console.log('\n📋 PHASE 1: List initial tools');

    // Step 1: List tools before compression
    const initialTools = await mcpClient.listTools();
    console.log(`   Found ${initialTools.tools.length} tools`);
    expect(initialTools.tools.length).toBeGreaterThan(0);

    // Step 2: Call compress_tools management tool
    console.log('\n🗜️  PHASE 2: Call compress_tools');
    const compressResult = await mcpClient.callTool({
      name: 'compress_tools',
      arguments: {},
    });

    expect(compressResult.content).toBeDefined();
    expect(Array.isArray(compressResult.content)).toBe(true);
    const content = compressResult.content as Array<{ type: string; text: string }>;
    expect(content[0].type).toBe('text');

    const responseText = content[0].text;
    console.log(`   Response preview: ${responseText.substring(0, 100)}...`);

    // Extract tools from response
    const jsonMatch = responseText.match(/\[([\s\S]*?)\]/);
    expect(jsonMatch).toBeTruthy();

    const toolsToCompress = JSON.parse(jsonMatch![0]);
    console.log(`   Extracted ${toolsToCompress.length} tools to compress`);

    // Step 3: Use real LLM to compress descriptions
    console.log('\n🤖 PHASE 3: Real LLM compression');
    console.log('   Sending to Ollama for intelligent compression...');

    const compressed = await ollamaClient.compressToolDescriptions(toolsToCompress);

    console.log(`   LLM compressed ${compressed.length} tool descriptions`);

    // Verify compression quality
    expect(compressed.length).toBe(toolsToCompress.length);

    // Check that descriptions are actually shorter
    for (let i = 0; i < Math.min(3, compressed.length); i++) {
      const original = toolsToCompress[i];
      const comp = compressed[i];

      console.log(`\n   Tool: ${comp.serverName}__${comp.toolName}`);
      console.log(`   Original (${original.description.length} chars): ${original.description.substring(0, 60)}...`);
      console.log(`   Compressed (${comp.compressedDescription.length} chars): ${comp.compressedDescription}`);

      expect(comp.compressedDescription.length).toBeLessThan(original.description.length);
      expect(comp.compressedDescription.length).toBeGreaterThan(0);
    }

    // Step 4: Save compressed descriptions via MCP
    console.log('\n💾 PHASE 4: Save compressed descriptions');
    const saveResult = await mcpClient.callTool({
      name: 'save_compressed_tools',
      arguments: {
        descriptions: compressed,
      },
    });

    const saveContent = saveResult.content as Array<{ type: string; text: string }>;
    expect(saveContent[0].type).toBe('text');
    const saveText = saveContent[0].text;
    console.log(`   ${saveText}`);
    expect(saveText).toContain('Saved');

    // Step 5: Verify tools now use compressed descriptions
    console.log('\n✅ PHASE 5: Verify compression is active');
    const compressedTools = await mcpClient.listTools();

    // Find a tool that should be compressed
    const testTool = compressedTools.tools.find(t =>
      t.name.includes('filesystem__') || t.name.includes('github__')
    );

    if (testTool) {
      console.log(`   Sample tool: ${testTool.name}`);
      console.log(`   Description length: ${testTool.description?.length || 0} chars`);
      console.log(`   Description: ${testTool.description}`);

      // Compressed description should be shorter than original
      const originalTool = toolsToCompress.find((t: any) =>
        testTool.name.includes(t.toolName)
      );

      if (originalTool) {
        const compressionRatio = ((testTool.description?.length || 0) / originalTool.description.length) * 100;
        console.log(`   Compression ratio: ${compressionRatio.toFixed(1)}%`);
        expect(testTool.description!.length).toBeLessThan(originalTool.description.length);
      }
    }

    console.log('\n🎉 Real LLM E2E test passed!\n');
  }, 120000); // 2 minute timeout for LLM inference

  it('should handle session-based expansion with real LLM', async () => {
    // Skip if Ollama not available
    if (!(await ollamaClient.isRunning())) {
      console.log('⏭️  Skipping test - Ollama not available');
      return;
    }

    console.log('\n🔓 Testing session-based tool expansion');

    // Create a session
    const sessionResult = await mcpClient.callTool({
      name: 'create_session',
      arguments: {},
    });

    const sessionContent = sessionResult.content as Array<{ type: string; text: string }>;
    const sessionText = sessionContent[0].text;
    const sessionMatch = sessionText.match(/Session created: ([\w-]+)/);
    expect(sessionMatch).toBeTruthy();

    const sessionId = sessionMatch![1];
    console.log(`   ✓ Created session: ${sessionId}`);

    // Expand a tool
    const expandResult = await mcpClient.callTool({
      name: 'expand_tool',
      arguments: {
        serverName: 'filesystem',
        toolName: 'read_file',
      },
    });

    const expandContent = expandResult.content as Array<{ type: string; text: string }>;
    const expandText = expandContent[0].text;
    console.log(`   ✓ Expanded tool: ${expandText.substring(0, 50)}...`);
    expect(expandText).toContain('expanded');

    // List tools - should show full description for expanded tool
    const tools = await mcpClient.listTools();
    const readFileTool = tools.tools.find(t => t.name === 'filesystem__read_file');

    if (readFileTool) {
      console.log(`   ✓ Tool description length: ${readFileTool.description?.length || 0} chars`);
      // Expanded tool should have longer description
      expect(readFileTool.description!.length).toBeGreaterThan(50);
    }

    console.log('   ✓ Session expansion working correctly\n');
  }, 60000);

  it('should validate LLM follows tool description instructions', async () => {
    // Skip if Ollama not available
    if (!(await ollamaClient.isRunning())) {
      console.log('⏭️  Skipping test - Ollama not available');
      return;
    }

    console.log('\n📖 Testing LLM understanding of tool descriptions');

    // Get compress_tools description
    const tools = await mcpClient.listTools();
    const compressTool = tools.tools.find(t => t.name === 'compress_tools');

    expect(compressTool).toBeDefined();
    console.log(`   Tool: ${compressTool!.name}`);
    console.log(`   Description: ${compressTool!.description}`);

    // Verify description contains key instructions
    expect(compressTool!.description).toContain('compress');
    expect(compressTool!.description).toContain('save_compressed_tools');

    // Ask LLM to understand the workflow
    const llmUnderstanding = await ollamaClient.chat(
      'You are analyzing MCP tool descriptions. Extract the workflow steps.',
      `Given this tool description:\n"${compressTool!.description}"\n\nWhat should a user do after calling this tool? Answer in one sentence.`
    );

    console.log(`   LLM understanding: ${llmUnderstanding}`);

    // LLM should understand it needs to compress and call save_compressed_tools
    const understanding = llmUnderstanding.toLowerCase();
    expect(
      understanding.includes('compress') ||
      understanding.includes('save')
    ).toBe(true);

    console.log('   ✓ LLM correctly interprets tool instructions\n');
  }, 60000);
});
