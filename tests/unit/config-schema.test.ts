import { describe, it, expect } from '@jest/globals';
import { readFileSync } from 'fs';
import { join } from 'path';
import Ajv from 'ajv';
import { serverConfigSchema } from '../../src/config/schema.js';

const ajv = new Ajv({ allErrors: true });
const validate = ajv.compile(serverConfigSchema);

const base = { mcpServers: [{ name: 'srv', command: 'cmd' }] };

describe('server config schema', () => {
  it('accepts the shipped example config', () => {
    const example = JSON.parse(
      readFileSync(join(process.cwd(), 'servers.json.example'), 'utf-8')
    );

    // The example is what users copy; a drift between it and the schema
    // means the documented starting point fails validation.
    expect(validate(example)).toBe(true);
  });

  describe('inheritEnv', () => {
    it.each([true, false])('accepts the boolean %s', (value) => {
      expect(validate({ ...base, inheritEnv: value })).toBe(true);
    });

    it('accepts an allowlist of variable names', () => {
      expect(validate({ ...base, inheritEnv: ['HOME', 'PATH'] })).toBe(true);
    });

    it('rejects a non-string allowlist', () => {
      expect(validate({ ...base, inheritEnv: [1, 2] })).toBe(false);
    });

    it('rejects an unsupported type', () => {
      expect(validate({ ...base, inheritEnv: 'all' })).toBe(false);
    });

    it('accepts a per-server override', () => {
      expect(
        validate({ mcpServers: [{ name: 'srv', command: 'cmd', inheritEnv: false }] })
      ).toBe(true);
    });
  });

  describe('remote (HTTP) servers', () => {
    it('accepts a url-only entry', () => {
      expect(
        validate({
          mcpServers: [
            {
              name: 'remote',
              url: 'https://mcp.example.com/mcp',
              headers: { Authorization: 'Bearer ${TOKEN}' },
              enabled: true,
              timeout: 30,
            },
          ],
        })
      ).toBe(true);
    });

    it('rejects an entry with neither command nor url', () => {
      expect(validate({ mcpServers: [{ name: 'nothing' }] })).toBe(false);
    });

    it('rejects command and url together', () => {
      // `oneOf` gives this for free - exactly one branch may match.
      expect(
        validate({
          mcpServers: [{ name: 'both', command: 'npx', url: 'https://example.com/mcp' }],
        })
      ).toBe(false);
    });

    it('rejects non-string header values', () => {
      expect(
        validate({
          mcpServers: [{ name: 'remote', url: 'https://example.com/mcp', headers: { A: 1 } }],
        })
      ).toBe(false);
    });
  });

  describe('unknown server fields', () => {
    it('rejects a misspelled field instead of silently ignoring it', () => {
      // Pre-strictness this validated, and the server just never started.
      expect(validate({ mcpServers: [{ name: 'srv', comand: 'npx' }] })).toBe(false);
    });

    it('still accepts the legacy type and autoApprove fields', () => {
      expect(
        validate({
          mcpServers: [
            { name: 'srv', command: 'cmd', type: 'stdio', autoApprove: ['srv__read'] },
          ],
        })
      ).toBe(true);
    });
  });

  describe('compressionFallbackBehavior', () => {
    it.each(['original', 'blank'])('accepts %s', (value) => {
      expect(validate({ ...base, compressionFallbackBehavior: value })).toBe(true);
    });

    it('rejects an unknown value with a clear error', () => {
      expect(validate({ ...base, compressionFallbackBehavior: 'hidden' })).toBe(false);

      const error = validate.errors?.find((e) =>
        e.instancePath.includes('compressionFallbackBehavior')
      );
      expect(error).toBeDefined();
      expect(error?.keyword).toBe('enum');
    });

    it('is optional, so existing configs stay valid', () => {
      expect(validate(base)).toBe(true);
    });
  });

  describe('connection lifecycle', () => {
    it('accepts global and per-server lifecycle settings', () => {
      expect(validate({
        ...base,
        softMaxConnectionAgeSeconds: 3600,
        hardMaxConnectionAgeSeconds: 28_800,
        authErrorPatterns: ['midway login page'],
        authRetryTools: ['InternalSearch'],
      })).toBe(true);

      expect(validate({
        mcpServers: [{
          name: 'srv',
          command: 'cmd',
          softMaxConnectionAgeSeconds: 900,
          hardMaxConnectionAgeSeconds: 7200,
          authErrorPatterns: ['expired'],
          authRetryTools: ['Read*'],
        }],
      })).toBe(true);
    });

    it.each([
      { softMaxConnectionAgeSeconds: -1 },
      { hardMaxConnectionAgeSeconds: -1 },
      { authErrorPatterns: [1] },
      { authRetryTools: [false] },
    ])('rejects invalid lifecycle settings: %j', (settings) => {
      expect(validate({ ...base, ...settings })).toBe(false);
    });

    it('accepts the legacy maxConnectionAgeSeconds alias', () => {
      expect(validate({ ...base, maxConnectionAgeSeconds: 3600 })).toBe(true);
    });
  });
});
