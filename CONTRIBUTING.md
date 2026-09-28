# Contributing to MCP Compression Proxy

Thank you for your interest in contributing to MCP Compression Proxy! We welcome contributions from the community.

## How to Contribute

### Reporting Bugs

If you find a bug, please open an issue on GitHub with:
- A clear, descriptive title
- Steps to reproduce the issue
- Expected behavior
- Actual behavior
- Your environment (Node version, OS, MCP client)
- Any relevant logs or error messages

### Suggesting Features

We welcome feature suggestions! Please open an issue with:
- A clear description of the feature
- The problem it solves
- Any examples or use cases
- Optional: proposed implementation approach

### Pull Requests

1. **Fork the repository** and create your branch from `main`
   ```bash
   git checkout -b feature/your-feature-name
   ```

2. **Make your changes**
   - Write clear, concise commit messages
   - Follow the existing code style
   - Add tests if applicable
   - Update documentation as needed

3. **Test your changes**
   ```bash
   npm install
   npm run build
   npm test
   ```

4. **Submit a pull request**
   - Provide a clear description of the changes
   - Reference any related issues
   - Ensure CI checks pass

## Development Setup

Use **Node.js 22 or newer**. The supported Node.js range is declared in
[`package.json`](package.json).

```bash
# Clone your fork
git clone https://github.com/YOUR_USERNAME/mcp-compression-proxy.git
cd mcp-compression-proxy

# Install dependencies
npm install

# Build the project
npm run build

# Watch mode for development
npm run watch
```

## Code Style

- Use TypeScript with strict type checking
- Follow existing patterns and conventions
- Keep functions focused and modular
- Add comments for complex logic
- Use meaningful variable and function names

## Commit Messages

