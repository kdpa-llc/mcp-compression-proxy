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
    // Prefix, pid and a random suffix, not just a timestamp: this suite and
    // compression-persistence both used `mcp-test-<ms>`, so two beforeEach
    // calls landing in the same millisecond in parallel workers shared a
    // directory and clobbered each other's fixtures. This suite chdir's into
    // it and writes servers.json, so losing the race meant a config that
    // should have thrown simply was not there to load.
    testDir = join(
      tmpdir(),
      `mcp-loader-test-${Date.now()}-${process.pid}-${Math.random().toString(36).slice(2)}`
    );
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

    it('should warn about unknown server properties without failing', async () => {
      // A misspelled *required* key is already caught by the schema's oneOf, so
      // strictness here would only cover optional ones - at the price of
      // failing every server over a field copied from another MCP client's
      // config format. Warn loudly, keep running.
      const configWithUnknownProps = {
        mcpServers: [
          {
            name: 'test-server',
            command: 'npx',
            disabled: true,
            timout: 60,
          },
        ],
      };

      writeFileSync(join(testDir, 'servers.json'), JSON.stringify(configWithUnknownProps));

      const warnings: string[] = [];
      const spy = jest.spyOn(console, 'error').mockImplementation((msg: unknown) => {
        warnings.push(String(msg));
      });

      const { loadJSONServers } = await importLoader();
      const result = loadJSONServers();

      spy.mockRestore();

      expect(result!.servers).toHaveLength(1);
      expect(result!.servers[0].name).toBe('test-server');

      const warning = warnings.find((line) => line.includes('unrecognized field'));
      expect(warning).toBeDefined();
      expect(warning).toContain('test-server');
      expect(warning).toContain('disabled');
      expect(warning).toContain('timout');
    });

    it('should not warn when every server field is recognized', async () => {
      writeFileSync(
        join(testDir, 'servers.json'),
        JSON.stringify({
          mcpServers: [
            { name: 'clean', command: 'npx', args: ['-y'], timeout: 30, enabled: true },
          ],
        })
      );

      const warnings: string[] = [];
      const spy = jest.spyOn(console, 'error').mockImplementation((msg: unknown) => {
        warnings.push(String(msg));
      });

      const { loadJSONServers } = await importLoader();
      loadJSONServers();

      spy.mockRestore();

      expect(warnings.some((line) => line.includes('unrecognized field'))).toBe(false);
    });

    it('should load per-server timeout configuration', async () => {
      const config = {
        mcpServers: [
          {
            name: 'fast-server',
            command: 'npx',
            timeout: 10,
          },
          {
            name: 'slow-server',
            command: 'npx',
            timeout: 120,
          },
          {
            name: 'default-server',
            command: 'npx',
            // No timeout - will use default
          },
        ],
      };

      writeFileSync(join(testDir, 'servers.json'), JSON.stringify(config));

      const { loadJSONServers } = await importLoader();
      const result = loadJSONServers();

      expect(result).not.toBeNull();
      expect(result!.servers).toHaveLength(3);
      expect(result!.servers[0].timeout).toBe(10);
      expect(result!.servers[1].timeout).toBe(120);
      expect(result!.servers[2].timeout).toBeUndefined();
    });

    it('should load global defaultTimeout configuration', async () => {
      const config = {
        defaultTimeout: 45,
        mcpServers: [
          {
            name: 'test-server',
            command: 'npx',
          },
        ],
      };

      writeFileSync(join(testDir, 'servers.json'), JSON.stringify(config));

      const { loadJSONServers } = await importLoader();
      const result = loadJSONServers();

      expect(result).not.toBeNull();
      expect(result!.defaultTimeout).toBe(45);
    });

    it('should prioritize project-level defaultTimeout over user-level', async () => {
      const userConfig = {
        defaultTimeout: 30,
        mcpServers: [
          {
            name: 'user-server',
            command: 'npx',
          },
        ],
      };

      const projectConfig = {
        defaultTimeout: 60,
        mcpServers: [
          {
            name: 'project-server',
            command: 'npx',
          },
        ],
      };

      mkdirSync(join(testDir, '.mcp-compression-proxy'), { recursive: true });
      writeFileSync(
        join(testDir, '.mcp-compression-proxy', 'servers.json'),
        JSON.stringify(userConfig)
      );
      writeFileSync(join(testDir, 'servers.json'), JSON.stringify(projectConfig));

      const { loadJSONServers } = await importLoader();
      const result = loadJSONServers();

      expect(result).not.toBeNull();
      expect(result!.defaultTimeout).toBe(60); // Project config wins
      expect(result!.servers).toHaveLength(2); // Both servers present
    });

    it('loads lifecycle defaults and lets project configuration override them', async () => {
      const userConfig = {
        softMaxConnectionAgeSeconds: 7200,
        hardMaxConnectionAgeSeconds: 43_200,
        authErrorPatterns: ['user auth'],
        authRetryTools: ['UserRead'],
        mcpServers: [{ name: 'user-server', command: 'npx' }],
      };
      const projectConfig = {
        softMaxConnectionAgeSeconds: 3600,
        hardMaxConnectionAgeSeconds: 28_800,
        authErrorPatterns: ['project auth'],
        authRetryTools: ['InternalSearch'],
        mcpServers: [{ name: 'project-server', command: 'npx' }],
      };

      mkdirSync(join(testDir, '.mcp-compression-proxy'), { recursive: true });
      writeFileSync(
        join(testDir, '.mcp-compression-proxy', 'servers.json'),
        JSON.stringify(userConfig)
      );
      writeFileSync(join(testDir, 'servers.json'), JSON.stringify(projectConfig));

      const { loadJSONServers } = await importLoader();
      const result = loadJSONServers();

      expect(result).toEqual(expect.objectContaining({
        softMaxConnectionAgeSeconds: 3600,
        hardMaxConnectionAgeSeconds: 28_800,
        authErrorPatterns: ['project auth'],
        authRetryTools: ['InternalSearch'],
      }));
    });

    it('uses maxConnectionAgeSeconds as a legacy soft-age alias', async () => {
      writeFileSync(join(testDir, 'servers.json'), JSON.stringify({
        maxConnectionAgeSeconds: 1800,
        mcpServers: [{ name: 'legacy-server', command: 'npx' }],
      }));

      const { loadJSONServers } = await importLoader();
      const result = loadJSONServers();

      expect(result?.softMaxConnectionAgeSeconds).toBe(1800);
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

  describe('remote (HTTP) servers', () => {
    const writeProjectConfig = (server: Record<string, unknown>): void => {
      writeFileSync(
        join(testDir, 'servers.json'),
        JSON.stringify({ mcpServers: [server] })
      );
    };

    it('should load a url-only server', async () => {
      writeProjectConfig({
        name: 'remote',
        url: 'https://mcp.example.com/mcp',
        enabled: true,
      });

      const { loadJSONServers } = await importLoader();
      const result = loadJSONServers();

      expect(result!.servers[0].url).toBe('https://mcp.example.com/mcp');
      expect(result!.servers[0].command).toBeUndefined();
    });

    it('should expand ${VAR} in header values', async () => {
      // No expansion code was written for headers - this asserts the generic
      // recursion already covers them, so it stays covered if that changes.
      process.env.REMOTE_TEST_TOKEN = 'header-secret';

      writeProjectConfig({
        name: 'remote',
        url: 'https://mcp.example.com/mcp',
        headers: { Authorization: 'Bearer ${REMOTE_TEST_TOKEN}' },
      });

      const { loadJSONServers } = await importLoader();
      const result = loadJSONServers();

      expect(result!.servers[0].headers?.Authorization).toBe('Bearer header-secret');

      delete process.env.REMOTE_TEST_TOKEN;
    });

    it('should reject url combined with command', async () => {
      writeProjectConfig({
        name: 'confused',
        command: 'npx',
        url: 'https://mcp.example.com/mcp',
      });

      const { loadJSONServers } = await importLoader();

      expect(() => loadJSONServers()).toThrow('Invalid server configuration');
    });

    it.each(['args', 'env', 'inheritEnv'])(
      'should reject url combined with %s, naming the field',
      async (field) => {
        const stdioOnly: Record<string, unknown> = {
          args: ['--flag'],
          env: { TOKEN: 'x' },
          inheritEnv: false,
        };

        writeProjectConfig({
          name: 'confused',
          url: 'https://mcp.example.com/mcp',
          [field]: stdioOnly[field],
        });

        const { loadJSONServers } = await importLoader();

        expect(() => loadJSONServers()).toThrow(
          expect.objectContaining({
            message: expect.stringContaining(field) as unknown as string,
          })
        );
        expect(() => loadJSONServers()).toThrow('confused');
      }
    );

    it('should reject headers combined with command', async () => {
      // The mirror of the checks above: headers are an HTTP concept, so on a
      // spawned server they would be dropped in silence.
      writeProjectConfig({
        name: 'confused',
        command: 'npx',
        headers: { Authorization: 'Bearer x' },
      });

      const { loadJSONServers } = await importLoader();

      expect(() => loadJSONServers()).toThrow(
        expect.objectContaining({
          message: expect.stringContaining('headers') as unknown as string,
        })
      );
      expect(() => loadJSONServers()).toThrow('confused');
    });

    it('should still accept a stdio server with env and no headers', async () => {
      writeProjectConfig({
        name: 'plain',
        command: 'npx',
        env: { TOKEN: 'x' },
      });

      const { loadJSONServers } = await importLoader();

      expect(() => loadJSONServers()).not.toThrow();
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
