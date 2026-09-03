<div align="center">

# 🗜️ MCP Compression Proxy

**One managed entry point for your MCP stack**

MCP servers give agents useful tools, but a growing MCP setup adds process sprawl, large tool schemas, stale credentials, oversized results, and upgrade work. MCP Compression Proxy puts those servers behind one endpoint and handles the routine operations in one place.

[![npm version][npm-version-badge]][npm-package]
[![npm downloads][npm-downloads-badge]][npm-package]
[![npm types][npm-types-badge]][npm-package]
[![License: MIT][license-badge]][license]
[![Node][node-badge]][nodejs]
[![MCP][mcp-badge]][mcp-protocol]

[![CI][ci-badge]][ci-workflow]
[![codecov][codecov-badge]][codecov]
[![CodeQL][codeql-badge]][codeql-workflow]

[![GitHub Stars][stars-badge]][stargazers]
[![GitHub Forks][forks-badge]][network]
[![GitHub Issues][issues-badge]][repo-issues]
[![GitHub Last Commit][commit-badge]][commits]
[![PRs Welcome][prs-badge]][contributing]

[Quick Start](#-quick-start) •
[Why Use It](#why-use-it) •
[Capabilities](#-capabilities) •
[mcp-cli](#️-mcp-cli-progressive-tool-discovery) •
[Configuration](#-configuration) •
[FAQ](#-faq) •
[Contributing](#-contributing)

</div>

---

## 📑 Table of Contents

- [What is MCP Compression Proxy?](#what-is-mcp-compression-proxy)
- [Why use it?](#why-use-it)
- [✨ Capabilities](#-capabilities)
- [🚀 Quick Start](#-quick-start)
- [🎯 Usage](#-usage)
- [⌨️ mcp-cli (Progressive Tool Discovery)](#️-mcp-cli-progressive-tool-discovery)
- [🔧 Configuration](#-configuration)
- [💡 Best Practices](#-best-practices)
- [❓ FAQ](#-faq)
- [🧪 Testing](#-testing)
- [🤝 Contributing](#-contributing)
- [💖 Support This Project](#-support-this-project)

---

## What is MCP Compression Proxy?

MCP Compression Proxy sits between your agents and backend MCP servers. Each client connects to one stable endpoint. The proxy starts and supervises backends, namespaces their tools, controls how much tool metadata enters model context, and records lifecycle health.

You keep backend definitions in one JSON file. Agents discover and call tools through the proxy instead of loading a separate MCP process and full schema set for every server.

Shared-daemon deployments can reuse one backend fleet across many agent sessions. The versioned daemon contract also supports blue/green routers that activate a new proxy release while existing requests finish on the previous release.

## Why use it?

| MCP operating problem | What the proxy provides |
|---|---|
| Every client launches another backend fleet | A shared daemon that many clients can reuse |
| Tool descriptions consume model context before work starts | Description compression and progressive discovery |
| Long-lived backends retain stale credentials or state | One-hour lazy recycling, eight-hour draining, and auth-triggered replacement |
| Tool results flood smaller context windows | A 10K spill threshold with private file storage, search, and paged reads |
| Agents need glue code for dependent tool calls | Declarative call scripts with JSON Pointer references |
| Upgrades interrupt terminals and active sessions | Versioned daemon sockets for blue/green router integrations |
| Failures hide inside background processes | Per-server generations, counters, timestamps, errors, and daemon status |

The proxy fits local agent setups, team workstations, and long-running automation hosts. Install it once, point clients at the stable endpoint, and manage backend policy from one configuration.

```text
Agent clients
     |
stable MCP shim
     |
version router
     |
active proxy daemon
     |
configured backend MCP servers
```

## ✨ Capabilities

- **Multi-server aggregation:** Expose tools from many MCP servers through one connection and consistent names.
- **Progressive discovery:** Search compact tool summaries and fetch a full schema only before a call.
- **Description compression:** Cache shorter tool descriptions and expand selected tools per session.
- **Managed connection generations:** Track active calls, drain old generations, and use one reconnect for concurrent callers.
- **Authentication recovery:** Detect configured authentication failures, replace the affected backend, and retry tools marked read-only.
- **Large-output control:** Store results above 10K in owner-only files, then search or read them in bounded pages.
- **Declarative scripts:** Run up to 20 sequential tool calls and pass prior JSON values with RFC 6901 pointers.
- **Operational status:** Report release identity, connection age, active calls, recycle counts, authentication resets, failures, and last success.
- **Versioned daemon runtime:** Run candidate and active releases on separate sockets while a stable router controls cutover.
- **Standard MCP transport:** Work with MCP clients that support stdio servers.

## 🚀 Quick Start

### Prerequisites

- **Node.js 22+** installed on your system
- An **MCP-compatible client** (Claude Desktop, Cline, Continue.dev, etc.)

### 1. Install

**Option A: Install from npm** (recommended for most users):
```bash
npm install -g mcp-compression-proxy
```

**Option B: Install from source** (for development or latest features):
```bash
git clone https://github.com/kdpa-llc/mcp-compression-proxy.git
cd mcp-compression-proxy
npm install
npm run build
```

### 2. Configure MCP Client

Add to your MCP client configuration file:

- **macOS**: `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Windows**: `%APPDATA%\Claude\claude_desktop_config.json`

**If installed via npm:**
```json
{
  "mcpServers": {
    "compression-proxy": {
      "command": "mcp-compression-proxy",
      "env": {
        "LOG_LEVEL": "info"
      }
    }
  }
}
```

**If installed from source:**
```json
{
  "mcpServers": {
    "compression-proxy": {
      "command": "node",
      "args": [
        "/absolute/path/to/mcp-compression-proxy/dist/index.js"
      ],
      "env": {
        "LOG_LEVEL": "info"
      }
    }
  }
}
```

### 3. Configure Servers

Create a JSON configuration file to define which MCP servers to aggregate:

**Option 1: User-level config** (recommended for personal use)
- Location: `~/.mcp-compression-proxy/servers.json`

**Option 2: Project-level config** (recommended for team projects)
- Location: `./servers.json` (in the mcp-compression-proxy directory)

**Example configuration:**

```json
{
  "mcpServers": [
    {
      "name": "filesystem",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"],
      "enabled": true
    },
    {
      "name": "github",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": {
        "GITHUB_PERSONAL_ACCESS_TOKEN": "${GITHUB_TOKEN}"
      },
      "enabled": true
    }
  ]
}
```

> **Note:** Server configuration changes do not require a rebuild. Standalone mode reloads them on restart; a managed router can activate a refreshed daemon without restarting agent sessions.

### 4. Restart Your MCP Client

Restart your MCP client (e.g., Claude Desktop) to load the new configuration. The proxy will automatically connect to all configured MCP servers and make their tools available.

## 🎯 Usage

### Tool Naming

**Proxied tools** from your configured MCP servers use the format `serverName__toolName`:
- `filesystem__read_file`
- `filesystem__write_file`
- `github__create_issue`

**Management tools** (built-in) don't have a prefix and are listed below.

### Management Tools

| Tool | Description |
|------|-------------|
| `create_session` | Create a new session for independent tool expansion |
| `set_session` | Set the active session |
| `delete_session` | Delete a session |
| `clear_compressed_tools_cache` | Clear all cached compressed tool descriptions |
| `invalidate_tool_cache` | Drop one tool's cached compression so it is compressed again |
| `get_uncompressed_tools` | Get tools that need compression (batch processing) |
| `cache_compressed_tools` | Save compressed descriptions to cache (batch processing) |
| `compress_via_sampling` | Compress automatically using the client's own LLM (requires sampling support) |
| `expand_tool` | Expand a tool to show full description (session-specific) |
| `collapse_tool` | Collapse tool back to compressed description |
| `stats` | Return JSON summary of coverage, cache health, sessions, and per-server tool counts |

Use `stats` from your client (e.g., `mcp-compression-proxy__stats`) to sanity-check coverage. Optional inputs: `serverName` to scope to one backend and `detailLevel` (`summary` or `full`, default `summary`). The response includes coverage %, estimated token savings, cache state, active sessions, and per-server tool counts (respecting your exclude patterns).

#### Stale Compressions

A compression is made from the description a backend served at the time. When
that backend updates the description — a server upgrade, say — the cached
compression no longer describes the tool.

The proxy notices: a tool whose live description no longer matches the one it
was compressed from is counted as **stale** and offered again by
`get_uncompressed_tools`, so the normal compress → cache loop repairs it with
nothing extra to run. Stale counts appear in `stats` and in the `[live: ...]`
summary on the compression tools.

Tools cached before originals were recorded are never flagged, since there is
no baseline to compare against. To redo a compression you simply dislike, use
`invalidate_tool_cache` — that is a separate concern from staleness:

```
mcp-compression-proxy__invalidate_tool_cache
  serverName: "filesystem"
  toolName: "read_file"
```

#### Automatic Compression (MCP Sampling)

If your client supports [MCP sampling][mcp-sampling], the proxy can compress
descriptions by borrowing the client's own LLM — no API key, no second model
to configure, and no work for you beyond one tool call:

```
mcp-compression-proxy__compress_via_sampling
```

It reads the uncompressed tools, asks the host to rewrite them, caches the
results, and reports before/after coverage. Call it again for the next batch
until nothing remains. Batches are sent one at a time, since a host may ask
you to approve each request.

Support varies by client — Cursor implements sampling; Claude Desktop and
Cline did not at the time of writing. On a client without it the tool returns
an error pointing at the manual `get_uncompressed_tools` →
`cache_compressed_tools` flow, which works everywhere.

### Workflow Example

#### 1. Before Compression

When you first ask your AI assistant about available tools:

```
User: What tools do you have?

AI: I have access to these tools:
- filesystem__read_file: Reads the complete contents of a file at the
  specified path. The file must exist and be readable. Returns the file
  contents as text. Supports absolute and relative paths. Maximum file
  size is 10MB. Will throw an error if the file doesn't exist...
  [~200 tokens for one tool]
```

#### 2. Enable Compression (One-Time Setup)

Ask your AI assistant to compress the descriptions:

```
User: Use the mcp-compression-proxy tools to compress tool descriptions and save model context

AI: I'll compress the tool descriptions:
1. Getting all tools via get_uncompressed_tools...
2. Compressing descriptions intelligently...
3. Saving compressed versions via cache_compressed_tools...

Done! Tool descriptions are now compressed and saved to cache.
```

#### 3. After Compression

The same request now uses far fewer tokens:

```
User: What tools do you have?

AI: I have access to these tools:
- filesystem__read_file: Read file contents (text, max 10MB)
- filesystem__write_file: Write/overwrite file
- github__create_issue: Create GitHub issue
  [~30 tokens for one tool]
```

**Result**: ~70% reduction in tokens for tool listings!

#### 4. Persistent Storage

Compressed descriptions are automatically saved to disk at `~/.mcp-compression-proxy/cache.json` and loaded on server restart. No need to re-compress after restarting!

**To clear the cache if needed:**
```bash
# If installed via npm
mcp-compression-proxy --clear-cache

# If installed from source
node dist/index.js --clear-cache
```

> **💡 Tip**: After setting up, simply tell your AI: *"Compress the tool descriptions to save context"* and it will handle the rest!

## ⌨️ mcp-cli (Progressive Tool Discovery)

The package also installs `mcp-cli`, a second entry point for agents that
would rather *shell out* than hold every tool definition in context. Instead
of loading all tools up front, the agent lists or searches for what it needs
and pulls the full schema only for the tool it is about to call.

A background daemon keeps warm connections to the backend MCP servers, so
each command is a short IPC round-trip rather than a fresh server startup.

```bash
mcp-cli tools                          # List all tools (compressed)
mcp-cli search <query>                 # Search tools by name/description
mcp-cli info <server>/<tool>           # Full schema for one tool
mcp-cli call <server>/<tool> '<json>'  # Execute a tool
mcp-cli output find <id> <query>       # Search a cached large output
mcp-cli output read <id> 0 all         # Load a cached output deliberately
mcp-cli script '<json>'                 # Run a declarative call chain
mcp-cli stats                          # Compression statistics

mcp-cli doctor                         # Check config and backend health

mcp-cli daemon start                   # Start the background daemon
mcp-cli daemon status                  # Show daemon status
mcp-cli daemon restart                 # Restart the daemon
mcp-cli daemon stop                    # Stop the daemon
mcp-cli daemon logs [-n N] [-f]        # Show daemon logs (default: last 50)
```

The daemon starts automatically on first use. Pass `--no-auto-start` to fail
fast instead when it is not already running.

`mcp-cli doctor` is the first thing to reach for when something looks wrong: it
reports which config files were found, formats a schema error readably instead
of throwing a stack trace, lists each backend's live connection state, and
flags servers added to `servers.json` that the running daemon has not picked
up. It exits non-zero on any problem, so it works in a script.

Restricted agent sandboxes may block access to the managed router's Unix socket even when the router is healthy. Retry the same `mcp-cli` command with host or elevated execution. When `active-release.json` exists, do not run `mcp-cli daemon start`; the managed router owns the stable socket.

`call` also accepts its JSON argument on stdin, which avoids shell quoting
problems with large payloads:

```bash
echo '{"path": "/tmp/notes.md"}' | mcp-cli call filesystem/read_file
```

### CLI Configuration

The optional `cli` block in `servers.json` tunes daemon behavior:

```json
{
  "cli": {
    "payloadThreshold": 10000,
    "autoStartDaemon": true,
    "daemonLogLevel": "info"
  },
  "mcpServers": []
}
```

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `payloadThreshold` | number | `10000` | Tool output longer than this many characters is cached in an owner-only file and replaced with a payload ID and path |
| `autoStartDaemon` | boolean | `true` | Start the daemon automatically when a command needs it |
| `daemonLogLevel` | string | `"info"` | Daemon log level (`debug`, `info`, `warn`, `error`) |

Daemon state lives in `~/.mcp-compression-proxy/` (socket, PID file, and
`daemon.log`), created with `0700` permissions since the control socket
accepts commands that execute downstream MCP tools.

The daemon can also run as a versioned blue/green instance. Set `MCP_DAEMON_SOCKET_PATH`, `MCP_DAEMON_PID_FILE`, `MCP_DAEMON_READY_FILE`, `MCP_DAEMON_LOG_FILE`, and `MCP_DAEMON_RELEASE_ID` before launching `dist/cli/daemon.js`. Multiple releases may then run concurrently on separate sockets. `MCP_DAEMON_BASE_DIR` remains the shared state root, and `MCP_PAYLOAD_DIR` optionally overrides the shared payload directory, so payload IDs remain readable after a release cutover.

A stable router can use this contract to start a candidate release, run canaries, switch new requests with an atomic active-release pointer, drain requests pinned to the previous release, and roll back if the stable-path canary fails. Distributions can pair that flow with a reviewed update channel so agents report available releases and ask users before activation.

When `active-release.json` exists, `mcp-cli` treats the installation as router-managed and refuses to start a legacy daemon on the stable socket. This prevents an isolated or sandboxed client from unlinking the router socket after a failed probe.

### Connection Lifecycle

Backend MCP processes use leased connection generations so stale credentials and indefinitely warm processes do not survive forever. New calls never use a draining generation, while calls already in progress are allowed to finish before that generation closes.

```json
{
  "softMaxConnectionAgeSeconds": 3600,
  "hardMaxConnectionAgeSeconds": 28800,
  "mcpServers": [
    {
      "name": "authenticated-server",
      "command": "authenticated-mcp",
      "authErrorPatterns": [
        "credentials have expired",
        "authentication failed"
      ],
      "authRetryTools": [
        "search_*",
        "read_*"
      ]
    }
  ]
}
```

| Field | Default | Behavior |
|-------|---------|----------|
| `softMaxConnectionAgeSeconds` | `3600` | On the first reuse at or after this age, drain the old generation and open one replacement |
| `hardMaxConnectionAgeSeconds` | `28800` | At this age, stop assigning new calls and close as soon as active calls finish; reopen lazily on future use |
| `authErrorPatterns` | `[]` | Case-insensitive substrings that identify authentication failures in returned payloads or thrown errors |
| `authRetryTools` | `[]` | Tool-name wildcard patterns explicitly safe to retry once after authentication recovery |

All four fields may be set globally or per server. Per-server values override global values. Set either age to `0` to disable that policy. The legacy `maxConnectionAgeSeconds` field remains accepted as an alias for `softMaxConnectionAgeSeconds`.

Authentication failures always invalidate the exact backend generation that produced them. Automatic replay occurs only for tools matching `authRetryTools`; mutating or unknown tools are not replayed because the proxy cannot prove whether the failed attempt had side effects.

### Large Outputs And Call Scripts

Outputs larger than `cli.payloadThreshold` are stored in a private `0700` directory as `0600` files. The result returned to the model contains a payload ID and path instead of the full content. Daemon integrations can expose `payload-read` and `payload-find` so a model can page through the content, load the remainder deliberately, or find literal text with bounded context. The default threshold and page size are 10K characters.

The daemon also exposes a `script` operation for sequential MCP calls. Scripts are declarative JSON with at most 20 steps; they never execute shell or JavaScript. A later step can use a prior JSON result through an RFC 6901 JSON Pointer reference. References substitute exact values and do not transform them, so the selected field must already match the next tool's expected input:

```json
{
  "steps": [
    {
      "id": "search",
      "server": "docs",
      "tool": "search",
      "arguments": { "query": "topic" }
    },
    {
      "id": "read",
      "server": "docs",
      "tool": "read",
      "arguments": {
        "url": { "$ref": "search#/results/0/url" }
      }
    }
  ]
}
```

Scripts stop on the first failed step by default. Set `continueOnError` on an individual step to continue. Large step results are cached before the script summary is returned, but the full raw result remains available to references in later steps.

## 🔧 Configuration

### Server Configuration

Create or edit your JSON configuration file at:
- `~/.mcp-compression-proxy/servers.json` (user-level), or
- `./servers.json` (project-level)

```json
{
  "mcpServers": [
    {
      "name": "my-server",
      "command": "command-to-run",
      "args": ["arg1", "arg2"],
      "env": {
        "ENV_VAR": "value"
      },
      "enabled": true
    }
  ]
}
```

#### Configuration Schema

**Root Level:**
| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `mcpServers` | array | ✅ | Array of server configurations |
| `excludeTools` | string[] | ❌ | Tool name patterns to exclude from tool list entirely (supports wildcards) |
| `noCompressTools` | string[] | ❌ | Tool name patterns to never compress - descriptions pass through unchanged (supports wildcards) |
| `defaultTimeout` | number | ❌ | Default timeout in seconds for all servers (default: 30). Can be overridden per-server. |
| `inheritEnv` | boolean \| string[] | ❌ | Which of the proxy's environment variables backend servers inherit (default: `true`). Can be overridden per-server. |
| `compressionFallbackBehavior` | `"original"` \| `"blank"` | ❌ | What to show for a tool that has not been compressed yet (default: `"original"`) |

**Server Configuration:**
| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | ✅ | Unique server identifier |
| `command` | string | ⬥ | Command to execute (local stdio server) |
| `url` | string | ⬥ | Endpoint of a hosted MCP server (Streamable HTTP) |
| `args` | string[] | ❌ | Command arguments (`command` servers only) |
| `env` | object | ❌ | Environment variables (`command` servers only) |
| `inheritEnv` | boolean \| string[] | ❌ | Overrides the root-level `inheritEnv` for this server (`command` servers only) |
| `headers` | object | ❌ | Static HTTP headers sent with every request (`url` servers only) |
| `enabled` | boolean | ❌ | Enable/disable server (default: true) |
| `timeout` | number | ❌ | Server-specific timeout in seconds (overrides `defaultTimeout`) |

⬥ Exactly one of `command` or `url` is required. Unknown fields are rejected,
so a misspelled key fails at startup instead of producing a server that never
starts.

#### Remote (HTTP) Servers

A server entry with `url` instead of `command` is reached over Streamable HTTP
rather than spawned as a subprocess:

```json
{
  "mcpServers": [
    {
      "name": "remote-example",
      "url": "https://mcp.example.com/mcp",
      "headers": {
        "Authorization": "Bearer ${EXAMPLE_API_TOKEN}"
      },
      "enabled": true,
      "timeout": 30
    }
  ]
}
```

`headers` values go through the same `${VAR}` expansion as `env`, which is how
credentials stay out of the config file. There is no OAuth flow — a browser
redirect has nowhere to go in a headless proxy — so a static bearer token or
API-key header is the supported form of authentication.

`args`, `env` and `inheritEnv` configure a process the proxy spawns itself and
have no meaning for a remote server. Setting any of them alongside `url` is
rejected at startup rather than silently ignored, as is setting both `command`
and `url`.

#### Environment Variable Expansion

Use `${VAR_NAME}` syntax to reference environment variables:

```json
{
  "mcpServers": [
    {
      "name": "github",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": {
        "GITHUB_PERSONAL_ACCESS_TOKEN": "${GITHUB_TOKEN}",
        "GITHUB_ORG": "${MY_GITHUB_ORG}"
      }
    }
  ]
}
```

Variables are expanded at runtime from your shell environment.

Two extra forms are supported:

| Syntax | Meaning |
|--------|---------|
| `${VAR}` | Substitutes `VAR`, or an empty string with a warning if it is not set |
| `${VAR:-fallback}` | Substitutes `VAR`, or `fallback` when unset or empty |
| `$${VAR}` | Escapes the expansion — produces the literal text `${VAR}` |

If a `${VAR}` reference cannot be resolved, the proxy logs a warning naming
the variable. An unset variable becomes an empty string, which downstream
servers usually report as an authentication failure rather than a config
error, so check the startup log first when a server rejects valid-looking
credentials.

#### What Backend Servers Inherit

Backend servers inherit the proxy's full environment by default, so variables
you exported in your shell are visible to them without being listed in `env`.
Entries in `env` always take precedence over inherited values.

Narrow this with `inheritEnv` when a server should not see unrelated secrets:

```json
{
  "inheritEnv": ["HOME", "PATH", "LANG"],
  "mcpServers": [
    {
      "name": "trusted",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "inheritEnv": true
    },
    {
      "name": "untrusted",
      "command": "some-third-party-server",
      "inheritEnv": false,
      "env": { "API_KEY": "${THIRD_PARTY_KEY}" }
    }
  ]
}
```

| Value | Effect |
|-------|--------|
| `true` (default) | Pass the proxy's full environment through |
| `false` | Pass only the stdio transport's safe defaults (`PATH`, `HOME`, `SHELL`, …) |
| `string[]` | Pass only the named variables, plus the transport's safe defaults |

#### Uncompressed Tool Descriptions

Before a tool has been compressed, the proxy shows its original description.
Set `compressionFallbackBehavior` to `"blank"` to show nothing instead, so
uncompressed tools cost no context while you work through them:

```json
{
  "compressionFallbackBehavior": "blank",
  "mcpServers": []
}
```

This affects only tools with no cached compressed description. Compressed
tools, expanded tools, and anything matching `noCompressTools` are unchanged.

#### Server Initialization and Timeouts

The proxy initializes all configured MCP servers in **parallel** before becoming ready. Each server connection is wrapped with a timeout to prevent indefinite hanging:

- **Default timeout**: 30 seconds (if not specified)
- **Global timeout**: Set `defaultTimeout` in config to change the default for all servers
- **Per-server timeout**: Set `timeout` on individual servers to override the default

```json
{
  "defaultTimeout": 60,
  "mcpServers": [
    {
      "name": "fast-server",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"]
    },
    {
      "name": "slow-server",
      "command": "python",
      "args": ["slow_mcp_server.py"],
      "timeout": 120
    }
  ]
}
```

**Behavior:**
- All servers initialize in parallel (not sequentially)
- If a server exceeds its timeout, it's marked as failed but doesn't block other servers
- The proxy reports ready only after all servers have either connected or timed out
- This ensures all available tools are loaded before the MCP client can query them

**Why this matters:** Without proper timeout handling, a single hanging server could make the entire proxy unresponsive.

#### Tool Filtering Patterns

**Exclude Tools** - Remove tools from the tool list entirely:

Use the `excludeTools` field to filter out unwanted tools using wildcard patterns (case-insensitive):

```json
{
  "mcpServers": [...],
  "excludeTools": [
    "github__delete_*",     // Exclude all GitHub delete tools
    "*__experimental*",     // Exclude all experimental tools
    "filesystem__write_*",  // Exclude filesystem write tools
    "set_*"                 // Exclude management tools starting with set_
  ]
}
```

**No-Compress Tools** - Keep tools but never compress their descriptions:

Use the `noCompressTools` field to bypass compression for specific tools (descriptions pass through unchanged):

```json
{
  "mcpServers": [...],
  "noCompressTools": [
    "filesystem__*",        // Never compress filesystem tool descriptions
    "*__help",              // Never compress help commands
    "github__search_*"      // Never compress GitHub search tools
  ]
}
```

**Pattern Examples:**
- `"serverName__*"` - All tools from specific server
- `"*__toolPattern*"` - Tools matching pattern from any server
- `"exact_tool_name"` - Exact tool name match

**Use Cases:**
- **excludeTools**: Remove dangerous tools, unwanted features, or tools not relevant to your workflow
- **noCompressTools**: Preserve detailed descriptions for complex tools where compression might lose important information

#### Configuration Aggregation

Both config files are loaded and combined:

1. Load user config (`~/.mcp-compression-proxy/servers.json`)
2. Load project config (`./servers.json`)
3. Aggregate servers from both configs
4. Aggregate exclude and noCompress patterns from both configs
5. Apply exclude patterns to filter tools
6. Apply noCompress patterns to bypass compression

This allows:
- Personal defaults in user config
- Team/project-specific servers in project config
- Fine-grained tool filtering with exclude patterns
- Selective compression bypass with noCompress patterns

### Environment Variables

**For the compression proxy** (set in your MCP client config):
- `LOG_LEVEL` - Logging level (debug, info, warn, error). Default: `info`

**For MCP servers** (set in `servers.json` using `${VAR_NAME}` syntax):
- `GITHUB_TOKEN` - GitHub personal access token (if using GitHub MCP server)
- Any other environment variables required by your configured MCP servers

See [Environment Variable Expansion](#environment-variable-expansion) for details on using variables in your server configuration.

### Command-Line Options

**`--clear-cache`** - Clear the persistent compression cache and exit

```bash
# If installed via npm
mcp-compression-proxy --clear-cache

# If installed from source
node dist/index.js --clear-cache
```

### Debugging

**1. Enable debug logging** in your MCP client config:

```json
{
  "mcpServers": {
    "compression-proxy": {
      "command": "mcp-compression-proxy",
      "env": {
        "LOG_LEVEL": "debug"
      }
    }
  }
}
```

**2. View logs** (for Claude Desktop):
- **macOS**: `~/Library/Logs/Claude/mcp*.log`
- **Windows**: `%APPDATA%\Claude\Logs\mcp*.log`

**3. Check for common issues:**
- Ensure all configured MCP servers are accessible and properly configured
- Verify environment variables are correctly expanded
- Check that Node.js version is 18 or higher

## 💡 Best Practices

### Good Compression

**Preserves**:
- Core functionality
- Key parameters
- Critical constraints
- Return types

**Removes**:
- Verbose explanations
- Redundant phrases
- Non-critical examples
- Marketing language

### Example

**Original** (42 tokens):
```
"Searches for files in the specified directory and its subdirectories using
glob patterns. Supports wildcards like *, **, and ?. Returns an array of
matching file paths. Case-sensitive by default."
```

**Compressed** (12 tokens):
```
"Search files by glob pattern (*, **, ?), case-sensitive, returns paths"
```

## ❓ FAQ

<details>
<summary><strong>Q: What MCP clients are supported?</strong></summary>
<p>Any MCP-compatible client: Claude Desktop, Cline, Continue.dev, or custom agents.</p>
</details>

<details>
<summary><strong>Q: How much context does compression save?</strong></summary>
<p>Typically 50-80% reduction in token count for tool listings while preserving critical information.</p>
</details>

<details>
<summary><strong>Q: Do I need to restart after adding servers?</strong></summary>
<p>Standalone mode needs a restart to load the new configuration. Managed router deployments can start and activate a refreshed daemon while agent sessions stay connected.</p>
</details>

<details>
<summary><strong>Q: Can I use multiple MCP servers?</strong></summary>
<p>Yes. Add each backend to <code>servers.json</code> and expose them through the same proxy endpoint.</p>
</details>

<details>
<summary><strong>Q: Is compression permanent?</strong></summary>
<p>The proxy stores compressed descriptions at <code>~/.mcp-compression-proxy/cache.json</code> and restores them on restart. Session-based expansions reset per session.</p>
</details>

<details>
<summary><strong>Q: Where is the compression cache stored?</strong></summary>
<p>Cache is stored at <code>~/.mcp-compression-proxy/cache.json</code>. Use <code>--clear-cache</code> flag to clear it if needed.</p>
</details>

<details>
<summary><strong>Q: Works with local LLMs?</strong></summary>
<p>Yes. Any MCP-compatible client can use the proxy, including clients backed by local models.</p>
</details>

<details>
<summary><strong>Q: How do I add a new MCP server?</strong></summary>
<p>Add the server to <code>servers.json</code> in <code>~/.mcp-compression-proxy/</code> or the project root. Restart standalone mode or activate a refreshed daemon through your router.</p>
</details>

<details>
<summary><strong>Q: Can a deployment upgrade without restarting agents?</strong></summary>
<p>Yes. Run releases on separate daemon sockets and keep a stable router in front. The router sends new requests to the activated release, keeps in-flight requests on the previous release, and retires it after drain.</p>
</details>

<details>
<summary><strong>Q: What happens to large tool results?</strong></summary>
<p>The proxy stores results above 10K in owner-only files and returns a payload ID. Clients can search the file or read it in 10K pages instead of placing the full result in model context.</p>
</details>

**More:** See [CONTRIBUTING.md][contributing], [SECURITY.md][security], [tests/README.md](./tests/README.md)

## 🧪 Testing

Comprehensive test suite included:

```bash
npm test                      # Run all tests
npm run test:unit             # Unit tests only
npm run test:integration      # Integration tests only
npm run test:e2e              # End-to-end tests only
npm run test:e2e:real-llm     # Real LLM integration tests (requires Ollama)
npm run test:coverage         # Generate coverage report
```

See [tests/README.md](./tests/README.md) for details.

## 🤝 Contributing

Contributions welcome! See [CONTRIBUTING.md][contributing] for guidelines.

Quick start:

1. Fork the repository
2. Create your feature branch
3. Make your changes and test
4. Commit using [Conventional Commits](https://www.conventionalcommits.org/)
5. Open a Pull Request

Note: This project follows a [Code of Conduct][code-of-conduct].

## 🔗 Complementary Projects

**Maximize your MCP workflow with these complementary tools:**

### [Local Skills MCP][local-skills-mcp]

**Portable, reusable prompt libraries for any MCP client**

While MCP Compression Proxy optimizes your tool descriptions, [Local Skills MCP][local-skills-mcp] provides expert-level prompt instructions that work across any MCP-compatible client.

**Perfect combination:**
- **MCP Compression Proxy** - Aggregates and compresses tool descriptions (50-80% token reduction)
- **Local Skills MCP** - Provides expert skills with lazy loading (~50 tokens/skill)

**Together they enable:**
- 🎯 Optimized context usage across tools AND prompts
- 🔄 Portable workflows that work with Claude, Cline, Continue.dev, and more
- ⚡ Efficient AI interactions with minimal context consumption
- 🚀 Professional-grade AI agent capabilities

[Learn more about Local Skills MCP →][local-skills-mcp]

## 💖 Support This Project

If you find MCP Compression Proxy useful, please consider supporting its development!

<div align="center">

[![GitHub Sponsors][sponsor-github-badge]][sponsor-github]
[![Buy Me A Coffee][sponsor-coffee-badge]][sponsor-coffee]
[![PayPal][sponsor-paypal-badge]][sponsor-paypal]

</div>

**Ways to support:**

- ⭐ [Star this repository][stargazers]
- 💰 Sponsor via the badges above
- 🐛 [Report bugs and suggest features][repo-issues]
- 📝 [Contribute code or documentation][contributing]

## 📄 License

MIT License - see [LICENSE][license-file] file. **Copyright © 2025 KDPA**

## 🙏 Acknowledgments

Built with [Model Context Protocol SDK][mcp-sdk]

---

<div align="center">

**[⬆ Back to Top](#-mcp-compression-proxy)**

Made with ❤️ by KDPA

</div>

<!-- Reference Links -->
<!-- Badges - Top of README -->

[npm-version-badge]: https://img.shields.io/npm/v/mcp-compression-proxy.svg
[npm-package]: https://www.npmjs.com/package/mcp-compression-proxy
[npm-downloads-badge]: https://img.shields.io/npm/dm/mcp-compression-proxy
[npm-types-badge]: https://img.shields.io/npm/types/mcp-compression-proxy
[license-badge]: https://img.shields.io/badge/License-MIT-yellow.svg
[license]: https://opensource.org/licenses/MIT
[node-badge]: https://img.shields.io/badge/node-%3E%3D22.0.0-brightgreen.svg
[nodejs]: https://nodejs.org/
[mcp-badge]: https://img.shields.io/badge/MCP-Compatible-purple.svg
[mcp-protocol]: https://modelcontextprotocol.io/
[mcp-sampling]: https://modelcontextprotocol.io/docs/concepts/sampling

<!-- CI/CD Badges -->

[ci-badge]: https://github.com/kdpa-llc/mcp-compression-proxy/actions/workflows/test.yml/badge.svg
[ci-workflow]: https://github.com/kdpa-llc/mcp-compression-proxy/actions/workflows/test.yml
[codecov-badge]: https://codecov.io/gh/kdpa-llc/mcp-compression-proxy/branch/main/graph/badge.svg
[codecov]: https://codecov.io/gh/kdpa-llc/mcp-compression-proxy
[codeql-badge]: https://github.com/kdpa-llc/mcp-compression-proxy/actions/workflows/codeql.yml/badge.svg
[codeql-workflow]: https://github.com/kdpa-llc/mcp-compression-proxy/actions/workflows/codeql.yml

<!-- GitHub Badges -->

[stars-badge]: https://img.shields.io/github/stars/kdpa-llc/mcp-compression-proxy?style=social
[stargazers]: https://github.com/kdpa-llc/mcp-compression-proxy/stargazers
[forks-badge]: https://img.shields.io/github/forks/kdpa-llc/mcp-compression-proxy?style=social
[network]: https://github.com/kdpa-llc/mcp-compression-proxy/network/members
[issues-badge]: https://img.shields.io/github/issues/kdpa-llc/mcp-compression-proxy
[repo-issues]: https://github.com/kdpa-llc/mcp-compression-proxy/issues
[commit-badge]: https://img.shields.io/github/last-commit/kdpa-llc/mcp-compression-proxy
[commits]: https://github.com/kdpa-llc/mcp-compression-proxy/commits/main
[prs-badge]: https://img.shields.io/badge/PRs-welcome-brightgreen.svg

<!-- Repository Links -->

[repo]: https://github.com/kdpa-llc/mcp-compression-proxy
[pulls]: https://github.com/kdpa-llc/mcp-compression-proxy/pulls

<!-- Documentation Links -->

[contributing]: CONTRIBUTING.md
[security]: SECURITY.md
[code-of-conduct]: CODE_OF_CONDUCT.md
[license-file]: LICENSE

<!-- Sponsorship Links -->

[sponsor-github-badge]: https://img.shields.io/badge/Sponsor-GitHub%20Sponsors-ea4aaa?logo=github
[sponsor-github]: https://github.com/sponsors/moscaverd
[sponsor-coffee-badge]: https://img.shields.io/badge/Buy%20Me%20A%20Coffee-support-yellow?logo=buy-me-a-coffee
[sponsor-coffee]: https://buymeacoffee.com/moscaverd
[sponsor-paypal-badge]: https://img.shields.io/badge/PayPal-donate-blue?logo=paypal
[sponsor-paypal]: https://paypal.me/moscaverd

<!-- External Links -->

[mcp-sdk]: https://github.com/modelcontextprotocol/sdk
[local-skills-mcp]: https://github.com/kdpa-llc/local-skills-mcp
