# MCP Tool Aggregator

An MCP server that aggregates tools from multiple MCP servers with **LLM-based description compression** to optimize context usage.

Use with Claude Desktop, Cline, or any MCP client to access tools from multiple MCP servers through a single connection, with intelligent compression to reduce token count by 50-80%.

## Features

- **Multi-Server Aggregation**: Access tools from multiple MCP servers through one MCP connection
- **LLM-Based Description Compression**: Reduce context usage by 50-80% with intelligent tool description compression
- **Session-Based Expansion**: Independent expansion state per conversation
- **Advanced Filtering**: Compress all tools, expand only what you need
- **Eager Loading**: All underlying servers connect at startup for zero-latency tool access
- **Standard MCP Protocol**: Works with any MCP client (Claude Desktop, Cline, etc.)

## How It Works

```
┌──────────────────────────────────┐
│  Claude Desktop (MCP Client)     │
│  or other MCP client             │
└────────────┬─────────────────────┘
             │ stdio
             ▼
┌──────────────────────────────────┐
│  MCP Tool Aggregator             │
│  (this server)                   │
│                                  │
│  - Aggregates tools              │
│  - Compresses descriptions       │
│  - Manages sessions              │
└────┬──────────┬──────────────────┘
     │          │
     │ stdio    │ stdio
     ▼          ▼
┌─────────┐  ┌──────────┐
│  MCP    │  │   MCP    │
│ Server 1│  │ Server 2 │
│(filesystem)│(github)  │
└─────────┘  └──────────┘
```

## Installation

```bash
git clone <repository-url>
cd mcp-compression-proxy
npm install
npm run build
```

## Configuration

### 1. Configure Underlying MCP Servers

Edit `src/config/servers.ts` to add the MCP servers you want to aggregate:

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

### 2. Add to Claude Desktop

Add to your Claude Desktop config file:

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

### 3. Restart Claude Desktop

Restart Claude Desktop to load the configuration.

## Usage

### Tool Naming

Tools from aggregated servers use the format:
```
serverName__toolName
```

Examples:
- `filesystem__read_file`
- `filesystem__write_file`
- `github__create_issue`

### Management Tools

The aggregator also exposes these management tools:

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

#### Initial State (No Compression)

```
User: What tools do you have?

Claude: I have access to these tools:
- filesystem__read_file: Reads the complete contents of a file at the specified path. The file must exist and be readable. Returns the file contents as text. Supports absolute and relative paths. Maximum file size is 10MB.
- filesystem__write_file: Writes content to a file...
- github__create_issue: Creates a new GitHub issue...
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

#### Using Tools

```
User: Read the file /tmp/example.txt

Claude: *calls filesystem__read_file with arguments {"path": "/tmp/example.txt"}*

File contents: "Hello, world!"
```

#### Selective Expansion

```
User: I need more details about the read_file tool

Claude: Let me expand it:
1. *calls create_session* - Creates session
2. *calls expand_tool with filesystem, read_file*
3. Tool now shows full description in this conversation

Full description: "Reads the complete contents of a file at the specified path..."

When I'm done, I'll collapse it back to save context.
```

## Tool Compression Best Practices

### What Makes Good Compression

**Good compression preserves**:
- Core functionality
- Key parameters
- Critical constraints
- Return types

**Good compression removes**:
- Verbose explanations
- Redundant phrases
- Non-critical examples
- Marketing language

### Example Compressions

#### Good ✅

**Original** (42 tokens):
```
"Searches for files in the specified directory and its subdirectories using glob patterns. Supports wildcards like *, **, and ?. Returns an array of matching file paths. Case-sensitive by default."
```

**Compressed** (12 tokens):
```
"Search files by glob pattern (*, **, ?), case-sensitive, returns paths"
```

#### Bad ❌

**Original** (30 tokens):
```
"Creates a new GitHub issue with the specified title, body, labels, and assignees. Requires authentication."
```

**Compressed** (8 tokens - too aggressive):
```
"Make GitHub issue"
```

**Problem**: Lost critical parameter details and auth requirement.

**Better** (15 tokens):
```
"Create GitHub issue (title, body, labels, assignees), needs auth"
```

## Development

```bash
npm run dev    # Development mode with auto-reload
npm run build  # Build for production
npm start      # Run production build
```

## Environment Variables

- `LOG_LEVEL` - Logging level (debug, info, warn, error). Default: `info`
- `GITHUB_TOKEN` - GitHub personal access token (if using github server)
- Any other environment variables needed by underlying MCP servers

## Debugging

Enable debug logging:

```json
{
  "mcpServers": {
    "aggregator": {
      "command": "node",
      "args": ["/path/to/dist/index.js"],
      "env": {
        "LOG_LEVEL": "debug"
      }
    }
  }
}
```

View logs:
- **macOS**: `~/Library/Logs/Claude/mcp*.log`
- **Windows**: `%APPDATA%\Claude\Logs\mcp*.log`

## Architecture

```
┌─────────────────────────────────────────────┐
│      MCP Tool Aggregator                    │
│                                             │
│  ┌───────────────────────────────────────┐ │
│  │  Session Manager                      │ │
│  │  - Per-client expansion state         │ │
│  │  - Auto-expiration (30min)            │ │
│  └───────────────────────────────────────┘ │
│                                             │
│  ┌───────────────────────────────────────┐ │
│  │  Compression Cache                    │ │
│  │  - Compressed descriptions            │ │
│  │  - 50-80% token reduction             │ │
│  └───────────────────────────────────────┘ │
│                                             │
│  ┌───────────────────────────────────────┐ │
│  │  MCP Client Manager                   │ │
│  │  - Eager connection at startup        │ │
│  │  - Connection pooling                 │ │
│  └───────────────────────────────────────┘ │
└─────────────────────────────────────────────┘
```

## Use Cases

1. **Context Optimization**: Reduce token usage when working with many tools
2. **Multi-Tool Workflows**: Access filesystem, GitHub, database tools through one connection
3. **Development Tools**: Aggregate development-related MCP servers
4. **Custom Tool Sets**: Create domain-specific tool collections

## Troubleshooting

### "Server not found or not connected"

- Check underlying MCP servers in `src/config/servers.ts`
- Verify server commands and args are correct
- Check logs for connection errors
- Ensure `enabled: true` for servers you want to use

### "No compressed description found"

- Run compression workflow first: call `compress_tools`, compress, then `save_compressed_tools`
- Cache is in-memory and resets on server restart

### Tools not appearing

- Rebuild: `npm run build`
- Restart Claude Desktop
- Check logs for errors

## Performance

- **Eager Loading**: All servers connect at startup (zero cold-start latency)
- **Parallel Tool Listing**: Fetches from all servers in parallel
- **Compression**: 50-80% reduction in tool listing tokens
- **Session Isolation**: Independent expansion state per conversation

## Contributing

Contributions welcome! Please submit a Pull Request.

## License

MIT License - see LICENSE file for details

## Resources

- [Model Context Protocol Specification](https://modelcontextprotocol.io/)
- [MCP SDK](https://github.com/modelcontextprotocol/sdk)
- [MCP Servers Collection](https://github.com/modelcontextprotocol/servers)
- [Claude Desktop](https://claude.ai/)
