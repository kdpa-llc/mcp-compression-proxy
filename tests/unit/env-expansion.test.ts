import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { writeFileSync, mkdirSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

async function importLoader() {
  const loaderPath = '../../src/config/loader.js';
  delete require.cache[require.resolve(loaderPath)];
  return await import(loaderPath);
}

/**
 * ${VAR} expansion in servers.json (#24).
 */
describe('config env var expansion', () => {
  let testDir: string;
  let originalCwd: string;
  let originalHome: string | undefined;
  let stderr: jest.SpiedFunction<typeof console.error>;

  const writeConfig = (env: Record<string, string>): void => {
    writeFileSync(
      join(testDir, 'servers.json'),
      JSON.stringify({
        mcpServers: [{ name: 'srv', command: 'cmd', env }],
      })
    );
  };

  beforeEach(() => {
    testDir = join(tmpdir(), `mcp-env-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(testDir, { recursive: true });

    originalCwd = process.cwd();
    originalHome = process.env.HOME;
    process.chdir(testDir);
    // Point the user-level config at an empty dir so only ./servers.json loads.
    process.env.HOME = testDir;

    stderr = jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    stderr.mockRestore();
    process.chdir(originalCwd);
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
    delete process.env.EXPANSION_TEST_VAR;
  });

  it('substitutes a variable that is set', async () => {
    process.env.EXPANSION_TEST_VAR = 'the-secret';
    writeConfig({ TOKEN: '${EXPANSION_TEST_VAR}' });

    const { loadJSONServers } = await importLoader();

    expect(loadJSONServers()?.servers[0].env?.TOKEN).toBe('the-secret');
  });

  it('warns instead of silently substituting an empty string', async () => {
    writeConfig({ TOKEN: '${EXPANSION_TEST_VAR}' });

    const { loadJSONServers } = await importLoader();
    loadJSONServers();

    // Silence here is what turned an unset variable into a confusing 401.
    const warnings = stderr.mock.calls
      .map((args) => String(args[0]))
      .filter((line) => line.includes('WARNING'));

    expect(warnings.length).toBeGreaterThan(0);
    expect(warnings[0]).toContain('EXPANSION_TEST_VAR');
  });

  it('names every unresolved variable', async () => {
    writeConfig({ A: '${EXPANSION_MISSING_ONE}', B: '${EXPANSION_MISSING_TWO}' });

    const { loadJSONServers } = await importLoader();
    loadJSONServers();

    const warning = stderr.mock.calls
      .map((args) => String(args[0]))
      .find((line) => line.includes('WARNING'));

    expect(warning).toContain('EXPANSION_MISSING_ONE');
    expect(warning).toContain('EXPANSION_MISSING_TWO');
  });

  it('does not warn when every variable resolves', async () => {
    process.env.EXPANSION_TEST_VAR = 'present';
    writeConfig({ TOKEN: '${EXPANSION_TEST_VAR}' });

    const { loadJSONServers } = await importLoader();
    loadJSONServers();

    const warnings = stderr.mock.calls
      .map((args) => String(args[0]))
      .filter((line) => line.includes('WARNING'));

    expect(warnings).toHaveLength(0);
  });

  describe('${VAR:-default}', () => {
    it('falls back when the variable is unset', async () => {
      writeConfig({ URL: '${EXPANSION_TEST_VAR:-https://example.test}' });

      const { loadJSONServers } = await importLoader();

      expect(loadJSONServers()?.servers[0].env?.URL).toBe('https://example.test');
    });

    it('prefers the variable when it is set', async () => {
      process.env.EXPANSION_TEST_VAR = 'https://real.test';
      writeConfig({ URL: '${EXPANSION_TEST_VAR:-https://example.test}' });

      const { loadJSONServers } = await importLoader();

      expect(loadJSONServers()?.servers[0].env?.URL).toBe('https://real.test');
    });

    it('does not warn about a variable that has a default', async () => {
      writeConfig({ URL: '${EXPANSION_TEST_VAR:-fallback}' });

      const { loadJSONServers } = await importLoader();
      loadJSONServers();

      const warnings = stderr.mock.calls
        .map((args) => String(args[0]))
        .filter((line) => line.includes('WARNING'));

      expect(warnings).toHaveLength(0);
    });

    it('supports an empty default', async () => {
      writeConfig({ URL: '${EXPANSION_TEST_VAR:-}' });

      const { loadJSONServers } = await importLoader();

      expect(loadJSONServers()?.servers[0].env?.URL).toBe('');
    });
  });

  it('treats $${VAR} as a literal', async () => {
    process.env.EXPANSION_TEST_VAR = 'should-not-appear';
    writeConfig({ TEMPLATE: '$${EXPANSION_TEST_VAR}' });

    const { loadJSONServers } = await importLoader();

    expect(loadJSONServers()?.servers[0].env?.TEMPLATE).toBe('${EXPANSION_TEST_VAR}');
  });
});
