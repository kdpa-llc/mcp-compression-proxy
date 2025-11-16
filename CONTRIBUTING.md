# Contributing to MCP Tool Aggregator

Thank you for your interest in contributing to MCP Tool Aggregator! We welcome contributions from the community.

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
│   ├── mcp/
│   │   └── client-manager.ts      # MCP client management
│   ├── services/
│   │   ├── compression-cache.ts   # Compression storage
│   │   └── session-manager.ts     # Session handling
│   ├── config/
│   │   └── servers.ts             # Server configuration
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
