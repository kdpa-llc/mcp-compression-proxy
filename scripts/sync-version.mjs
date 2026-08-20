#!/usr/bin/env node
/**
 * Rewrites the VERSION constant in src/version.ts to match package.json.
 *
 * Run by semantic-release (via @semantic-release/exec) after it bumps the
 * manifest, so the version advertised over MCP matches the published package.
 * Safe to run manually: it is a no-op when the two already agree.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const versionFile = join(root, 'src', 'version.ts');

const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf-8'));
const source = readFileSync(versionFile, 'utf-8');

const pattern = /^export const VERSION = '.*';$/m;
if (!pattern.test(source)) {
  console.error(`sync-version: could not find the VERSION declaration in ${versionFile}`);
  process.exit(1);
}

const updated = source.replace(pattern, `export const VERSION = '${version}';`);

if (updated === source) {
  console.log(`sync-version: src/version.ts already at ${version}`);
} else {
  writeFileSync(versionFile, updated, 'utf-8');
  console.log(`sync-version: updated src/version.ts to ${version}`);
}