This project uses [Conventional Commits](https://www.conventionalcommits.org/) for automated versioning and changelog generation.

### Commit Format

```
<type>(<scope>): <subject>

<body>

<footer>
```

### Commit Types

- **feat**: A new feature (triggers minor version bump)
- **fix**: A bug fix (triggers patch version bump)
- **perf**: A performance improvement (triggers patch version bump)
- **docs**: Documentation changes (triggers patch version bump)
- **refactor**: Code refactoring without feature changes (triggers patch version bump)
- **build**: Changes to build system or dependencies (triggers patch version bump)
- **style**: Code style changes (formatting, no functional changes)
- **test**: Adding or updating tests
- **ci**: Changes to CI configuration
- **chore**: Other changes that don't modify src or test files
- **revert**: Reverts a previous commit (triggers patch version bump)

### Breaking Changes

To trigger a major version bump, add `BREAKING CHANGE:` in the commit body or append `!` after the type:

```
feat!: redesign compression API

BREAKING CHANGE: The compression function now requires a session parameter
```

### Examples

```bash
# Feature (minor version bump)
feat(compression): add support for custom compression strategies

# Bug fix (patch version bump)
fix(session): handle expired sessions gracefully

# Documentation (patch version bump)
docs(readme): update installation instructions

# Breaking change (major version bump)
feat!: change session management API

BREAKING CHANGE: Sessions now require explicit creation
```

### Guidelines

- Use imperative mood ("Add feature" not "Added feature")
- Reference issues in the footer: `Resolves #123` or `Closes #456`
- Keep subject line under 72 characters
- Separate subject from body with a blank line
- Use body to explain what and why, not how

## Project Structure

```
mcp-compression-proxy/
├── src/
│   ├── index.ts                    # MCP server entry point
│   ├── version.ts                  # Version advertised over MCP
│   ├── cli/                        # mcp-cli daemon and client
│   ├── mcp/
│   │   └── client-manager.ts      # MCP client management
│   ├── services/
│   │   ├── compression-cache.ts   # Compression storage
│   │   ├── compression-persistence.ts # On-disk cache
│   │   ├── session-manager.ts     # Session handling
│   │   └── stats-service.ts       # Coverage and savings stats
│   ├── config/
│   │   ├── loader.ts              # Config loading and env expansion
│   │   └── schema.ts              # JSON schema for servers.json
│   └── types/                     # TypeScript types
├── tests/
│   ├── unit/                      # Unit tests
│   ├── integration/               # Integration tests
│   ├── e2e/                       # End-to-end tests
│   └── e2e-real/                  # Real LLM tests
└── dist/                          # Compiled output
```

## Testing

This project has a comprehensive test suite with unit, integration, and end-to-end tests.

### Running Tests

```bash
# Run all tests
npm test

# Run tests in watch mode
npm run test:watch

# Run tests with coverage
npm run test:coverage

# Run specific test suites
npm run test:unit          # Unit tests only
npm run test:integration   # Integration tests only
npm run test:e2e           # End-to-end tests only
npm run test:e2e:real-llm  # Real LLM integration tests (requires Ollama)
```

### Required patch coverage

Before requesting review, commit the candidate and run this with an up-to-date target branch:

```bash
git fetch origin main
npm run test:coverage:patch -- --base origin/main --head HEAD
```

Use a current Node 22 or 24 release (the gate needs Node 22.5+). This command builds,
checks its own regression fixtures, generates fresh full Jest coverage, and requires
all changed executable lines and branch arms within Jest's existing production-source
coverage scope to be covered. The existing global 80% floors and entry-point exclusions
remain in force. Docs-only changes, excluded declarations, and changes with no
instrumented lines in a reported source file are marked not applicable, rather than
a coverage percentage. An included source file absent from LCOV fails closed, even
if it appears to contain only types; inspect that missing evidence before proceeding.

The command requires a clean committed worktree and records the exact base, head,
merge base, tested tree, source fingerprint, LCOV digest, scope and per-file results in
`coverage/patch-coverage.json`. It checks the whole PR from its merge base, including
changes in earlier commits. Missing changed-source records, stale reports and invalid
bases fail. Every reported LCOV source must identify a Git-tracked file within the existing coverage scope,
including on dependency/docs-only changes; fabricated source paths are rejected.
This identity check does not infer missing unchanged runtime files or require
erased type-only files to have executable counters.

`ts-jest` is pinned to 29.4.12: 29.4.13 emits fabricated `file:` source paths in
coverage with both Jest 30.5.1 and 30.5.2. A future update must retain canonical
source identities and pass the full coverage and artifact checks.

The existing required Node 22 test job preserves GitHub's default synthetic PR merge
checkout and tests the candidate together with its target branch. The gate also records
the PR head and verifies that it is exactly the tested merge's second parent. The event
base must be an ancestor of the actual tested target (first parent); GitHub can retain
an older event base after that target advances. Both bases are recorded, and the patch
is compared with the actual tested target so its unrelated changes do not count as PR
changes. Pushes compare the previous/current push commits. A first push without a previous
commit fails with an explicit base requirement; it does not silently compare HEAD to
itself. Codecov upload and its comment remain useful presentation, but uploader success
is not coverage acceptance. Inspect both the patch JSON artifact and the Codecov comment
before approving the exact PR head. Cover missed outcomes with meaningful tests; do not
lower thresholds or suppress instrumentation to make a check pass.

### Writing Tests

- Add unit tests for new functions and modules
- Add integration tests for feature interactions
- Add end-to-end tests for complete user workflows
- Aim for high code coverage (80%+ target)
- Use descriptive test names that explain the scenario

### Manual Testing

For manual verification:

1. Build the project: `npm run build`
2. Configure MCP client to use your local build
3. Test tool aggregation and compression
4. Verify error handling

## Documentation

When adding features or changing functionality:
- Update README.md
- Update tests/README.md if needed
- Add/update code comments
- Consider adding examples

## Community

- Be respectful and inclusive
- Follow our [Code of Conduct](CODE_OF_CONDUCT.md)
- Help others in discussions and issues
- Share your use cases and configurations!

## Questions?

Feel free to open an issue for questions or join the discussion in existing issues.

Thank you for contributing! 🎉
