# Publishing Guide

This guide explains how to publish the MCP Compression Proxy package to npm.

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
npm info mcp-compression-proxy
npm view mcp-compression-proxy versions
```

Test installation:

```bash
npm install -g mcp-compression-proxy
mcp-compression-proxy --version
```

## Troubleshooting

### "You do not have permission to publish"

- Ensure you're logged in: `npm whoami`
- Check package name availability: `npm view mcp-compression-proxy`
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

The package has never been published, so the name must be claimed once by
hand before semantic-release can take over. Until that happens the README's
`npm install -g mcp-compression-proxy` returns a 404.

1. Confirm the name is still available:
   ```bash
   npm view mcp-compression-proxy
   # 404 means available
   ```

2. Inspect exactly what would ship, without publishing anything:
   ```bash
   npm run build
   npm pack --dry-run
   ```
   Check that `dist/index.js`, `dist/cli/index.js` and the `.d.ts` files are
   present, and that no test or source files leaked in. Both `bin` entries
   must start with a `#!/usr/bin/env node` shebang or the installed commands
   will not be executable.

3. Publish the first version:
   ```bash
   npm publish --access public
   ```
   `prepublishOnly` runs the build and the full test suite first, so a
   failing suite blocks the publish.

4. Verify it landed:
   ```bash
   npm info mcp-compression-proxy
   npx mcp-compression-proxy@latest --help
   ```

5. After the first publish, semantic-release handles every subsequent
   release from `main`. Nothing further needs doing by hand.

### Trusted publishing (OIDC) — no stored token

`@semantic-release/npm` 13.1.5 supports npm trusted publishing. When it works,
the release needs **no `NPM_TOKEN` at all**: `verify-auth` exchanges the
GitHub Actions OIDC token for a short-lived npm token and returns before it
ever looks for a stored credential.

**There is a bootstrap order, and it cannot be skipped.** Trusted publishers
are configured on a package's settings page on npmjs.com, and the OIDC
exchange endpoint is package-scoped
(`/-/npm/v1/oidc/token/exchange/package/<name>`). Neither exists until the
package does. So for a package that has never been published:

1. **Publish once manually** to claim the name — the `First-Time Publishing`
   steps above. This is the only step that needs a personal npm login.
2. **Configure the trusted publisher** on npmjs.com: package settings →
   Trusted Publisher → GitHub Actions, with this repository and
   `release.yml` as the workflow.
3. **Optionally disallow tokens** for the package once OIDC works, which is
   npm's recommended hardening — it removes the stored-credential risk
   entirely.
4. From then on, every release from `main` publishes over OIDC with
   provenance attestation, and no secret is stored in the repository.

Requirements, all already satisfied by `release.yml`:

| Requirement | Where |
|---|---|
| `id-token: write` permission | `permissions:` block |
| npm >= 11.5.1 | Node 24 pin, plus an explicit version gate that fails loudly |
| Node >= 22.14.0 | Node 24 pin |
| Official registry | default |

The Node version is pinned rather than `lts/*` on purpose: Node 22 LTS still
ships npm 10.9.x, and on that version the OIDC exchange fails and
semantic-release falls back to token auth. With no token configured that
fails the release — so the workflow checks the npm version explicitly rather
than letting it degrade quietly.

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
