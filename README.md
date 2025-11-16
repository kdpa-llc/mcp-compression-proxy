<div align="center">

# 🗜️ MCP Tool Aggregator

**Aggregate tools from multiple MCP servers with intelligent LLM-based description compression**

[![npm version][npm-version-badge]][npm-package]
[![License: MIT][license-badge]][license]
[![Node][node-badge]][nodejs]
[![MCP][mcp-badge]][mcp-protocol]

[![CI][ci-badge]][ci-workflow]
[![codecov][codecov-badge]][codecov]

[![GitHub Stars][stars-badge]][stargazers]
[![GitHub Forks][forks-badge]][network]
[![GitHub Issues][issues-badge]][repo-issues]
[![GitHub Last Commit][commit-badge]][commits]
[![PRs Welcome][prs-badge]][contributing]

[Quick Start](#-quick-start) •
[Features](#-features) •
[Usage](#-usage) •
[FAQ](#-faq) •
[Contributing](#-contributing)

</div>

---

## 📑 Table of Contents

- [What is MCP Tool Aggregator?](#what-is-mcp-tool-aggregator)
- [✨ Features](#-features)
- [🚀 Quick Start](#-quick-start)
- [🎯 Usage](#-usage)
- [🔧 Configuration](#-configuration)
- [💡 Best Practices](#-best-practices)
- [❓ FAQ](#-faq)
- [🤝 Contributing](#-contributing)

---

## What is MCP Tool Aggregator?

A **Model Context Protocol (MCP) server** that aggregates tools from multiple MCP servers with **LLM-based description compression** to optimize context usage. Reduce token consumption by 50-80% while maintaining full tool functionality.

Access tools from filesystem, GitHub, databases, and more through a single MCP connection—with intelligent compression that preserves critical information while removing verbose explanations.

## ✨ Features

- **🔗 Multi-Server Aggregation** - Access tools from multiple MCP servers through one connection
- **🤖 LLM-Based Compression** - Intelligent description compression (50-80% token reduction)
- **🎭 Session-Based Expansion** - Independent expansion state per conversation
- **⚡ Eager Loading** - All servers connect at startup for zero-latency access
- **🎯 Selective Expansion** - Compress all tools, expand only what you need
- **📦 Zero Config** - Works out-of-the-box with sensible defaults
- **🔥 Standard MCP** - Compatible with any MCP client (Claude Desktop, Cline, etc.)

## 🚀 Quick Start

### Install

```bash
git clone https://github.com/kdpa-llc/mcp-compression-proxy.git
cd mcp-compression-proxy
npm install
npm run build
```

**Requirements:** Node.js 18+, any MCP-compatible client

### Configure MCP Client

Add to your MCP client configuration (e.g., Claude Desktop config):

**macOS**: `~/Library/Application Support/Claude/claude_desktop_config.json`
**Windows**: `%APPDATA%\Claude\claude_desktop_config.json`

```json
{
  "mcpServers": {
    "aggregator": {
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

### Configure Servers

Edit `src/config/servers.ts` to add MCP servers:

```typescript
export const mcpServers: MCPServerConfig[] = [
  {
    name: 'filesystem',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-filesystem', '/tmp'],
    enabled: true,
  },
  {
    name: 'github',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-github'],
    env: {
      GITHUB_PERSONAL_ACCESS_TOKEN: process.env.GITHUB_TOKEN || '',
    },
    enabled: true,
  },
];
```

Rebuild after changes:
```bash
npm run build
```

### Restart Client

Restart your MCP client (e.g., Claude Desktop) to load the configuration.

## 🎯 Usage

### Tool Naming

Tools use the format `serverName__toolName`:
- `filesystem__read_file`
- `filesystem__write_file`
- `github__create_issue`

### Management Tools

| Tool | Description |
|------|-------------|
| `create_session` | Create a new session for independent tool expansion |
| `set_session` | Set the active session |
| `delete_session` | Delete a session |
| `compress_tools` | Get tools for compression |
| `save_compressed_tools` | Save compressed descriptions to cache |
| `expand_tool` | Expand a tool to show full description (session-specific) |
| `collapse_tool` | Collapse tool back to compressed description |

### Workflow Example

#### Before Compression

```
User: What tools do you have?

Claude: I have access to these tools:
- filesystem__read_file: Reads the complete contents of a file at the
  specified path. The file must exist and be readable. Returns the file
  contents as text. Supports absolute and relative paths. Maximum file
  size is 10MB...
```

#### Enable Compression (One-Time Setup)

```
User: Compress the tool descriptions to save context

Claude: I'll compress the tool descriptions:
1. *calls compress_tools* - Gets all tools
2. *compresses descriptions intelligently*
3. *calls save_compressed_tools* - Saves compressed versions

Done! Tool descriptions are now compressed.
```

#### After Compression

```
User: What tools do you have?

Claude: I have access to these tools:
- filesystem__read_file: Read file (text, max 10MB)
- filesystem__write_file: Write to file (create/overwrite)
- github__create_issue: Create GH issue (title, body, labels)
```

**Result**: 70% fewer tokens used for tool listings!

## 🔧 Configuration

### Server Configuration

Edit `src/config/servers.ts`:

```typescript
export const mcpServers: MCPServerConfig[] = [
  {
    name: 'my-server',
    command: 'command-to-run',
    args: ['arg1', 'arg2'],
    env: {
      ENV_VAR: 'value',
    },
    enabled: true,
  },
];
```

### Environment Variables

- `LOG_LEVEL` - Logging level (debug, info, warn, error). Default: `info`
- `GITHUB_TOKEN` - GitHub personal access token (if using GitHub server)
- Any environment variables needed by underlying MCP servers

### Debugging

Enable debug logging in your MCP client config:

```json
{
  "env": {
    "LOG_LEVEL": "debug"
  }
}
```

View logs:
- **macOS**: `~/Library/Logs/Claude/mcp*.log`
- **Windows**: `%APPDATA%\Claude\Logs\mcp*.log`

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
<p>Yes, rebuild (<code>npm run build</code>) and restart your MCP client.</p>
</details>

<details>
<summary><strong>Q: Can I use multiple MCP servers?</strong></summary>
<p>Yes! That's the primary use case. Add as many as you need in <code>src/config/servers.ts</code>.</p>
</details>

<details>
<summary><strong>Q: Is compression permanent?</strong></summary>
<p>Compression is cached in-memory and resets on server restart. Session-based expansions are temporary.</p>
</details>

<details>
<summary><strong>Q: Works with local LLMs?</strong></summary>
<p>Yes! Works with any MCP-compatible setup, including local models.</p>
</details>

<details>
<summary><strong>Q: How do I add a new MCP server?</strong></summary>
<p>Edit <code>src/config/servers.ts</code>, add your server config, rebuild, and restart your client.</p>
</details>

**More:** See [CONTRIBUTING.md][contributing], [tests/README.md](./tests/README.md)

## 🤝 Contributing

Contributions welcome! See [CONTRIBUTING.md][contributing] for guidelines.

Quick start:

1. Fork the repository
2. Create your feature branch
3. Make your changes and test
4. Commit using [Conventional Commits](https://www.conventionalcommits.org/)
5. Open a Pull Request

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

## 📄 License

MIT License - see [LICENSE][license-file] file. **Copyright © 2025 KDPA**

## 🙏 Acknowledgments

Built with [Model Context Protocol SDK][mcp-sdk]

---

<div align="center">

**[⬆ Back to Top](#-mcp-tool-aggregator)**

Made with ❤️ by KDPA

</div>

<!-- Reference Links -->
<!-- Badges - Top of README -->

[npm-version-badge]: https://img.shields.io/npm/v/mcp-tool-aggregator.svg
[npm-package]: https://www.npmjs.com/package/mcp-tool-aggregator
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

<!-- Documentation Links -->

[contributing]: CONTRIBUTING.md
[license-file]: LICENSE

<!-- External Links -->

[mcp-sdk]: https://github.com/modelcontextprotocol/sdk
