# Compressing and rewriting MCP tool descriptions

You are the writer: no API key or other model is involved. mcp-cli gives you
tools that need better descriptions, checks what you write, and saves only
what the user approves. The server's original description is always kept.

Two modes:

- `rewrite` (default): make unclear descriptions clear. May be longer than
  the original when the original was vague. May also rewrite parameter
  descriptions.
- `compress`: make descriptions shorter without losing meaning. Description
  only; must end up shorter than the original.

## The loop

1. **Ask first.** Tell the user what you are about to do (mode, roughly how
   many tools), and that nothing is saved until they approve the diff.

2. **Get a batch:**

   ```bash
   mcp-cli describe next --mode rewrite --limit 10
   ```

   Options: `--server <name>`, `--tool <server>/<tool>`, `--all` (include
   tools already done). Each item has the `original` description, the
   `current` replacement if any, `parameters` (type, required, description),
   `issues` (why it needs work) and `similar` tools it must be told apart
   from. The batch also carries `guidelines` and the `answerFormat`.

3. **Write** a JSON file following `answerFormat`, one entry per tool:

   ```json
   [
     {
       "server": "github",
       "tool": "list_issues",
       "description": "List issues in one repository, filtered by state, labels or assignee. For searching across repositories use search_issues.",
       "parameters": { "state": "open, closed or all; default open" }
     }
   ]
   ```

   Rules - follow the batch's `guidelines`, and above all:
   - Only state what the original description, the schema, or the tool's
     name make true. Never invent a capability, default, limit or format.
     If the original is too vague to know, stay vague.
   - Say what sets the tool apart from each tool in `similar`.
   - Only parameters that exist in the schema; only their descriptions.
   - Skip a tool if you cannot improve it honestly. Leaving it is fine.

4. **Review with the user:**

   ```bash
   mcp-cli describe review proposals.json --mode rewrite
   ```

   This saves nothing. It shows each change as before/after, and marks
   entries that fail a check (unknown tool or parameter, too long, not
   shorter in compress mode, or reads more like another tool than its own).
   Show the user the output. Fix or drop rejected entries.

5. **Apply only after the user says yes:**

   ```bash
   mcp-cli describe apply proposals.json --mode rewrite
   ```

   Only entries that pass the checks are saved. Repeat from step 2 while
   `remaining` is above zero and the user wants to continue.

## Undo

```bash
mcp-cli describe revert <server>/<tool>   # one tool
mcp-cli describe revert --all             # everything
```

`mcp-cli audit` re-checks every saved description later; a description whose
server changed its original is offered again by `describe next` automatically.
