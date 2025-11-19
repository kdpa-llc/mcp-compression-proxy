<div align="center">

# 🗜️ MCP Compression Proxy

**Aggregate tools from multiple MCP servers with intelligent LLM-based description compression**

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
[Features](#-features) •
[Configuration](#-configuration) •
[FAQ](#-faq) •
[Contributing](#-contributing)

</div>

---

## 📑 Table of Contents

- [What is MCP Compression Proxy?](#what-is-mcp-compression-proxy)
- [✨ Features](#-features)
- [🚀 Quick Start](#-quick-start)
- [🎯 Usage](#-usage)
- [🔧 Configuration](#-configuration)
- [💡 Best Practices](#-best-practices)
- [❓ FAQ](#-faq)
- [🧪 Testing](#-testing)
- [🤝 Contributing](#-contributing)
- [💖 Support This Project](#-support-this-project)

---

## What is MCP Compression Proxy?

A **Model Context Protocol (MCP) server** that solves two common problems:

1. **Multi-server aggregation**: Access tools from multiple MCP servers through a single connection
2. **Context optimization**: Reduce token consumption by 50-80% using intelligent LLM-based description compression

Instead of connecting to multiple MCP servers separately and consuming thousands of tokens on verbose tool descriptions, MCP Compression Proxy aggregates all your tools and compresses their descriptions intelligently—preserving critical information while removing redundancy.

**Perfect for:**
- Users with many MCP servers (filesystem, GitHub, databases, etc.)
- AI agents working with limited context windows
- Anyone wanting to minimize token costs while maximizing tool availability

## ✨ Features

- **🔗 Multi-Server Aggregation** - Access tools from multiple MCP servers through one connection
- **🤖 LLM-Based Compression** - Intelligent description compression (50-80% token reduction)
- **💾 Persistent Storage** - Compressed descriptions saved to disk and restored on restart
- **🎭 Session-Based Expansion** - Independent expansion state per conversation
- **⚡ Parallel Initialization** - All servers connect in parallel with configurable timeouts
- **🎯 Selective Expansion** - Compress all tools, expand only what you need
- **📦 Zero Config** - Works out-of-the-box with sensible defaults
- **🔥 Standard MCP** - Compatible with any MCP client (Claude Desktop, Cline, etc.)

## 🚀 Quick Start

### Prerequisites

- **Node.js 18+** installed on your system
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

> **Note:** No rebuild needed! Just edit the JSON file and restart your MCP client.

#### Migration from TypeScript Config (if upgrading)

If you're upgrading from a previous version that used TypeScript configuration:

```bash
# Migrate to user-level config
npm run migrate-config

# Or migrate to project-level config
npm run migrate-config ./servers.json
```

The migration script will:
1. Read your TypeScript configuration
2. Convert it to JSON format
3. Save it to the specified location
4. Warn if config already exists (prevents accidental overwrites)

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
| `get_uncompressed_tools` | Get tools that need compression (batch processing) |
| `cache_compressed_tools` | Save compressed descriptions to cache (batch processing) |
| `expand_tool` | Expand a tool to show full description (session-specific) |
| `collapse_tool` | Collapse tool back to compressed description |

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

**Server Configuration:**
| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | ✅ | Unique server identifier |
| `command` | string | ✅ | Command to execute |
| `args` | string[] | ❌ | Command arguments |
| `env` | object | ❌ | Environment variables |
| `enabled` | boolean | ❌ | Enable/disable server (default: true) |
| `timeout` | number | ❌ | Server-specific timeout in seconds (overrides `defaultTimeout`) |

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
<p>Yes, restart your MCP client to load the new configuration. No rebuild needed when using JSON configuration.</p>
</details>

<details>
<summary><strong>Q: Can I use multiple MCP servers?</strong></summary>
<p>Yes! That's the primary use case. Add as many as you need in your <code>servers.json</code> configuration file.</p>
</details>

<details>
<summary><strong>Q: Is compression permanent?</strong></summary>
<p>Compressed descriptions are persisted to disk at <code>~/.mcp-compression-proxy/cache.json</code> and automatically restored on server restart. Session-based expansions are temporary and reset per session.</p>
</details>

<details>
<summary><strong>Q: Where is the compression cache stored?</strong></summary>
<p>Cache is stored at <code>~/.mcp-compression-proxy/cache.json</code>. Use <code>--clear-cache</code> flag to clear it if needed.</p>
</details>

<details>
<summary><strong>Q: Works with local LLMs?</strong></summary>
<p>Yes! Works with any MCP-compatible setup, including local models.</p>
</details>

<details>
<summary><strong>Q: How do I add a new MCP server?</strong></summary>
<p>Edit your <code>servers.json</code> configuration file (in <code>~/.mcp-compression-proxy/</code> or project root), add your server config, and restart your MCP client. No rebuild needed.</p>
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

While MCP Tool Aggregator optimizes your tool descriptions, [Local Skills MCP][local-skills-mcp] provides expert-level prompt instructions that work across any MCP-compatible client.

**Perfect combination:**
- **MCP Tool Aggregator** - Aggregates and compresses tool descriptions (50-80% token reduction)
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
[node-badge]: https://img.shields.io/badge/node-%3E%3D18.0.0-brightgreen.svg
[nodejs]: https://nodejs.org/
[mcp-badge]: https://img.shields.io/badge/MCP-Compatible-purple.svg
[mcp-protocol]: https://modelcontextprotocol.io/

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
