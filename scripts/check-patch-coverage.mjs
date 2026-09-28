import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';

const digest = (value) => createHash('sha256').update(value).digest('hex');
const git = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trimEnd();
const fail = (message) => { throw new Error(message); };

/** Parse the instrumenter's line and branch records; incomplete reports fail closed. */
export function parseLcov(text, cwd) {
  const files = new Map();
  let file;
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith('SF:')) {
      if (file) fail('LCOV record is missing end_of_record');
      const name = relative(cwd, resolve(cwd, line.slice(3))).split('\\').join('/');
      if (!name || name.startsWith('../') || isAbsolute(name) || files.has(name)) fail('Invalid or duplicate LCOV source');
      file = { name, lines: new Map(), branches: new Map(), totals: {} };
    } else if (line.startsWith('DA:') || line.startsWith('BRDA:')) {
      if (!file) fail('LCOV counters appear outside a source record');
      const values = line.slice(line.indexOf(':') + 1).split(',');
      const branch = line.startsWith('BRDA:');
      if (values.length !== (branch ? 4 : 2) || !/^[1-9]\d*$/.test(values[0]) ||
          values.slice(1).some((value, index) => !(branch && index === 2 && value === '-') && !/^\d+$/.test(value))) fail(`Malformed LCOV counter: ${line}`);
      const key = branch ? values.slice(0, 3).join(',') : Number(values[0]);
      const counters = branch ? file.branches : file.lines;
      if (counters.has(key)) fail(`Duplicate LCOV counter: ${line}`);
      counters.set(key, Number(values.at(-1) === '-' ? 0 : values.at(-1)));
    } else if (/^(LF|LH|BRF|BRH):/.test(line)) {
      if (!file || !/^\d+$/.test(line.split(':')[1])) fail(`Malformed LCOV total: ${line}`);
      const [key, value] = line.split(':');
      if (key in file.totals) fail(`Duplicate LCOV total: ${key}`);
      file.totals[key] = Number(value);
    } else if (line === 'end_of_record') {
      if (!file) fail('LCOV record has no source');
      const expected = { LF: file.lines.size, LH: [...file.lines.values()].filter(Boolean).length,
        BRF: file.branches.size, BRH: [...file.branches.values()].filter(Boolean).length };
      for (const [key, value] of Object.entries(expected)) {
        if (file.totals[key] !== value) fail(`Missing or inconsistent ${key} for ${file.name}`);
      }
      files.set(file.name, file);
      file = undefined;
    } else if (line && !/^(TN:|FN:|FNDA:|FNF:|FNH:)/.test(line)) {
      fail(`Unrecognized LCOV record: ${line}`);
    }
  }
  if (file || !files.size) fail('LCOV report is incomplete or empty');
  return files;
}

export function addedLines(patch) {
  if (patch.includes('Binary files ') || patch.includes('GIT binary patch')) fail('Cannot inspect binary source patch');
  const lines = new Set();
  for (const line of patch.split('\n')) {
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (hunk) {
      const count = hunk[2] === undefined ? 1 : Number(hunk[2]);
      for (let i = 0; i < count; i++) lines.add(Number(hunk[1]) + i);
    }
  }
  return lines;
}

export function evaluatePatch(changes, coverage) {
  const files = [];
  const failures = [];
  for (const { name, lines } of changes) {
    const covered = coverage.get(name);
    if (!covered) fail(`Missing coverage source record: ${name}`);
    const changedLines = [...covered.lines].filter(([line]) => lines.has(line));
    // BRDA can name a location that has no DA record, so check it independently.
    const changedBranches = [...covered.branches].filter(([key]) => lines.has(Number(key.split(',')[0])));
    for (const [line, hits] of changedLines) if (!hits) failures.push(`${name}:${line} uncovered line`);
    for (const [key, hits] of changedBranches) if (!hits) failures.push(`${name}:${key} uncovered branch arm`);
    files.push({ name, changedLines: changedLines.length, coveredLines: changedLines.filter(([, hits]) => hits > 0).length,
      changedBranches: changedBranches.length, coveredBranches: changedBranches.filter(([, hits]) => hits > 0).length });
  }
  const totals = files.reduce((all, file) => ({
    changedLines: all.changedLines + file.changedLines, coveredLines: all.coveredLines + file.coveredLines,
    changedBranches: all.changedBranches + file.changedBranches, coveredBranches: all.coveredBranches + file.coveredBranches,
  }), { changedLines: 0, coveredLines: 0, changedBranches: 0, coveredBranches: 0 });
  return { files, totals, failures, applicability: totals.changedLines || totals.changedBranches ? 'measured' : 'not-applicable',
    status: failures.length ? 'failed' : 'passed' };
}

function snapshot(cwd) {
  if (git(cwd, ['status', '--porcelain', '--untracked-files=all'])) fail('Commit or remove working-tree changes before exact-head coverage validation');
  const hash = createHash('sha256');
  for (const name of git(cwd, ['ls-files', '-z']).split('\0').filter(Boolean)) {
    hash.update(name).update('\0').update(readFileSync(join(cwd, name))).update('\0');
  }
  return hash.digest('hex');
}

