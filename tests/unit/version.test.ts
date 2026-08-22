import { describe, it, expect } from '@jest/globals';
import { readFileSync } from 'fs';
import { join } from 'path';
import { SERVER_NAME, VERSION } from '../../src/version.js';

describe('version', () => {
  it('stays in sync with package.json', () => {
    const pkg = JSON.parse(
      readFileSync(join(process.cwd(), 'package.json'), 'utf-8')
    ) as { version: string };

    // If this fails, run `npm run sync-version`.
    expect(VERSION).toBe(pkg.version);
  });

  it('reports the published package name', () => {
    const pkg = JSON.parse(
      readFileSync(join(process.cwd(), 'package.json'), 'utf-8')
    ) as { name: string };

    expect(SERVER_NAME).toBe(pkg.name);
  });

  it('is a valid semver string', () => {
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/);
  });
});
