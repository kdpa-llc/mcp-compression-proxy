---
name: mcp-cli
description: Use MCP server tools (GitHub, filesystem, Slack, databases, browsers and any other server configured in mcp-compression-proxy) through the mcp-cli command instead of loading them as MCP tools. Use whenever a task needs a capability an MCP server provides, or when asked to compress, rewrite or improve MCP tool descriptions.
---

# mcp-cli

`mcp-cli` reaches every MCP server configured for mcp-compression-proxy
through shell commands. Nothing is loaded into context until you ask for it:
search, read one tool's schema, call it.

If `mcp-cli` is missing, it is installed with `npm install -g mcp-compression-proxy`
and configured in `~/.mcp-compression-proxy/servers.json`. `mcp-cli doctor`
checks the setup.

## Find, inspect, call

```bash
mcp-cli search "what you want to do"        # ranked, best first
mcp-cli info <server>/<tool>                # description and input schema
mcp-cli call <server>/<tool> '<json args>'  # run it
```

- Search by what you want done, in plain words; exact tool names rank first.
  `--limit N` shows more results.
- Always run `info` before the first call to a tool, and build arguments from
  its `inputSchema`. Respect `required` and types.
- For awkward quoting, pipe the arguments: `echo '{"path":"/tmp/a"}' | mcp-cli call fs/read_file`.
- A tool whose `annotations.readOnlyHint` is false or absent may change
  things. Treat it like any other write: be sure it is what the user asked for.
- Not sure which tool fits? `mcp-cli suggest "<request>"` returns candidates
  with schemas, and a proposed call when a local model is configured. A
  proposal is a draft to check, never a decision.

## Keep large results out of context

Ask only for what you need:

```bash
mcp-cli call github/list_issues '{"owner":"o","repo":"r"}' \
  --want '{"items":[{"number":"integer","title":"string","user.login":"string?"}]}' \
  --where 'login failures' --limit 10
```

- `--want` is the shape of the answer: object keys to keep, `[x]` for a list
  of x, leaf types `string|number|integer|boolean|object|array|any`, `a|b` for
  one of those values, `?` for optional. JSON output is projected exactly;
  missing fields come back `null` and are listed in `meta.missing`.
- `--where` keeps the list items relevant to a topic; it may return none.
- The full output is saved; `source.id` is its payload ID.

Outputs over the size threshold come back as a payload ID instead of text:

```bash
mcp-cli output find <id> "text"             # search inside it
mcp-cli output read <id> [offset] [length]  # read a page
mcp-cli output shape <id> --want '...' --where '...'
```

Never `output read <id> 0 all` on a large payload unless you really need all of it.

## Several dependent calls

```bash
mcp-cli script '[{"id":"s","server":"docs","tool":"search","arguments":{"q":"x"}},
                 {"id":"r","server":"docs","tool":"read","arguments":{"url":{"$ref":"s#/results/0/url"}}}]'
```

Steps run in order; `{"$ref":"step#/json/pointer"}` passes a value from an
earlier step. Steps accept `want`/`where` too.

## When something fails

- `excluded by the excludeTools configuration`: the user has blocked that
  tool on purpose. Do not look for a way around it; tell the user.
- A backend error: `mcp-cli doctor`, then `mcp-cli daemon logs -n 50`.

## Compressing or rewriting tool descriptions

When asked to compress, rewrite, clean up or improve MCP tool descriptions,
follow [DESCRIBE.md](DESCRIBE.md). You write the new text yourself; the user
reviews it before anything is saved.