/** Generate and evaluate one fresh report. runJest is injectable only for fixture tests. */
export async function runCoverage({ cwd = process.cwd(), base, head = 'HEAD', prHead, runJest } = {}) {
  if (typeof path.matchesGlob !== 'function') fail('Patch coverage requires Node.js 22.5 or newer; use a current Node 22 or 24 release');
  if (!base || /^0+$/.test(base)) fail('An explicit existing base commit is required (initial pushes need a reviewed base)');
  const commit = (ref) => git(cwd, ['rev-parse', '--verify', `${ref}^{commit}`]);
  const baseSha = commit(base);
  const headSha = commit(head);
  if (headSha !== commit('HEAD')) fail('Coverage head must match the checked-out HEAD');
  if (baseSha === headSha) fail('Base and head must be different commits');
  const prHeadSha = prHead ? commit(prHead) : undefined;
  let testedBaseSha = baseSha;
  if (prHeadSha) {
    const parents = git(cwd, ['rev-list', '--parents', '-n', '1', headSha]).split(' ').slice(1);
    if (parents.length !== 2 || parents[1] !== prHeadSha) {
      fail('Tested PR merge must have exactly two parents and the exact PR head as second parent');
    }
    // GitHub can retain an older event base after advancing the merge ref.
    // Require that provenance to remain ancestral, then compare the actual
    // tested target with its merge so unrelated target changes are not charged to the PR.
    try { git(cwd, ['merge-base', '--is-ancestor', baseSha, parents[0]]); }
    catch { fail('Event base must be an ancestor of the actual tested base parent'); }
    testedBaseSha = parents[0];
  }
  const testedTreeSha = git(cwd, ['rev-parse', `${headSha}^{tree}`]);
  const mergeBase = git(cwd, ['merge-base', testedBaseSha, headSha]);
  const before = snapshot(cwd);
  const { default: config } = await import(pathToFileURL(join(cwd, 'jest.config.js')).href);
  if (!Array.isArray(config.collectCoverageFrom)) fail('Expected explicit Jest collectCoverageFrom patterns');
  const included = (name) => {
    let match = false;
    for (const pattern of config.collectCoverageFrom) {
      const excluded = pattern.startsWith('!');
      if (path.matchesGlob(name, excluded ? pattern.slice(1) : pattern)) match = !excluded;
    }
    return match;
  };
  const changes = [];
  const excludedFiles = [];
  const paths = git(cwd, ['diff', '--name-status', '-z', '--find-renames', mergeBase, headSha]).split('\0').filter(Boolean);
  while (paths.length) {
    const status = paths.shift();
    const oldName = paths.shift();
    const name = status.startsWith('R') ? paths.shift() : oldName;
    if (status === 'D') continue; // Deleted lines have no executable head counterpart.
    if (!/^(A|M|T|R\d+)$/.test(status)) fail(`Unsupported diff status: ${status}`);
    if (!included(name)) { excludedFiles.push(name); continue; }
    if (readFileSync(join(cwd, name)).includes(0)) fail(`Binary source cannot be instrumented: ${name}`);
    const patch = git(cwd, ['diff', '--no-ext-diff', '--no-color', '--find-renames', '--unified=0', mergeBase, headSha, '--', oldName, name]);
    changes.push({ name, lines: addedLines(patch) });
  }
  const coverageDir = join(cwd, config.coverageDirectory ?? 'coverage');
  const reportPath = join(coverageDir, 'lcov.info');
  const resultPath = join(coverageDir, 'patch-coverage.json');
  // The gate can never accept a leftover artifact if Jest fails or emits no report.
  rmSync(reportPath, { force: true });
  rmSync(resultPath, { force: true });
  if (runJest) await runJest();
  else execFileSync(process.execPath, [join(cwd, 'node_modules/jest/bin/jest.js'), '--coverage', '--runInBand'], { cwd, stdio: 'inherit' });
  if (snapshot(cwd) !== before || commit('HEAD') !== headSha) fail('Source, tests, configuration, or HEAD changed during coverage generation');
  const lcov = readFileSync(reportPath, 'utf8');
  const coverage = parseLcov(lcov, cwd);
  const tracked = new Set(git(cwd, ['ls-files', '-z']).split('\0').filter(Boolean));
  // Validate every report identity, including when a dependency/docs-only diff is N/A.
  for (const name of coverage.keys()) {
    if (!tracked.has(name) || !included(name)) fail('LCOV source is not a tracked file in coverage scope: ' + name);
  }
  const result = { baseSha, eventBaseSha: prHeadSha ? baseSha : undefined, testedBaseSha, headSha, prHeadSha, testedTreeSha, mergeBase, sourceSha256: before, lcovSha256: digest(lcov),
    generatedAt: new Date().toISOString(), scope: config.collectCoverageFrom, excludedFiles, ...evaluatePatch(changes, coverage) };
  mkdirSync(coverageDir, { recursive: true });
  writeFileSync(resultPath, `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify(result, null, 2));
  if (result.failures.length) fail(`Patch coverage failed: ${result.failures.join('; ')}`);
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  const options = {};
  for (let i = 0; i < args.length; i += 2) {
    if (!['--base', '--head', '--pr-head'].includes(args[i]) || !args[i + 1]) fail('Usage: check-patch-coverage.mjs --base <commit> [--head <commit>] [--pr-head <commit>]');
    options[args[i] === '--pr-head' ? 'prHead' : args[i].slice(2)] = args[i + 1];
  }
  runCoverage(options).catch((error) => { console.error(error.message); process.exitCode = 1; });
}
