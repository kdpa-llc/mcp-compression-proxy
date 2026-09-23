# CLAUDE.md

Guidance for Claude Code and other coding agents working in this repository.

## What this is

An MCP server that aggregates tools from several backend MCP servers behind
one connection, and compresses their descriptions to cut context use.

Two binaries ship:

- `mcp-compression-proxy` (`src/index.ts`) — the MCP server itself
- `mcp-cli` (`src/cli/`) — progressive tool discovery backed by a daemon that
  holds warm connections to the backends

The MCP server's handlers live in `src/proxy/session.ts` (`ProxySession`),
built from one client's view (`src/proxy/client-view.ts`: its config, backends
and tool catalog) and shared services; `src/index.ts` only wires a session to
stdio, or attaches to the daemon with `backendMode: "daemon"`. The daemon
(`src/cli/daemon.ts`) hosts one session per attached proxy
(`src/daemon/session-host.ts`) and answers mcp-cli from the view of the shell
each request came from (`src/daemon/cli-requests.ts`). Backend connections are
pooled in `src/mcp/backend-pool.ts`, keyed by what a backend runs rather than
its name, over `src/mcp/client-manager.ts`; the shared, exclusion-filtered tool
list is `src/mcp/tool-catalog.ts`; compression state,
output shaping (`--want`/`--where`), call suggestions and the compression
audit in `src/services/`; ranked search and usage learning in `src/search/`;
the optional local model (Cactus Needle 3 through `python/needle_bridge.py`)
in `src/models/`; the native proxy's discovery tools in `src/native/`; config
loading and `${VAR}` expansion in `src/config/`.

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
| `tests/unit/` | modules in isolation, 41 suites |
| `tests/integration/` | spawns the built binaries over stdio |
| `tests/e2e/` | full workflows against mocked clients |
| `tests/e2e-real/` | real Ollama, and real Needle when `NEEDLE_PYTHON` is set; excluded from the default run |

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

**Treat the local model as advisory.** Needle 3 picked wrong tools while
reporting 0.95-1.0 confidence, and misread both auth-error test cases. Its
output may rank, propose or extract, labelled as such; it must never be the
only gate on an action. `suggest --run` also requires `readOnlyHint`,
grounded arguments and a single call. Tests use
`tests/__mocks__/fake-model-bridge.js`, never real weights.

**Measure ranking changes, do not guess.** `tests/fixtures/search-catalog.ts`
holds labelled queries; `tool-search.test.ts` pins floors for lexical search
and `e2e-real/needle-model.test.ts` logs the numbers with the model. Two
tuning mistakes it caught: equal-weight fusion with Needle cost top-one
accuracy, and centering embeddings on the mean of a two-item list inverts
their scores (so `centerFor` needs at least 8 vectors).

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
- **Anything per client goes through the view, never process state.** A
  daemon serves many clients from one process: config comes from
  `view.config()` (read from the client's directory and environment), backends
  from `view.backends`, relative paths resolve against `view.cwd`, and cache
  display settings are passed as a `DisplayPolicy`. `process.cwd()`,
  `process.env` or `loadJSONServersCached()` inside a session is a bug.
- **A backend's identity is what it runs, not its name.** `backendSpec`
  hashes command, args, cwd, environment (less `VOLATILE_ENV`), URL, headers
  and lifecycle settings; anything that changes a backend's behaviour must be
  in that hash, or two clients will share a backend they should not.
- **Tool names split on the first `__` only.** Backend tools may contain `__`
  in their own names.
- **Every backend call goes through `callToolWithAuthRecovery`.** It refuses
  `excludeTools` matches; a call path that bypasses it would let a hidden
  tool run again. List tools through `ToolCatalog`, which follows
  `tools/list` cursors; a bare `client.listTools()` reads only page one.
- **`skills/mcp-cli/` is shipped and user-facing.** It must match the real
  CLI: a renamed command or flag is a broken skill. `mcp-cli install-skill`
  copies it; `describe` is the no-API-key path for compressing and rewriting
  descriptions (`src/services/description-rewrite.ts`). Rewrites change
  description text only, never tool names or schema types.
- **Modules under test cannot use `import.meta`.** Jest runs them as CommonJS.
  Paths relative to the package (the bundled Needle bridge) are resolved in
  the entry points (`src/index.ts`, `src/cli/daemon.ts`) and passed in.
- **Needle telemetry is forced off** in both the bridge script and the
  environment the bridge is spawned with; the README promises nothing leaves
  the machine.
