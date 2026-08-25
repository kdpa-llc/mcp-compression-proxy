#!/usr/bin/env node
/**
 * Verify that release notes can actually be generated.
 *
 * Why this exists rather than `semantic-release --dry-run`: on a pull request
 * semantic-release sees a non-release branch and exits 0 before it ever
 * reaches generateNotes, so a dry run proves nothing about the step that
 * actually breaks. It also wants registry auth, which a fork PR does not have.
 *
 * The seam this guards: .releaserc.json names the preset as a string, and the
 * plugin resolves it by name at runtime from whatever sits at the root of
 * node_modules. @semantic-release/release-notes-generator pins
 * conventional-changelog-writer to ^8, but preset 10 requires writer 9+. When
 * a bump hoists the newer preset, generateNotes dies with:
 *
 *   Missing helper: "conventional-changelog-conventionalcommits requires
 *   conventional-changelog-writer@9 or newer"
 *
 * That happened here. It broke the first 1.0.0 release *after* npm publish had
 * already succeeded, and every CI check was green at the time because nothing
 * exercised note generation.
 *
 * This calls the plugin's own exported generateNotes with the real config from
 * .releaserc.json, so it exercises the identical code path. An earlier version
 * of this script reimplemented the rendering and passed happily against the
 * broken preset - the two presets return different config shapes (9 exposes
 * `writerOpts`, 10 exposes `writer`), so reading the wrong key silently fell
 * back to writer defaults and proved nothing. Call the real API.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

function fail(message, detail) {
  console.error(`::error::${message}`);
  if (detail) console.error(detail);
  process.exit(1);
}

const rc = JSON.parse(readFileSync(join(root, '.releaserc.json'), 'utf-8'));

/** The options semantic-release would hand the notes generator. */
const pluginConfig =
  rc.plugins
    .filter(Array.isArray)
    .find(([name]) => name === '@semantic-release/release-notes-generator')?.[1] ?? {};

console.log(`preset: ${pluginConfig.preset ?? '(default)'}`);
try {
  const writerPkg = JSON.parse(
    readFileSync(join(root, 'node_modules/conventional-changelog-writer/package.json'), 'utf-8')
  );
  console.log(`writer: ${writerPkg.version}`);
} catch {
  /* not fatal - the render below is the real check */
}

const { generateNotes } = await import('@semantic-release/release-notes-generator');

// A commit set that touches every section the changelog renders, so a broken
// template helper surfaces here rather than mid-release.
const commits = [
  {
    hash: '0000000000000000000000000000000000000000',
    message: 'feat(demo): add a thing\n\nBREAKING CHANGE: it changed',
  },
  { hash: '1111111111111111111111111111111111111111', message: 'fix: correct a thing' },
  { hash: '2222222222222222222222222222222222222222', message: 'perf: speed a thing up' },
];

const context = {
  cwd: root,
  options: { repositoryUrl: 'https://github.com/kdpa-llc/mcp-compression-proxy' },
  lastRelease: { gitTag: 'v0.0.0', version: '0.0.0' },
  nextRelease: { gitTag: 'v1.0.0', version: '1.0.0', type: 'major' },
  commits,
  logger: { log: () => {}, error: console.error },
};

let notes;
try {
  notes = await generateNotes(pluginConfig, context);
} catch (error) {
  fail(
    'Release notes cannot be generated. A release would publish to npm and ' +
      'then fail at generateNotes, leaving a published package with no tag, ' +
      'no GitHub release and no changelog.',
    error.message
  );
}

for (const expected of ['add a thing', 'correct a thing']) {
  if (!notes?.includes(expected)) {
    fail(`Release notes rendered but omitted an expected commit: "${expected}".`, notes);
  }
}

console.log('OK: release notes generate correctly.');
