# CLAUDE.md

Guidance for Claude Code and other coding agents working in this repository.

## What this is

An MCP server that aggregates tools from several backend MCP servers behind
one connection, and compresses their descriptions to cut context use.

Two binaries ship:

- `mcp-compression-proxy` (`src/index.ts`) — the MCP server itself
- `mcp-cli` (`src/cli/`) — progressive tool discovery backed by a daemon that
  holds warm connections to the backends

Backend connections live in `src/mcp/client-manager.ts`; compression state in
`src/services/`; config loading and `${VAR}` expansion in `src/config/`.

## Commands

```bash
npm run build          # tsc
npm test               # full suite (builds first via pretest)
npm run test:unit      # unit only
npm run test:coverage  # with coverage
npm run lint           # eslint, must be 0 problems
npm run typecheck      # tsc --noEmit
npm run sync-version   # align src/version.ts with package.json
```

`pretest` builds before testing on purpose: three integration suites spawn
`dist/index.js` and `dist/cli/index.js` as real subprocesses, so a stale or
missing build fails them with `MODULE_NOT_FOUND`.

## Testing

| Location | Covers |
|---|---|
| `tests/unit/` | modules in isolation, 18 suites |
| `tests/integration/` | spawns the built binaries over stdio |
| `tests/e2e/` | full workflows against mocked clients |
| `tests/e2e-real/` | real Ollama, excluded from the default run |

`src/index.ts`, `src/cli/index.ts` and `src/cli/daemon.ts` are excluded from
coverage — they need a real process, and are covered by the subprocess
suites instead.

### Rules learned from real failures here

**Do not assert an LLM's exact wording.** `tests/e2e-real` talks to a 1B
model; asserting its phrasing contained specific keywords blocked a
docs-only PR. Assert the round-trip produced a substantive answer, and log
the rest.

**Never leave a timer or listener holding the event loop.** Housekeeping
should never be the reason a process cannot exit — `unref()` intervals, clear
timeouts in a `finally`, and remove signal listeners on close. The suite runs
with no open-handle warning and no `--forceExit`; keep it that way, because
`--forceExit` would only hide a real production leak.

**Green CI does not mean a release will work.** Nothing here exercises
semantic-release's note generation, so release-path breakage passes every
check. See below.

## The release path

semantic-release publishes from `main` over OIDC trusted publishing — no
stored npm token. Conventional commit types decide the version: `feat` minor,
`fix`/`perf`/`docs` patch, `chore`/`ci`/`test`/`style` no release.

Three constraints that are load-bearing and not obvious:

- **`conventional-changelog-conventionalcommits` is pinned to `^9`.** Preset
  10 needs `conventional-changelog-writer@9`+, but
  `@semantic-release/release-notes-generator` pins writer `^8`, and
  semantic-release resolves the preset *by name* at runtime. A hoisted preset
  10 makes `generateNotes` fail with `Missing helper` — which broke the first
  1.0.0 release *after* `npm publish` had already succeeded. Dependabot is
  told to skip that major.
- **`release.yml` pins Node 24 and gates on npm >= 11.5.1.** Trusted
  publishing needs that npm floor, and Node 22 still ships npm 10 — on which
  the OIDC exchange fails and semantic-release quietly falls back to token
  auth.
- **Release assets are `CHANGELOG.md` only.** A `dist/**` glob uploads every
  file flattened to its basename, so `dist/index.js` and `dist/cli/index.js`
  collide and the release is left as a draft.

Do not bump versions or edit `CHANGELOG.md` by hand. `src/version.ts` is
synced automatically; `tests/unit/version.test.ts` fails CI if it drifts.

## Conventions

- **`npm` is pinned to 11 in CI.** Node 22 bundles npm 10 and Node 24 bundles
  npm 11, and they resolve lockfiles differently. After changing
  dependencies, run `npm install` and commit the lockfile — a desync npm 11
  installs silently makes npm 10 fail with `EUSAGE`.
- **Backend servers inherit the proxy's full environment by default.** The
  stdio transport only passes a six-variable safe list on its own, so
  anything else the user exported never reaches the child. `inheritEnv`
  narrows it per server.
- **Tool names split on the first `__` only.** Backend tools may contain `__`
  in their own names.
