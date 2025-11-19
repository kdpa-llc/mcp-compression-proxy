import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { writeFileSync, unlinkSync, existsSync, mkdirSync, rmdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import type { MCPServerConfig } from '../../src/types/index.js';

// We need to dynamically import to reset the module cache
async function importLoader() {
  // Clear module cache to get fresh imports
  const loaderPath = '../../src/config/loader.js';
  delete require.cache[require.resolve(loaderPath)];
  return await import(loaderPath);
}

describe('Config Loader', () => {
  let testDir: string;
  let originalCwd: string;
  let originalHome: string;

  beforeEach(() => {
    // Create temp directory for tests
    testDir = join(tmpdir(), `mcp-test-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });

    // Save original values
    originalCwd = process.cwd();
    originalHome = process.env.HOME || '';

    // Change to test directory
    process.chdir(testDir);
    process.env.HOME = testDir;
  });

  afterEach(() => {
    // Restore original values
    process.chdir(originalCwd);
    process.env.HOME = originalHome;

    // Clean up test directory
    if (existsSync(testDir)) {
      const files = ['servers.json', '.mcp-compression-proxy/servers.json'];
      files.forEach(file => {
        const path = join(testDir, file);
        if (existsSync(path)) {
          unlinkSync(path);
        }
      });

      const aggregatorDir = join(testDir, '.mcp-compression-proxy');
      if (existsSync(aggregatorDir)) {
        rmdirSync(aggregatorDir);
      }

      rmdirSync(testDir);
    }
  });

  describe('loadJSONServers', () => {
    it('should return null when no config files exist', async () => {
      const { loadJSONServers } = await importLoader();
      const result = loadJSONServers();
      expect(result).toBeNull();
    });

    it('should load exclude patterns from user config', async () => {
      const userConfigDir = join(testDir, '.mcp-compression-proxy');
      mkdirSync(userConfigDir, { recursive: true });

      const config = {
        mcpServers: [
          { name: 'test-server', command: 'npx' },
        ],
        excludeTools: ['test__*', '*__delete*'],
      };

      writeFileSync(join(userConfigDir, 'servers.json'), JSON.stringify(config));

      const { loadJSONServers } = await importLoader();
      const result = loadJSONServers();

      expect(result).not.toBeNull();
      expect(result!.excludePatterns).toEqual(['test__*', '*__delete*']);
    });

    it('should aggregate exclude patterns from user and project configs', async () => {
      const userConfigDir = join(testDir, '.mcp-compression-proxy');
      mkdirSync(userConfigDir, { recursive: true});

      const userConfig = {
        mcpServers: [{ name: 'user-server', command: 'node' }],
        excludeTools: ['user__*'],
      };

      const projectConfig = {
        mcpServers: [{ name: 'project-server', command: 'npx' }],
        excludeTools: ['*__delete*', 'test__*'],
      };

      writeFileSync(join(userConfigDir, 'servers.json'), JSON.stringify(userConfig));
      writeFileSync(join(testDir, 'servers.json'), JSON.stringify(projectConfig));

      const { loadJSONServers } = await importLoader();
      const result = loadJSONServers();

      expect(result).not.toBeNull();
      expect(result!.excludePatterns).toEqual(['user__*', '*__delete*', 'test__*']);
    });

    it('should load valid JSON config from project directory', async () => {
      const config = {
        mcpServers: [
          {
            name: 'test-server',
            command: 'npx',
            args: ['test'],
            enabled: true,
          },
        ],
      };

      writeFileSync(join(testDir, 'servers.json'), JSON.stringify(config));

      const { loadJSONServers } = await importLoader();
      const result = loadJSONServers();

      expect(result).not.toBeNull();
      expect(result!.servers).toHaveLength(1);
      expect(result!.servers[0].name).toBe('test-server');
    });

    it('should load valid JSON config from user directory', async () => {
      const userConfigDir = join(testDir, '.mcp-compression-proxy');
      mkdirSync(userConfigDir, { recursive: true });

      const config = {
        mcpServers: [
          {
            name: 'user-server',
            command: 'node',
          },
        ],
      };

      writeFileSync(join(userConfigDir, 'servers.json'), JSON.stringify(config));

      const { loadJSONServers } = await importLoader();
      const result = loadJSONServers();

      expect(result).not.toBeNull();
      expect(result!.servers).toHaveLength(1);
      expect(result!.servers[0].name).toBe('user-server');
    });

    it('should aggregate user and project configs', async () => {
      const userConfigDir = join(testDir, '.mcp-compression-proxy');
      mkdirSync(userConfigDir, { recursive: true });

      const projectConfig = {
        mcpServers: [{ name: 'project-server', command: 'npx' }],
      };
      const userConfig = {
        mcpServers: [{ name: 'user-server', command: 'npx' }],
      };

      writeFileSync(join(testDir, 'servers.json'), JSON.stringify(projectConfig));
      writeFileSync(join(userConfigDir, 'servers.json'), JSON.stringify(userConfig));

      const { loadJSONServers } = await importLoader();
      const result = loadJSONServers();

      expect(result).not.toBeNull();
      expect(result!.servers).toHaveLength(2);
      expect(result!.servers.map((s: MCPServerConfig) => s.name)).toEqual(['user-server', 'project-server']);
    });

    it('should expand environment variables', async () => {
      process.env.TEST_TOKEN = 'secret123';

      const config = {
        mcpServers: [
          {
            name: 'test-server',
            command: 'npx',
            env: {
              TOKEN: '${TEST_TOKEN}',
              STATIC: 'value',
            },
          },
        ],
      };

      writeFileSync(join(testDir, 'servers.json'), JSON.stringify(config));

      const { loadJSONServers } = await importLoader();
      const result = loadJSONServers();

      expect(result).not.toBeNull();
      expect(result!.servers[0].env?.TOKEN).toBe('secret123');
      expect(result!.servers[0].env?.STATIC).toBe('value');

      delete process.env.TEST_TOKEN;
    });

    it('should expand environment variables in args', async () => {
      process.env.TEST_PATH = '/test/path';

      const config = {
        mcpServers: [
          {
            name: 'test-server',
            command: 'npx',
            args: ['--path', '${TEST_PATH}'],
          },
        ],
      };

      writeFileSync(join(testDir, 'servers.json'), JSON.stringify(config));

      const { loadJSONServers } = await importLoader();
      const result = loadJSONServers();

      expect(result).not.toBeNull();
      expect(result!.servers[0].args).toEqual(['--path', '/test/path']);

      delete process.env.TEST_PATH;
    });

    it('should throw error for invalid JSON', async () => {
      writeFileSync(join(testDir, 'servers.json'), '{ invalid json }');

      const { loadJSONServers } = await importLoader();

      expect(() => loadJSONServers()).toThrow('Invalid JSON');
    });

    it('should throw error for invalid schema', async () => {
      const invalidConfig = {
        mcpServers: [
          {
            // Missing required 'command' field
            name: 'test-server',
          },
        ],
      };

      writeFileSync(join(testDir, 'servers.json'), JSON.stringify(invalidConfig));

      const { loadJSONServers } = await importLoader();

      expect(() => loadJSONServers()).toThrow('Invalid server configuration');
    });

    it('should validate server name is not empty', async () => {
      const invalidConfig = {
        mcpServers: [
          {
            name: '',
            command: 'npx',
          },
        ],
      };

      writeFileSync(join(testDir, 'servers.json'), JSON.stringify(invalidConfig));

      const { loadJSONServers } = await importLoader();

      expect(() => loadJSONServers()).toThrow('Invalid server configuration');
    });

    it('should handle servers with minimal required fields', async () => {
      const config = {
        mcpServers: [
          {
            name: 'minimal-server',
            command: 'node',
          },
        ],
      };

      writeFileSync(join(testDir, 'servers.json'), JSON.stringify(config));

      const { loadJSONServers } = await importLoader();
      const result = loadJSONServers();

      expect(result).not.toBeNull();
      expect(result!.servers[0].name).toBe('minimal-server');
      expect(result!.servers[0].command).toBe('node');
      expect(result!.servers[0].args).toBeUndefined();
      expect(result!.servers[0].env).toBeUndefined();
      expect(result!.servers[0].enabled).toBeUndefined();
    });

    it('should handle disabled servers', async () => {
      const config = {
        mcpServers: [
          {
            name: 'enabled-server',
            command: 'npx',
            enabled: true,
          },
          {
            name: 'disabled-server',
            command: 'npx',
            enabled: false,
          },
        ],
      };

      writeFileSync(join(testDir, 'servers.json'), JSON.stringify(config));

      const { loadJSONServers } = await importLoader();
      const result = loadJSONServers();

      expect(result).not.toBeNull();
      expect(result!.servers).toHaveLength(2);
      expect(result!.servers[0].enabled).toBe(true);
      expect(result!.servers[1].enabled).toBe(false);
    });

    it('should allow additional properties', async () => {
      const configWithAdditionalProps = {
        mcpServers: [
          {
            name: 'test-server',
            command: 'npx',
            customField: 'additional property should be allowed',
            anotherField: 42,
          },
        ],
      };

      writeFileSync(join(testDir, 'servers.json'), JSON.stringify(configWithAdditionalProps));

      const { loadJSONServers } = await importLoader();

      expect(() => loadJSONServers()).not.toThrow();
      
      const result = loadJSONServers();
      expect(result).not.toBeNull();
      expect(result!.servers[0].name).toBe('test-server');
      expect((result!.servers[0] as any).customField).toBe('additional property should be allowed');
    });

    it('should handle empty environment variable substitution', async () => {
      const config = {
        mcpServers: [
          {
            name: 'test-server',
            command: 'npx',
            env: {
              MISSING_VAR: '${NONEXISTENT_VAR}',
            },
          },
        ],
      };

      writeFileSync(join(testDir, 'servers.json'), JSON.stringify(config));

      const { loadJSONServers } = await importLoader();
      const result = loadJSONServers();

      expect(result).not.toBeNull();
      expect(result!.servers[0].env?.MISSING_VAR).toBe('');
    });

    it('should load noCompress patterns from user config', async () => {
      const userConfigDir = join(testDir, '.mcp-compression-proxy');
      mkdirSync(userConfigDir, { recursive: true });

      const config = {
        mcpServers: [
          { name: 'test-server', command: 'npx' },
        ],
        noCompressTools: ['filesystem__*', '*__verbose*'],
      };

      writeFileSync(join(userConfigDir, 'servers.json'), JSON.stringify(config));

      const { loadJSONServers } = await importLoader();
      const result = loadJSONServers();

      expect(result).not.toBeNull();
      expect(result!.noCompressPatterns).toEqual(['filesystem__*', '*__verbose*']);
    });

    it('should aggregate both exclude and noCompress patterns', async () => {
      const userConfigDir = join(testDir, '.mcp-compression-proxy');
      mkdirSync(userConfigDir, { recursive: true });

      const userConfig = {
        mcpServers: [{ name: 'user-server', command: 'node' }],
        excludeTools: ['user__*'],
        noCompressTools: ['filesystem__*'],
      };

      const projectConfig = {
        mcpServers: [{ name: 'project-server', command: 'npx' }],
        excludeTools: ['*__delete*'],
        noCompressTools: ['*__verbose*'],
      };

      writeFileSync(join(userConfigDir, 'servers.json'), JSON.stringify(userConfig));
      writeFileSync(join(testDir, 'servers.json'), JSON.stringify(projectConfig));

      const { loadJSONServers } = await importLoader();
      const result = loadJSONServers();

      expect(result).not.toBeNull();
      expect(result!.excludePatterns).toEqual(['user__*', '*__delete*']);
      expect(result!.noCompressPatterns).toEqual(['filesystem__*', '*__verbose*']);
    });
  });

  describe('getConfigPath', () => {
    it('should return user config path', async () => {
      const { getConfigPath } = await importLoader();
      const path = getConfigPath();

      expect(path).toContain('.mcp-compression-proxy');
      expect(path).toContain('servers.json');
    });
  });
});
