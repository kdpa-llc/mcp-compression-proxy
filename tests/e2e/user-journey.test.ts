import { describe, it, expect, beforeEach } from '@jest/globals';
import { CompressionCache } from '../../src/services/compression-cache.js';
import { SessionManager } from '../../src/services/session-manager.js';
import {
  getMockLogger,
  createMockFilesystemClient,
  createMockGitHubClient,
  SAMPLE_COMPRESSIONS,
} from '../__mocks__/mcp-mocks.js';
import type { Logger } from 'pino';

/**
 * Comprehensive User Journey E2E Test
 *
 * This test simulates a realistic user workflow across multiple sessions,
 * testing the complete feature set including:
 * - Tool aggregation from multiple servers
 * - Description compression workflow
 * - Session-based expansion/collapse
 * - Compression persistence across sessions
 * - Multi-session isolation
 * - Management tools integration
 */
describe('E2E: Complete User Journey', () => {
  let compressionCache: CompressionCache;
  let sessionManager: SessionManager;
  let logger: Logger;
  let filesystemClient: any;
  let githubClient: any;

  beforeEach(async () => {
    logger = getMockLogger() as unknown as Logger;
    compressionCache = new CompressionCache(logger);
    sessionManager = new SessionManager(logger);

    // Setup mock MCP servers
    filesystemClient = createMockFilesystemClient();
    githubClient = createMockGitHubClient();

    await filesystemClient.connect();
    await githubClient.connect();
  });

  it('should handle complete user workflow across multiple sessions', async () => {
    // ==================================================================
    // PHASE 1: Initial State - Tools Not Compressed
    // ==================================================================
    console.log('\n📋 PHASE 1: Initial State - Tools Not Compressed');

    const filesystemTools = await filesystemClient.listTools();
    const githubTools = await githubClient.listTools();

    // Aggregate tools (simulate management tool: compress_tools)
    const allTools = [
      ...filesystemTools.tools.map((t: any) => ({
        serverName: 'filesystem',
        toolName: t.name,
        description: t.description,
      })),
      ...githubTools.tools.map((t: any) => ({
        serverName: 'github',
        toolName: t.name,
        description: t.description,
      })),
    ];

    console.log(`  ✓ Aggregated ${allTools.length} tools from 2 servers`);

    // Initially, tools should show full descriptions (no compression)
    const initialDesc = compressionCache.getDescription(
      'filesystem',
      'read_file',
      filesystemTools.tools[0].description,
      false
    );
    expect(initialDesc).toBe(filesystemTools.tools[0].description);
    console.log('  ✓ Tools showing full descriptions (not compressed yet)');

    // ==================================================================
    // PHASE 2: User Compresses Tool Descriptions
    // ==================================================================
    console.log('\n🗜️  PHASE 2: User Compresses Tool Descriptions');

    // Simulate user performing compression with LLM
    // Then saving compressed descriptions (simulate management tool: save_compressed_tools)
    allTools.forEach((tool: any) => {
      const key = `${tool.serverName}:${tool.toolName}` as keyof typeof SAMPLE_COMPRESSIONS;
      const compression = SAMPLE_COMPRESSIONS[key];
      if (compression) {
        compressionCache.saveCompressed(
          tool.serverName,
          tool.toolName,
          compression.compressed,
          tool.description
        );
      }
    });

    console.log(`  ✓ Compressed ${compressionCache.getStats().compressedTools} tool descriptions`);

    // Verify compression is active
    const compressedDesc = compressionCache.getDescription(
      'filesystem',
      'read_file',
      filesystemTools.tools[0].description,
      false
    );
    expect(compressedDesc).toBe(SAMPLE_COMPRESSIONS['filesystem:read_file'].compressed);
    expect(compressedDesc?.length).toBeLessThan(filesystemTools.tools[0].description!.length);
    console.log('  ✓ Tools now showing compressed descriptions');

    // ==================================================================
    // PHASE 3: Session 1 - User Expands Specific Tools
    // ==================================================================
    console.log('\n🔓 PHASE 3: Session 1 - User Expands Specific Tools');

    // Create session 1 (simulate management tool: create_session)
    const session1Id = sessionManager.createSession();
    console.log(`  ✓ Created session 1: ${session1Id}`);

    // User needs details about read_file, so they expand it
    // (simulate management tool: expand_tool)
    sessionManager.expandTool(session1Id, 'filesystem', 'read_file');
    console.log('  ✓ Expanded filesystem__read_file in session 1');

    // Verify tool shows full description in session 1
    const session1Expanded = sessionManager.isToolExpanded(
      session1Id,
      'filesystem',
      'read_file'
    );
    const session1Desc = compressionCache.getDescription(
      'filesystem',
      'read_file',
      filesystemTools.tools[0].description,
      session1Expanded
    );
    expect(session1Desc).toBe(filesystemTools.tools[0].description);
    console.log('  ✓ Tool showing full description in session 1');

    // User also expands github create_issue
    sessionManager.expandTool(session1Id, 'github', 'create_issue');
    console.log('  ✓ Expanded github__create_issue in session 1');

    // Other tools remain compressed in session 1
    const session1WriteFileExpanded = sessionManager.isToolExpanded(
      session1Id,
      'filesystem',
      'write_file'
    );
    expect(session1WriteFileExpanded).toBe(false);
    console.log('  ✓ Other tools remain compressed in session 1');

    const session1Stats = sessionManager.getSessionStats(session1Id);
    console.log(`  ✓ Session 1 has ${session1Stats?.expandedToolsCount} expanded tools`);

    // ==================================================================
    // PHASE 4: Session 1 Ends
    // ==================================================================
    console.log('\n🔚 PHASE 4: Session 1 Ends (User Closes Conversation)');

    // Session 1 is still active, but user moves to new conversation
    // Compression cache should persist
    expect(compressionCache.hasCompressed('filesystem', 'read_file')).toBe(true);
    console.log('  ✓ Compression cache persists after session activity');

    // ==================================================================
    // PHASE 5: Session 2 - New Conversation Starts
    // ==================================================================
    console.log('\n🆕 PHASE 5: Session 2 - New Conversation Starts');

    // Create session 2 (new conversation)
    const session2Id = sessionManager.createSession();
    console.log(`  ✓ Created session 2: ${session2Id}`);

    // CRITICAL TEST: Tools should be compressed by default in new session
    const session2ReadFileExpanded = sessionManager.isToolExpanded(
      session2Id,
      'filesystem',
      'read_file'
    );
    expect(session2ReadFileExpanded).toBe(false);
    console.log('  ✓ Previously expanded tool starts compressed in session 2');

    const session2Desc = compressionCache.getDescription(
      'filesystem',
      'read_file',
      filesystemTools.tools[0].description,
      session2ReadFileExpanded
    );
    expect(session2Desc).toBe(SAMPLE_COMPRESSIONS['filesystem:read_file'].compressed);
    console.log('  ✓ Tool showing compressed description in session 2');

    // CRITICAL TEST: Session 1 expansions don't affect session 2
    const session2CreateIssueExpanded = sessionManager.isToolExpanded(
      session2Id,
      'github',
      'create_issue'
    );
    expect(session2CreateIssueExpanded).toBe(false);
    console.log('  ✓ Session isolation confirmed - session 1 expansions not in session 2');

    // ==================================================================
    // PHASE 6: Session 2 - User Expands Different Tool
    // ==================================================================
    console.log('\n🔓 PHASE 6: Session 2 - User Expands Different Tool');

    // User in session 2 needs details about write_file
    sessionManager.expandTool(session2Id, 'filesystem', 'write_file');
    console.log('  ✓ Expanded filesystem__write_file in session 2');

    const session2WriteExpanded = sessionManager.isToolExpanded(
      session2Id,
      'filesystem',
      'write_file'
    );
    const session2WriteDesc = compressionCache.getDescription(
      'filesystem',
      'write_file',
      filesystemTools.tools[1].description,
      session2WriteExpanded
    );
    expect(session2WriteDesc).toBe(filesystemTools.tools[1].description);
    console.log('  ✓ Tool showing full description in session 2');

    // ==================================================================
    // PHASE 7: Verify Multi-Session Isolation
    // ==================================================================
    console.log('\n🔒 PHASE 7: Verify Multi-Session Isolation');

    // Session 1 should still have its original expansions
    expect(sessionManager.isToolExpanded(session1Id, 'filesystem', 'read_file')).toBe(true);
    expect(sessionManager.isToolExpanded(session1Id, 'github', 'create_issue')).toBe(true);
    expect(sessionManager.isToolExpanded(session1Id, 'filesystem', 'write_file')).toBe(false);
    console.log('  ✓ Session 1 expansion state unchanged');

    // Session 2 should have different expansions
    expect(sessionManager.isToolExpanded(session2Id, 'filesystem', 'read_file')).toBe(false);
    expect(sessionManager.isToolExpanded(session2Id, 'github', 'create_issue')).toBe(false);
    expect(sessionManager.isToolExpanded(session2Id, 'filesystem', 'write_file')).toBe(true);
    console.log('  ✓ Session 2 has independent expansion state');

    const session2Stats = sessionManager.getSessionStats(session2Id);
    expect(session2Stats?.expandedToolsCount).toBe(1);
    console.log(`  ✓ Session 2 has ${session2Stats?.expandedToolsCount} expanded tool`);

    // ==================================================================
    // PHASE 8: User Collapses Tool in Session 2
    // ==================================================================
    console.log('\n🔒 PHASE 8: User Collapses Tool in Session 2');

    // User done with write_file details, collapse it to save context
    sessionManager.collapseTool(session2Id, 'filesystem', 'write_file');
    console.log('  ✓ Collapsed filesystem__write_file in session 2');

    const session2WriteCollapsed = !sessionManager.isToolExpanded(
      session2Id,
      'filesystem',
      'write_file'
    );
    expect(session2WriteCollapsed).toBe(true);

    const session2WriteCollapsedDesc = compressionCache.getDescription(
      'filesystem',
      'write_file',
      filesystemTools.tools[1].description,
      !session2WriteCollapsed
    );
    expect(session2WriteCollapsedDesc).toBe(
      SAMPLE_COMPRESSIONS['filesystem:write_file'].compressed
    );
    console.log('  ✓ Tool back to compressed description');

    // ==================================================================
    // PHASE 9: Session 3 - Verify Compression Still Persists
    // ==================================================================
    console.log('\n♻️  PHASE 9: Session 3 - Verify Compression Persistence');

    const session3Id = sessionManager.createSession();
    console.log(`  ✓ Created session 3: ${session3Id}`);

    // All tools should still be compressed
    const session3Desc = compressionCache.getDescription(
      'filesystem',
      'read_file',
      filesystemTools.tools[0].description,
      false
    );
    expect(session3Desc).toBe(SAMPLE_COMPRESSIONS['filesystem:read_file'].compressed);
    console.log('  ✓ Compression persists across multiple sessions');

    // No tools expanded in session 3 yet
    const session3Stats = sessionManager.getSessionStats(session3Id);
    expect(session3Stats?.expandedToolsCount).toBe(0);
    console.log('  ✓ Session 3 starts with all tools compressed');

    // ==================================================================
    // PHASE 10: Clean Up - Delete Sessions
    // ==================================================================
    console.log('\n🧹 PHASE 10: Clean Up - Delete Sessions');

    sessionManager.deleteSession(session1Id);
    sessionManager.deleteSession(session2Id);
    console.log('  ✓ Deleted sessions 1 and 2');

    // Compression cache should survive session deletion
    expect(compressionCache.hasCompressed('filesystem', 'read_file')).toBe(true);
    console.log('  ✓ Compression cache survives session deletion');

    // Session 3 unaffected
    expect(sessionManager.hasSession(session3Id)).toBe(true);
    console.log('  ✓ Session 3 remains active');

    // ==================================================================
    // FINAL VERIFICATION
    // ==================================================================
    console.log('\n✅ FINAL VERIFICATION');

    const finalStats = compressionCache.getStats();
    console.log(`  ✓ ${finalStats.compressedTools} tools remain compressed`);
    console.log(`  ✓ ${sessionManager.getAllSessions().length} active session(s)`);
    console.log('\n🎉 Complete user journey test passed!\n');
  });

  it('should handle management tools API workflow', async () => {
    console.log('\n🔧 Testing Management Tools API Workflow');

    // Test compress_tools workflow
    const filesystemTools = await filesystemClient.listTools();
    const githubTools = await githubClient.listTools();

    const toolsForCompression = [
      ...filesystemTools.tools.map((t: any) => ({
        serverName: 'filesystem',
        toolName: t.name,
        description: t.description,
      })),
      ...githubTools.tools.map((t: any) => ({
        serverName: 'github',
        toolName: t.name,
        description: t.description,
      })),
    ];

    console.log(`  ✓ compress_tools returned ${toolsForCompression.length} tools`);

    // Test save_compressed_tools
    toolsForCompression.forEach((tool: any) => {
      const key = `${tool.serverName}:${tool.toolName}` as keyof typeof SAMPLE_COMPRESSIONS;
      const compression = SAMPLE_COMPRESSIONS[key];
      if (compression) {
        compressionCache.saveCompressed(
          tool.serverName,
          tool.toolName,
          compression.compressed,
          tool.description
        );
      }
    });
    console.log('  ✓ save_compressed_tools saved descriptions');

    // Test create_session
    const sessionId = sessionManager.createSession();
    expect(sessionId).toBeDefined();
    expect(typeof sessionId).toBe('string');
    console.log(`  ✓ create_session returned: ${sessionId}`);

    // Test expand_tool
    const expandResult = sessionManager.expandTool(
      sessionId,
      'filesystem',
      'read_file'
    );
    expect(expandResult).toBe(true);
    expect(sessionManager.isToolExpanded(sessionId, 'filesystem', 'read_file')).toBe(true);
    console.log('  ✓ expand_tool successfully expanded tool');

    // Test collapse_tool
    const collapseResult = sessionManager.collapseTool(
      sessionId,
      'filesystem',
      'read_file'
    );
    expect(collapseResult).toBe(true);
    expect(sessionManager.isToolExpanded(sessionId, 'filesystem', 'read_file')).toBe(false);
    console.log('  ✓ collapse_tool successfully collapsed tool');

    // Test error handling - expand without session
    const noSessionExpand = sessionManager.expandTool(
      'invalid-session',
      'filesystem',
      'read_file'
    );
    expect(noSessionExpand).toBe(false);
    console.log('  ✓ expand_tool handles invalid session gracefully');

    // Test error handling - expand without compression
    const noCompressionExpanded = sessionManager.expandTool(
      sessionId,
      'unknown',
      'unknown_tool'
    );
    expect(noCompressionExpanded).toBe(true); // Session manager allows it
    console.log('  ✓ expand_tool handles missing compression gracefully');

    console.log('\n✅ Management tools API workflow test passed!\n');
  });

  it('should handle concurrent session workflows', async () => {
    console.log('\n👥 Testing Concurrent Session Workflows');

    const filesystemTools = await filesystemClient.listTools();

    // Setup compression
    filesystemTools.tools.forEach((tool: any) => {
      const key = `filesystem:${tool.name}` as keyof typeof SAMPLE_COMPRESSIONS;
      const compression = SAMPLE_COMPRESSIONS[key];
      if (compression) {
        compressionCache.saveCompressed(
          'filesystem',
          tool.name,
          compression.compressed,
          tool.description
        );
      }
    });

    // Create 3 concurrent sessions
    const session1 = sessionManager.createSession();
    const session2 = sessionManager.createSession();
    const session3 = sessionManager.createSession();
    console.log('  ✓ Created 3 concurrent sessions');

    // Each session expands different tools
    sessionManager.expandTool(session1, 'filesystem', 'read_file');
    sessionManager.expandTool(session2, 'filesystem', 'write_file');
    sessionManager.expandTool(session3, 'filesystem', 'list_directory');
    console.log('  ✓ Each session expanded different tools');

    // Verify isolation
    expect(sessionManager.isToolExpanded(session1, 'filesystem', 'read_file')).toBe(true);
    expect(sessionManager.isToolExpanded(session1, 'filesystem', 'write_file')).toBe(false);
    expect(sessionManager.isToolExpanded(session1, 'filesystem', 'list_directory')).toBe(false);

    expect(sessionManager.isToolExpanded(session2, 'filesystem', 'read_file')).toBe(false);
    expect(sessionManager.isToolExpanded(session2, 'filesystem', 'write_file')).toBe(true);
    expect(sessionManager.isToolExpanded(session2, 'filesystem', 'list_directory')).toBe(false);

    expect(sessionManager.isToolExpanded(session3, 'filesystem', 'read_file')).toBe(false);
    expect(sessionManager.isToolExpanded(session3, 'filesystem', 'write_file')).toBe(false);
    expect(sessionManager.isToolExpanded(session3, 'filesystem', 'list_directory')).toBe(true);

    console.log('  ✓ All 3 sessions maintain independent state');
    console.log('\n✅ Concurrent session workflows test passed!\n');
  });
});
