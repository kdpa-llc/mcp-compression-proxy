# Changelog

All notable changes to this project will be documented in this file. See [Conventional Commits](https://conventionalcommits.org) for commit guidelines.

## [1.0.3](https://github.com/kdpa-llc/mcp-compression-proxy/compare/v1.0.2...v1.0.3) (2026-08-24)

### Bug Fixes

* **deps:** raise SDK floor, and stop Dependabot breaking releases ([#47](https://github.com/kdpa-llc/mcp-compression-proxy/issues/47)) ([78f71f0](https://github.com/kdpa-llc/mcp-compression-proxy/commit/78f71f0722f9094f9a871c946984273fc6695664)), closes [#45](https://github.com/kdpa-llc/mcp-compression-proxy/issues/45) [#45](https://github.com/kdpa-llc/mcp-compression-proxy/issues/45)

## [1.0.2](https://github.com/kdpa-llc/mcp-compression-proxy/compare/v1.0.1...v1.0.2) (2026-08-23)

### Documentation

* record that trusted publishing cannot be configured from CI ([#42](https://github.com/kdpa-llc/mcp-compression-proxy/issues/42)) ([3f0bfd6](https://github.com/kdpa-llc/mcp-compression-proxy/commit/3f0bfd6c510a1cd0f93cae3c0ad002bc7c2bd247))

## [1.0.1](https://github.com/kdpa-llc/mcp-compression-proxy/compare/v1.0.0...v1.0.1) (2026-08-23)

### Bug Fixes

* **release:** stop uploading dist as flattened GitHub release assets ([#40](https://github.com/kdpa-llc/mcp-compression-proxy/issues/40)) ([d249836](https://github.com/kdpa-llc/mcp-compression-proxy/commit/d249836fa427663cda00bc727a50dcdebbf1c151))

## 1.0.0 (2026-08-23)

### ⚠ BREAKING CHANGES

* Node.js 18 and 20 are no longer supported. The minimum
supported version is now Node.js 22.

### Features

* add comprehensive e2e testing with real LLM ([#11](https://github.com/kdpa-llc/mcp-compression-proxy/issues/11)) ([d123f45](https://github.com/kdpa-llc/mcp-compression-proxy/commit/d123f450d00c65391f97e614cf5b6255e3818ff2))
* Add configurable timeout for MCP server initialization ([#13](https://github.com/kdpa-llc/mcp-compression-proxy/issues/13)) ([6b54407](https://github.com/kdpa-llc/mcp-compression-proxy/commit/6b54407c8a460817f5b19ea11b69ce9735a75d12))
* add JSON-based configuration system with environment variable expansion ([e35e2dd](https://github.com/kdpa-llc/mcp-compression-proxy/commit/e35e2dd36304f6a0d4a4a95e74ad29fba6d882ab)), closes [#3](https://github.com/kdpa-llc/mcp-compression-proxy/issues/3) [#3](https://github.com/kdpa-llc/mcp-compression-proxy/issues/3)
* add mcp-cli lazy loading with progressive tool discovery ([dff1e03](https://github.com/kdpa-llc/mcp-compression-proxy/commit/dff1e0343aa01123f439439b5effbdea8e050f5d))
* add persistent compression storage ([5be2116](https://github.com/kdpa-llc/mcp-compression-proxy/commit/5be21166aee7e5a29f25784697b1e6774998c589)), closes [#2](https://github.com/kdpa-llc/mcp-compression-proxy/issues/2)
* add stats management tool ([d2c6b84](https://github.com/kdpa-llc/mcp-compression-proxy/commit/d2c6b84e59e25b750f9365971daa38d565485d5a))
* add uncompressed-tool fallback behavior and live coverage stats ([0930cab](https://github.com/kdpa-llc/mcp-compression-proxy/commit/0930cabf34e7bf9888c4187eb74d5e0ca19995f6)), closes [#15](https://github.com/kdpa-llc/mcp-compression-proxy/issues/15) [#15](https://github.com/kdpa-llc/mcp-compression-proxy/issues/15) [#16](https://github.com/kdpa-llc/mcp-compression-proxy/issues/16)
* compress tool descriptions using the host LLM via MCP sampling ([6ab69d5](https://github.com/kdpa-llc/mcp-compression-proxy/commit/6ab69d53881972c04f258a85b807d0a6656e1721))
* disambiguate excludeTools and noCompressTools features ([2f1bc3d](https://github.com/kdpa-llc/mcp-compression-proxy/commit/2f1bc3d511d37c1059721fde601a70f8d464e90a))
* implement tool-level ignore patterns with wildcard support ([73b6f47](https://github.com/kdpa-llc/mcp-compression-proxy/commit/73b6f478117898b6b74cdfe08fbfa56bf632f668))
* require Node.js 22 or newer ([8172c9f](https://github.com/kdpa-llc/mcp-compression-proxy/commit/8172c9fde3f38ae3726c06ca970847c5c9c51a59))
* surface live compression stats and fix tool call regressions ([f3f17b0](https://github.com/kdpa-llc/mcp-compression-proxy/commit/f3f17b08686603a46109cbaa8ceef34558a96867)), closes [#16](https://github.com/kdpa-llc/mcp-compression-proxy/issues/16) [#15](https://github.com/kdpa-llc/mcp-compression-proxy/issues/15) [#15](https://github.com/kdpa-llc/mcp-compression-proxy/issues/15) [#16](https://github.com/kdpa-llc/mcp-compression-proxy/issues/16)
* warn on unresolved env vars, cache config reads, add new options ([6e574a5](https://github.com/kdpa-llc/mcp-compression-proxy/commit/6e574a5f5f4c5417792605b3b2a6dcf56ad6b9c2)), closes [#15](https://github.com/kdpa-llc/mcp-compression-proxy/issues/15) [#24](https://github.com/kdpa-llc/mcp-compression-proxy/issues/24)

### Bug Fixes

* correct npm package name to match repository ([96b08a3](https://github.com/kdpa-llc/mcp-compression-proxy/commit/96b08a3272bced8108af1f3756516a7925435c33))
* **deps:** pin the changelog preset so release notes can render ([#39](https://github.com/kdpa-llc/mcp-compression-proxy/issues/39)) ([29b1fe9](https://github.com/kdpa-llc/mcp-compression-proxy/commit/29b1fe95af38bd6373ced6ce6651992bb48341d0))
* **deps:** regenerate the lockfile so npm ci can install it ([a14a9d9](https://github.com/kdpa-llc/mcp-compression-proxy/commit/a14a9d9db66415c7b72e43c4b9cb3942085a1ddd))
* **deps:** resolve all production dependency advisories ([701ddc1](https://github.com/kdpa-llc/mcp-compression-proxy/commit/701ddc189a89ae0479d3233a350d8744ffeff838))
* **deps:** upgrade pino to v10 ([eecf9a6](https://github.com/kdpa-llc/mcp-compression-proxy/commit/eecf9a606cc6b7c04f03109bd8451ec31401d655))
* improve MCP connection closing ([86ef4b2](https://github.com/kdpa-llc/mcp-compression-proxy/commit/86ef4b25084f4979d7ee22bd2a8b9c90e77240c9))
* pass environment variables through to backend MCP servers ([b2fabc1](https://github.com/kdpa-llc/mcp-compression-proxy/commit/b2fabc11b2631bdae7b0808024589386fe206a1b))
* remove legacy 'disabled' field to standardize server configuration ([fb6f826](https://github.com/kdpa-llc/mcp-compression-proxy/commit/fb6f826ef014e73fe461f676ebe0d0a7db2d161e)), closes [#19](https://github.com/kdpa-llc/mcp-compression-proxy/issues/19)
* remove the broken TypeScript config migration path ([c4c7de1](https://github.com/kdpa-llc/mcp-compression-proxy/commit/c4c7de159a464ff2ec5ea15e9aad70ba7cfa7058))
* report the real package version over MCP instead of a stale literal ([2bc4bb0](https://github.com/kdpa-llc/mcp-compression-proxy/commit/2bc4bb0b45ed2d812a51261f03389d4035e868f3))
* stop `mcp-cli daemon start` from hanging, and document the CLI ([94a7f78](https://github.com/kdpa-llc/mcp-compression-proxy/commit/94a7f783dd4a0904c0e6776a5c6a4bbcc10d5238))
* stop the session cleanup timer from holding the event loop open ([68892ed](https://github.com/kdpa-llc/mcp-compression-proxy/commit/68892ed1bcffcc7fca38e14591c5ff4ad8b4b8d2)), closes [#15](https://github.com/kdpa-llc/mcp-compression-proxy/issues/15) [#16](https://github.com/kdpa-llc/mcp-compression-proxy/issues/16)
* stop writing intercepted payloads to predictable temp paths ([2331006](https://github.com/kdpa-llc/mcp-compression-proxy/commit/2331006ec91cb043e0cd9fb01ee51a27f6b5920c))
* update all references from mcp-aggregator to mcp-compression-proxy ([9735e67](https://github.com/kdpa-llc/mcp-compression-proxy/commit/9735e672b595cefdb46039523e8d2de3c61f2192))
* update all references from mcp-tool-aggregator to mcp-compression-proxy ([daf7b53](https://github.com/kdpa-llc/mcp-compression-proxy/commit/daf7b53f191486b7f0fc853ea94b632e115f06f6))

### Documentation

* add complementary projects section for cross-adoption ([cd6b977](https://github.com/kdpa-llc/mcp-compression-proxy/commit/cd6b977b2efed34977ed05216887a84a9b0d80a9))
* add missing badges and support section to README ([334cb97](https://github.com/kdpa-llc/mcp-compression-proxy/commit/334cb97880bc72c853d454f888b8228151e88cb8))
* comprehensive README polish for clarity and accuracy ([#12](https://github.com/kdpa-llc/mcp-compression-proxy/issues/12)) ([c771bd5](https://github.com/kdpa-llc/mcp-compression-proxy/commit/c771bd5cf6b5b29f90f532aa07a197aa46980d6e))
* correct the test documentation, which had drifted badly ([0a5bbf4](https://github.com/kdpa-llc/mcp-compression-proxy/commit/0a5bbf4a02c9d99a61a156120be9b25a0bcd2014))
* document the new config options and fix npm test on a fresh clone ([e604195](https://github.com/kdpa-llc/mcp-compression-proxy/commit/e604195e483f7071b453359aaaea16c08cde7a4e)), closes [#15](https://github.com/kdpa-llc/mcp-compression-proxy/issues/15) [#24](https://github.com/kdpa-llc/mcp-compression-proxy/issues/24)
* improve documentation and add automation infrastructure ([f9a4e92](https://github.com/kdpa-llc/mcp-compression-proxy/commit/f9a4e9235728ca9e6153fcff66d2328528e54141))
* prepare the changelog and publishing guide for the first release ([f6a30fb](https://github.com/kdpa-llc/mcp-compression-proxy/commit/f6a30fb6822523c1a675c23f1e6c3e321e75b32f))
* use the project's actual name consistently ([99fc78c](https://github.com/kdpa-llc/mcp-compression-proxy/commit/99fc78c27ac8f7b364afe8a39983c04cb87cac35))

### Code Refactoring

* eliminate the remaining `any` and non-null assertions ([341ccdb](https://github.com/kdpa-llc/mcp-compression-proxy/commit/341ccdb6b511fc06278f3f04c75b846d25fc866a))
* give the daemon status field a name that matches its value ([77bc8a9](https://github.com/kdpa-llc/mcp-compression-proxy/commit/77bc8a91eb4a2c48d8df47b77d5a07ffd7c9822d))
* simplify cache path to ~/.mcp-compression-proxy/cache.json ([5819a69](https://github.com/kdpa-llc/mcp-compression-proxy/commit/5819a694bab1be181cba634680aa1f2cff8bf87f))
* use repo-specific cache directory ([7c043ae](https://github.com/kdpa-llc/mcp-compression-proxy/commit/7c043aea343d11bd5651a93ff12c10e5657f395f))

### Build System

* add complete automation infrastructure and community files ([e716371](https://github.com/kdpa-llc/mcp-compression-proxy/commit/e716371a0b0fc54b5eafb44471e2f3ae533b9894))
* configure npm publishing setup ([537006b](https://github.com/kdpa-llc/mcp-compression-proxy/commit/537006b5c230ac37044f7d1beef823f5a22c7b9e))

<!--
This file is generated by @semantic-release/changelog from here down.
New releases are inserted directly below this comment. Do not add entries by
hand - write a conventional commit and the release notes follow from it.

Everything below documents the pre-release history, which predates the
automated pipeline and was maintained in Keep a Changelog format.
-->

## 0.1.0 (2025-11-18)

Pre-release development. Never published to npm.

### Added
- Multi-server MCP aggregation with tool name prefixing
- LLM-based tool description compression (50-80% token reduction)
- Session-based expansion state management
- Persistent compression cache with disk storage
- Management tools API for compression workflow
- JSON configuration system with environment variable expansion
- Comprehensive test suite with unit, integration, and E2E tests
- Real LLM integration testing with Ollama
- Tool filtering with exclude and noCompress patterns
- noCompress tool filtering with wildcard pattern support
- File-based tool compression workflow (outputFile/inputFile parameters)
- Display-only bypass for noCompress patterns while maintaining cache efficiency
- Session auto-expiration and cleanup
- Error handling and server health monitoring
- Performance optimization with parallel tool loading
