import { describe, it, expect, afterEach } from '@jest/globals';
import { existsSync, unlinkSync, readFileSync, writeFileSync } from 'fs';
import { resolve } from 'path';

describe('File Exchange Functionality', () => {
  const testOutputFile = resolve('./test-output.json');
  const testInputFile = resolve('./test-input.json');

  afterEach(() => {
    // Clean up test files
    if (existsSync(testOutputFile)) {
      unlinkSync(testOutputFile);
    }
    if (existsSync(testInputFile)) {
      unlinkSync(testInputFile);
    }
  });

  describe('File I/O Operations', () => {
    it('should write and read tools JSON correctly', () => {
      const toolsData = [
        {
          serverName: 'filesystem',
          toolName: 'read_file',
          description: 'Read file from filesystem with specific path and encoding options...',
        },
        {
          serverName: 'github', 
          toolName: 'create_issue',
          description: 'Create a new GitHub issue with title, body, labels, and assignees...',
        },
      ];

      // Test writing to output file (get_uncompressed_tools behavior)
      writeFileSync(testOutputFile, JSON.stringify(toolsData, null, 2), 'utf-8');
      expect(existsSync(testOutputFile)).toBe(true);

      // Test reading from input file (cache_compressed_tools behavior)
      const fileContent = readFileSync(testOutputFile, 'utf-8');
      const parsedContent = JSON.parse(fileContent);

      expect(Array.isArray(parsedContent)).toBe(true);
      expect(parsedContent).toHaveLength(2);
      expect(parsedContent[0]).toEqual({
        serverName: 'filesystem',
        toolName: 'read_file',
        description: 'Read file from filesystem with specific path and encoding options...',
      });
      expect(parsedContent[1]).toEqual({
        serverName: 'github',
        toolName: 'create_issue', 
        description: 'Create a new GitHub issue with title, body, labels, and assignees...',
      });
    });

    it('should handle compressed descriptions workflow', () => {
      // Original tools (what get_uncompressed_tools would output)
      const originalTools = [
        {
          serverName: 'filesystem',
          toolName: 'read_file',
          description: 'Reads the complete contents of a file at the specified path. The file contents are returned as a string. This tool can handle files up to 10MB in size.',
        },
      ];

      // Write original tools to file
      writeFileSync(testInputFile, JSON.stringify(originalTools, null, 2), 'utf-8');

      // Read and compress (simulating LLM processing)
      const fileContent = readFileSync(testInputFile, 'utf-8');
      const tools = JSON.parse(fileContent);
      
      // Compress the description
      tools[0].description = 'Read file (text, max 10MB)';

      // Write compressed tools back
      writeFileSync(testInputFile, JSON.stringify(tools, null, 2), 'utf-8');

      // Verify compressed content
      const compressedContent = JSON.parse(readFileSync(testInputFile, 'utf-8'));
      expect(compressedContent[0].description).toBe('Read file (text, max 10MB)');
    });

    it('should handle invalid JSON gracefully', () => {
      writeFileSync(testInputFile, '{ invalid: json }', 'utf-8');

      expect(() => {
        const content = readFileSync(testInputFile, 'utf-8');
        JSON.parse(content);
      }).toThrow();
    });

    it('should handle non-array JSON gracefully', () => {
      const nonArrayData = { not: 'array', data: 'object' };
      writeFileSync(testInputFile, JSON.stringify(nonArrayData), 'utf-8');

      const content = readFileSync(testInputFile, 'utf-8');
      const parsed = JSON.parse(content);
      
      expect(Array.isArray(parsed)).toBe(false);
      expect(parsed).toEqual(nonArrayData);
    });

    it('should handle empty array', () => {
      writeFileSync(testInputFile, JSON.stringify([]), 'utf-8');

      const content = readFileSync(testInputFile, 'utf-8');
      const parsed = JSON.parse(content);
      
      expect(Array.isArray(parsed)).toBe(true);
      expect(parsed).toHaveLength(0);
    });

    it('should preserve tool metadata in round-trip', () => {
      const toolsWithMetadata = [
        {
          serverName: 'complex-server',
          toolName: 'complex_tool_with_underscores',
          description: 'A very detailed description with\nmultiple lines\nand special characters: !@#$%^&*()',
        },
      ];

      // Write and read back
      writeFileSync(testInputFile, JSON.stringify(toolsWithMetadata, null, 2), 'utf-8');
      const roundTrip = JSON.parse(readFileSync(testInputFile, 'utf-8'));

      expect(roundTrip).toEqual(toolsWithMetadata);
      expect(roundTrip[0].serverName).toBe('complex-server');
      expect(roundTrip[0].toolName).toBe('complex_tool_with_underscores');
      expect(roundTrip[0].description).toContain('\n');
    });
  });
});
