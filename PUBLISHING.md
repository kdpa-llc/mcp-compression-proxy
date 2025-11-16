# Publishing Guide

This guide explains how to publish the MCP Tool Aggregator package to npm.

## Prerequisites

1. **npm Account**: Create an account at https://www.npmjs.com/
2. **npm Access Token**: Generate an automation token for GitHub Actions
3. **GitHub Secrets**: Configure NPM_TOKEN in repository secrets

## Automated Publishing (Recommended)

The project uses [semantic-release](https://github.com/semantic-release/semantic-release) for automated versioning and publishing.

### How It Works

1. **Commit with Conventional Commits**: Use the conventional commit format
   ```bash
   git commit -m "feat: add new feature"
   git commit -m "fix: resolve bug"
   ```

2. **Push to main**: The release workflow runs automatically
   ```bash
   git push origin main
   ```

3. **Automated Process**:
   - Analyzes commits to determine version bump
   - Generates CHANGELOG.md
   - Creates GitHub release
   - Publishes to npm
   - Commits version changes back to repository

### Commit Types and Version Bumps

| Commit Type | Version Bump | Example |
|-------------|--------------|---------|
| `feat:` | Minor (0.x.0) | `feat: add persistent compression` |
| `fix:` | Patch (0.0.x) | `fix: handle missing cache file` |
| `perf:` | Patch (0.0.x) | `perf: optimize tool lookup` |
| `BREAKING CHANGE:` | Major (x.0.0) | `feat!: redesign API` |

### Release Branches

- `main` - Production releases
- `next` - Next version (pre-release)
- `beta` - Beta releases (pre-release)
- `alpha` - Alpha releases (pre-release)

## Manual Publishing (Not Recommended)

If you need to publish manually:

### 1. Setup npm Authentication

```bash
npm login
```

### 2. Update Version

```bash
npm version patch  # 0.1.0 -> 0.1.1
npm version minor  # 0.1.0 -> 0.2.0
npm version major  # 0.1.0 -> 1.0.0
```

### 3. Build and Test

```bash
npm run build
npm test
```

### 4. Publish

```bash
npm publish
```

### 5. Push Changes

```bash
git push --follow-tags
```

## Setting Up NPM_TOKEN in GitHub

### 1. Generate npm Access Token

1. Log in to https://www.npmjs.com/
2. Go to Account Settings → Access Tokens
3. Click "Generate New Token" → "Automation"
4. Copy the token (starts with `npm_`)

### 2. Add to GitHub Secrets

1. Go to repository Settings → Secrets and variables → Actions
2. Click "New repository secret"
3. Name: `NPM_TOKEN`
4. Value: Paste your npm token
5. Click "Add secret"

### 3. Verify Release Workflow

The release workflow (`.github/workflows/release.yml`) will now:
- Build and test the package
- Run semantic-release
- Publish to npm automatically

## Package Contents

The published package includes:

- `dist/` - Compiled JavaScript and TypeScript definitions
- `README.md` - Package documentation
- `LICENSE` - MIT license
- `CHANGELOG.md` - Version history (generated)

Excluded from package:
- Source TypeScript files (`src/`)
- Tests (`tests/`)
- Development configuration
- Docker files
- GitHub workflows

## Verification

After publishing, verify the package:

```bash
npm info mcp-tool-aggregator
npm view mcp-tool-aggregator versions
```

Test installation:

```bash
npm install -g mcp-tool-aggregator
mcp-aggregator --version
```

## Troubleshooting

### "You do not have permission to publish"

- Ensure you're logged in: `npm whoami`
- Check package name availability: `npm view mcp-tool-aggregator`
- Verify you have access to the package

### "prepublishOnly script failed"

- Run `npm run build` to check for TypeScript errors
- Run `npm test` to ensure tests pass
- Fix any issues before publishing

### "Invalid token"

- Regenerate npm token
- Update NPM_TOKEN in GitHub secrets
- Ensure token type is "Automation"

## First-Time Publishing

For the initial npm publish:

1. Ensure package name is available:
   ```bash
   npm view mcp-tool-aggregator
   # Should return 404 if available
   ```

2. Publish manually for first release:
   ```bash
   npm publish
   ```

3. After first publish, semantic-release will handle future releases automatically

## Best Practices

1. **Never publish from a feature branch** - Only publish from `main`
2. **Use conventional commits** - Enables automatic versioning
3. **Let CI handle it** - Use automated releases via GitHub Actions
4. **Test before merging** - Ensure all tests pass
5. **Review CHANGELOG** - Verify generated changelog is accurate

## Resources

- [npm Documentation](https://docs.npmjs.com/)
- [Semantic Release](https://github.com/semantic-release/semantic-release)
- [Conventional Commits](https://www.conventionalcommits.org/)
- [npm Access Tokens](https://docs.npmjs.com/about-access-tokens)
