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
});
