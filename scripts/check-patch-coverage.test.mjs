import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { addedLines, evaluatePatch, parseLcov, runCoverage } from './check-patch-coverage.mjs';

const source = 'export const choose = (yes: boolean) => yes ? 1 : 0;\n';
function lcov({ name = 'src/example.ts', line = 1, hits = 1, branches = [1, 1] } = {}) {
  return `TN:\nSF:${name}\nDA:${line},${hits}\nLF:1\nLH:${hits ? 1 : 0}\n` +
    branches.map((count, index) => `BRDA:${line},0,${index},${count}\n`).join('') +
    `BRF:${branches.length}\nBRH:${branches.filter((n) => n !== '-' && n > 0).length}\nend_of_record\n`;
}
const script = fileURLToPath(new URL('./check-patch-coverage.mjs', import.meta.url));
function fixture(t) {
  const cwd = mkdtempSync(join(tmpdir(), 'patch-coverage-fixture-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const put = (name, content) => { mkdirSync(dirname(join(cwd, name)), { recursive: true }); writeFileSync(join(cwd, name), content); };
  const commit = (message) => { git('add', '.'); git('-c', 'user.name=Coverage Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'core.hooksPath=/dev/null', 'commit', '-m', message); return git('rev-parse', 'HEAD'); };
  git('init', '-b', 'main');
  put('package.json', '{"type":"module"}\n');
  put('.gitignore', 'coverage/\nnode_modules/\n');
  put('jest.config.js', "export default { collectCoverageFrom: ['src/**/*.ts', '!src/**/*.d.ts', '!src/entry.ts'], coverageDirectory: 'coverage' };\n");
  put('src/example.ts', source);
  const base = commit('base');
  const report = (contents = lcov()) => { put('coverage/lcov.info', contents); };
  return { cwd, git, put, commit, base, report };
}

test('a partial branch fails even when its line was executed', () => {
  const coverage = parseLcov(lcov({ branches: [3, 0] }), process.cwd());
  const result = evaluatePatch([{ name: 'src/example.ts', lines: new Set([1]) }], coverage);
  assert.equal(result.status, 'failed');
  assert.deepEqual(result.failures, ['src/example.ts:1,0,1 uncovered branch arm']);
  assert.equal(result.files[0].coveredLines, 1);
});

test('branch-only locations and not-taken markers are checked independently', () => {
  const report = lcov({ branches: ['-', 1] }).replaceAll('BRDA:1,', 'BRDA:2,');
  const result = evaluatePatch([{ name: 'src/example.ts', lines: new Set([2]) }], parseLcov(report, process.cwd()));
  assert.equal(result.status, 'failed');
  assert.equal(result.files[0].changedLines, 0);
  assert.equal(result.files[0].changedBranches, 2);
});

test('uncovered lines fail, unchanged branches do not', () => {
  const report = lcov({ hits: 0, branches: [0, 0] });
  assert.equal(evaluatePatch([{ name: 'src/example.ts', lines: new Set([1]) }], parseLcov(report, process.cwd())).failures.length, 3);
  assert.deepEqual(evaluatePatch([{ name: 'src/example.ts', lines: new Set([2]) }], parseLcov(report, process.cwd())).failures, []);
});

test('empty, malformed, truncated and missing source evidence fail closed', () => {
  for (const text of ['', lcov().replace('DA:1,1', 'DA:1,nope'), lcov().replace('end_of_record', ''), lcov().replace('BRF:2', 'BRF:0')]) {
    assert.throws(() => parseLcov(text, process.cwd()));
  }
  assert.throws(() => evaluatePatch([{ name: 'src/missing.ts', lines: new Set([1]) }], parseLcov(lcov(), process.cwd())), /Missing coverage source/);
});

test('hunks retain only added head lines, including insertion and deletion-only hunks', () => {
  assert.deepEqual([...addedLines('@@ -1 +1,2 @@\n-a\n+b\n+c\n@@ -7 +8,0 @@\n-x\n@@ -10,0 +10 @@\n+y')], [1, 2, 10]);
  assert.throws(() => addedLines('Binary files a/src/example.ts and b/src/example.ts differ'), /binary/);
});

test('a fresh exact-head report binds hashes and covers the entire divergent PR', async (t) => {
  const f = fixture(t);
  f.git('switch', '-c', 'candidate');
  f.put('src/example.ts', `// candidate\n${source}`);
  f.commit('first candidate change');
  f.put('README.md', 'later docs-only candidate commit');
  const head = f.commit('second candidate change');
  f.git('switch', 'main');
  f.put('FUNDING.yml', 'github: fixture');
  const base = f.commit('unrelated base advance');
  f.git('switch', 'candidate');
  const result = await runCoverage({ cwd: f.cwd, base, head, runJest: () => f.report(lcov({ line: 2 })) });
  assert.equal(result.mergeBase, f.base);
  assert.equal(result.headSha, head);
  assert.equal(result.baseSha, base);
  assert.equal(result.sourceSha256.length, 64);
  assert.equal(result.lcovSha256.length, 64);
  assert.deepEqual(result.files, [{ name: 'src/example.ts', changedLines: 0, coveredLines: 0, changedBranches: 0, coveredBranches: 0 }]);
  // Now change the executable line: checking just the latest docs commit would miss it.
  f.put('src/example.ts', source.replace('? 1', '? 2'));
  f.commit('uncovered executable change');
  f.put('README.md', 'last commit only changes documentation');
  const changedHead = f.commit('latest docs change');
  await assert.rejects(runCoverage({ cwd: f.cwd, base, head: changedHead, runJest: () => f.report(lcov({ branches: [1, 0] })) }), /uncovered branch arm/);
});

test('docs-only patches pass explicitly with no executable denominator', async (t) => {
  const f = fixture(t);
  f.put('README.md', 'docs only');
  const head = f.commit('docs');
  const result = await runCoverage({ cwd: f.cwd, base: f.base, head, runJest: () => f.report() });
  assert.deepEqual(result.files, []);
  assert.deepEqual(result.excludedFiles, ['README.md']);
  assert.equal(result.status, 'passed');
  assert.equal(result.applicability, 'not-applicable');
});


test('every LCOV source must identify a tracked included file even for non-source changes', async (t) => {
  for (const changedFile of ['README.md', 'package-lock.json']) {
    const f = fixture(t);
    f.put('src/entry.ts', source); // Tracked but explicitly excluded from coverage.
    const base = f.commit('excluded entry');
    f.put(changedFile, changedFile.endsWith('.json') ? '{}\n' : 'docs only\n');
    const head = f.commit('non-source change');
    const options = { cwd: f.cwd, base, head };
    for (const name of [
      'src/nonexistent.ts',
      'src/file:/runner/work/project/src/example.ts',
      'src/entry.ts',
      changedFile,
    ]) {
      await assert.rejects(
        runCoverage({ ...options, runJest: () => f.report(lcov({ name })) }),
        /LCOV source is not a tracked file in coverage scope/
      );
    }
    for (const name of ['src/example.ts', join(f.cwd, 'src/example.ts')]) {
      const result = await runCoverage({ ...options, runJest: () => f.report(lcov({ name })) });
      assert.equal(result.applicability, 'not-applicable');
      assert.equal(result.status, 'passed');
    }
    await assert.rejects(
      runCoverage({ ...options, runJest: () => f.report(lcov() + lcov({ name: './src/example.ts' })) }),
      /Invalid or duplicate LCOV source/
    );
  }
});

test('unchanged type-only sources need not invent an executable coverage record', async (t) => {
  const f = fixture(t);
  f.put('src/types.ts', 'export interface Config { enabled: boolean }\n');
  const base = f.commit('type-only source');
  f.put('README.md', 'docs');
  const head = f.commit('docs only');
  const result = await runCoverage({ cwd: f.cwd, base, head, runJest: () => f.report() });
  assert.equal(result.status, 'passed');
  assert.equal(result.applicability, 'not-applicable');
});

test('source renames preserve unchanged lines and deletions do not invent head lines', async (t) => {
  const f = fixture(t);
  f.put('src/other.ts', source);
  const base = f.commit('keep a real source after deleting the renamed file');
  f.git('mv', 'src/example.ts', 'src/renamed.ts');
  let head = f.commit('rename');
  let result = await runCoverage({ cwd: f.cwd, base, head, runJest: () => f.report(lcov({ name: 'src/renamed.ts' })) });
  assert.equal(result.files[0].changedLines, 0);
  assert.equal(result.files[0].name, 'src/renamed.ts');
  f.git('rm', 'src/renamed.ts');
  head = f.commit('delete');
  result = await runCoverage({ cwd: f.cwd, base, head, runJest: () => f.report(lcov({ name: 'src/other.ts' })) });
  assert.deepEqual(result.files, []);
});

test('documented exclusions are recorded and uninstrumented included source fails', async (t) => {
  const f = fixture(t);
  f.put('src/entry.ts', source);
  f.put('src/types.d.ts', 'declare const yes: boolean;\n');
  let head = f.commit('excluded fixture files');
  const result = await runCoverage({ cwd: f.cwd, base: f.base, head, runJest: () => f.report() });
  assert.deepEqual(result.excludedFiles, ['src/entry.ts', 'src/types.d.ts']);
  f.put('src/missing.ts', source);
  head = f.commit('uninstrumented source');
  await assert.rejects(runCoverage({ cwd: f.cwd, base: f.base, head, runJest: () => f.report() }), /Missing coverage source/);
});

test('missing base, wrong head, dirty source, binary source, and stale LCOV never pass', async (t) => {
  const f = fixture(t);
  f.put('README.md', 'docs');
  const head = f.commit('docs');
  const run = (extra = {}) => runCoverage({ cwd: f.cwd, base: f.base, head, runJest: () => f.report(), ...extra });
  await assert.rejects(run({ base: undefined }), /explicit existing base/);
  await assert.rejects(run({ base: '0'.repeat(40) }), /explicit existing base/);
  await assert.rejects(run({ base: 'missing-ref' }));
  await assert.rejects(run({ base: head }), /must be different/);
  await assert.rejects(run({ head: f.base }), /checked-out HEAD/);
  f.put('src/example.ts', '// dirty\n');
  await assert.rejects(run(), /working-tree/);
  f.git('restore', 'src/example.ts');
  f.report();
  await assert.rejects(run({ runJest: () => {} }), /ENOENT/);
  await assert.rejects(run({ runJest: () => { f.report(); f.put('src/example.ts', '// mutated\n'); } }), /working-tree/);
  f.put('src/example.ts', '\u0000binary');
  const binaryHead = f.commit('binary source');
  await assert.rejects(run({ head: binaryHead }), /Binary source/);
});

test('CLI exits nonzero for an intentionally uncovered branch and cannot reuse the previous report', (t) => {
  const f = fixture(t);
  f.put('src/example.ts', source.replace('? 1', '? 2'));
  f.put('scripts/check-patch-coverage.mjs', readFileSync(script));
  const head = f.commit('candidate');
  // This fixture supplies an instrumenter boundary only; it never runs application code.
  f.put('node_modules/jest/bin/jest.js', `const fs = require('node:fs'); fs.mkdirSync('coverage', { recursive: true }); fs.writeFileSync('coverage/lcov.info', ${JSON.stringify(lcov({ branches: [1, 0] }))});\n`);
  const args = ['scripts/check-patch-coverage.mjs', '--base', f.base, '--head', head];
  assert.throws(() => execFileSync(process.execPath, args, { cwd: f.cwd, stdio: 'pipe' }), (error) => error.status === 1 && error.stderr.toString().includes('uncovered branch arm'));
  f.put('node_modules/jest/bin/jest.js', '// no fresh report\n');
  assert.throws(() => execFileSync(process.execPath, args, { cwd: f.cwd, stdio: 'pipe' }), (error) => error.status === 1 && error.stderr.toString().includes('ENOENT'));
});

test('PR coverage binds the exact head and verifies an advanced target remains descended from the event base', async (t) => {
  const f = fixture(t);
  f.git('switch', '-c', 'candidate');
  f.put('src/example.ts', source.replace('? 1', '? 2'));
  const prHead = f.commit('candidate');
  f.git('switch', 'main');
  f.put('README.md', 'advanced target');
  const base = f.commit('base advance');
  f.git('-c', 'user.name=Coverage Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'core.hooksPath=/dev/null', 'merge', '--no-ff', 'candidate', '-m', 'synthetic merge');
  const head = f.git('rev-parse', 'HEAD');
  const options = { cwd: f.cwd, base, head, prHead, runJest: () => f.report() };
  const result = await runCoverage(options);
  assert.equal(result.prHeadSha, prHead);
  assert.equal(result.headSha, head);
  assert.equal(result.testedTreeSha, f.git('rev-parse', 'HEAD^{tree}'));
  assert.equal(result.totals.changedLines, 1);
  assert.equal(result.eventBaseSha, base);
  assert.equal(result.testedBaseSha, base);
  const advanced = await runCoverage({ ...options, base: f.base });
  assert.equal(advanced.eventBaseSha, f.base);
  assert.equal(advanced.testedBaseSha, base);
  assert.equal(advanced.mergeBase, base);
  assert.deepEqual(advanced.files, result.files);
  await assert.rejects(runCoverage({ ...options, prHead: base }), /exact PR head/);
  await assert.rejects(runCoverage({ ...options, base: prHead }), /ancestor of the actual tested base/);
  f.git('switch', 'candidate');
  await assert.rejects(runCoverage({ ...options, head: prHead, base: f.base }), /exactly two parents/);
});
