# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- noCompress tool filtering with wildcard pattern support
- Comprehensive integration tests for noCompress functionality  
- File-based tool compression workflow (outputFile/inputFile parameters)
- Display-only bypass for noCompress patterns while maintaining cache efficiency
- Enhanced configuration validation with excludeTools and noCompressTools patterns

### Fixed
- Improved test coverage across integration scenarios
- Enhanced documentation consistency across repository

### Changed
- Expanded integration test suite from 1 to 4 test files
- Updated test coverage metrics and documentation

## [0.1.0] - 2025-11-18

### Added
- Initial release
- Multi-server MCP aggregation with tool name prefixing
- LLM-based tool description compression (50-80% token reduction)
- Session-based expansion state management
- Persistent compression cache with disk storage
- Management tools API for compression workflow
- JSON configuration system with environment variable expansion
- Comprehensive test suite with unit, integration, and E2E tests
- Real LLM integration testing with Ollama
- Tool filtering with exclude and noCompress patterns
- Session auto-expiration and cleanup
- Error handling and server health monitoring
- Performance optimization with parallel tool loading
