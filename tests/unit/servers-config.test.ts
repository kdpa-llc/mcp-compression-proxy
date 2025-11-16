import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { getEnabledServers, mcpServers } from '../../src/config/servers.js';
import { writeFileSync, unlinkSync, existsSync, mkdirSync, rmdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

describe('Server Configuration', () => {
  let testDir: string;
  let originalCwd: string;
  let originalHome: string;
  let consoleWarnSpy: jest.SpiedFunction<typeof console.warn>;

  beforeEach(() => {
    // Create temp directory for tests
    testDir = join(tmpdir(), `mcp-test-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });

    // Save original values
    originalCwd = process.cwd();
    originalHome = process.env.HOME || '';

    // Change to test directory (ensures no JSON config is found)
    process.chdir(testDir);
    process.env.HOME = testDir;

    // Spy on console.warn to suppress and verify deprecation warnings
    consoleWarnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    // Restore original values
    process.chdir(originalCwd);
    process.env.HOME = originalHome;

    // Restore console.warn
    consoleWarnSpy.mockRestore();

    // Clean up test directory
    if (existsSync(testDir)) {
      const files = ['servers.json', '.mcp-aggregator/servers.json'];
      files.forEach(file => {
        const path = join(testDir, file);
        if (existsSync(path)) {
          unlinkSync(path);
        }
      });

      const aggregatorDir = join(testDir, '.mcp-aggregator');
      if (existsSync(aggregatorDir)) {
        rmdirSync(aggregatorDir);
      }

      rmdirSync(testDir);
    }
  });

  describe('mcpServers (TypeScript config)', () => {
    it('should export an array of server configurations', () => {
      expect(Array.isArray(mcpServers)).toBe(true);
    });

    it('should have valid server configuration structure', () => {
      mcpServers.forEach((server) => {
        expect(server).toHaveProperty('name');
        expect(server).toHaveProperty('command');
        expect(typeof server.name).toBe('string');
        expect(typeof server.command).toBe('string');
      });
    });
  });

  describe('getEnabledServers (Backward Compatibility)', () => {
    it('should use TypeScript config when no JSON config exists', () => {
      const enabled = getEnabledServers();

      expect(Array.isArray(enabled)).toBe(true);
      enabled.forEach((server) => {
        expect(server.enabled).not.toBe(false);
      });

      // Should show deprecation warning
      expect(consoleWarnSpy).toHaveBeenCalledWith(
        expect.stringContaining('deprecated TypeScript configuration')
      );
    });

    it('should filter out disabled servers from TypeScript config', () => {
      const allServers = mcpServers;
      const enabledServers = getEnabledServers();

      const disabledCount = allServers.filter(s => s.enabled === false).length;
      expect(enabledServers.length).toBe(allServers.length - disabledCount);
    });

    it('should return servers with enabled=true from TypeScript config', () => {
      const enabled = getEnabledServers();

      // All returned servers should either have enabled=true or enabled=undefined
      expect(enabled.every(s => s.enabled === true || s.enabled === undefined)).toBe(true);
    });

    it('should prefer JSON config over TypeScript config', () => {
      const jsonConfig = {
        mcpServers: [
          {
            name: 'json-server',
            command: 'npx',
            args: ['test'],
            enabled: true,
          },
        ],
      };

      writeFileSync(join(testDir, 'servers.json'), JSON.stringify(jsonConfig));

      const enabled = getEnabledServers();

      expect(enabled).toHaveLength(1);
      expect(enabled[0].name).toBe('json-server');

      // Should NOT show deprecation warning when JSON config is used
      expect(consoleWarnSpy).not.toHaveBeenCalledWith(
        expect.stringContaining('deprecated TypeScript configuration')
      );
    });

    it('should handle JSON config from user directory', () => {
      const userConfigDir = join(testDir, '.mcp-aggregator');
      mkdirSync(userConfigDir, { recursive: true });

      const jsonConfig = {
        mcpServers: [
          {
            name: 'user-json-server',
            command: 'node',
          },
        ],
      };

      writeFileSync(join(userConfigDir, 'servers.json'), JSON.stringify(jsonConfig));

      const enabled = getEnabledServers();

      expect(enabled).toHaveLength(1);
      expect(enabled[0].name).toBe('user-json-server');
    });
  });
});
