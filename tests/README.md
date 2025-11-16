# Testing Infrastructure

This directory contains comprehensive test suites for the MCP Tool Aggregator project.

## Test Summary

**✅ 105 Tests Passing**

| Category | Test Suites | Tests | Description |
|----------|-------------|-------|-------------|
| **Unit** | 4 | 81 | Individual module testing |
| **Integration** | 1 | 11 | Module interaction testing |
| **E2E** | 2 | 13 | Complete workflow testing |
| **Total** | **7** | **105** | Comprehensive coverage |

**Coverage: 100% statements, 95% branches, 100% functions, 100% lines**

## Test Structure

```
tests/
├── __mocks__/              # Mock implementations and test helpers
│   └── mcp-mocks.ts        # Mock MCP clients and utilities
├── unit/                   # Unit tests for individual modules (4 files)
│   ├── compression-cache.test.ts
│   ├── session-manager.test.ts
│   ├── client-manager.test.ts
│   └── servers-config.test.ts
├── integration/            # Integration tests for module interactions (1 file)
│   └── compression-session-integration.test.ts
├── e2e/                    # End-to-end tests with mocked LLM (2 files)
│   ├── tool-aggregation-workflow.test.ts
│   └── user-journey.test.ts              # ⭐ Comprehensive user journey
├── e2e-real/               # 🚀 Real LLM integration tests (optional)
│   ├── real-llm-integration.test.ts      # Tests with actual Ollama/LLM
│   ├── ollama-client.ts                  # Ollama integration utilities
│   └── README.md                         # Real LLM testing guide
├── FEATURE_COVERAGE.md     # Feature test coverage analysis
└── README.md               # This file
```

## Test Categories

### Unit Tests

Unit tests focus on individual modules in isolation:

- **CompressionCache** (`compression-cache.test.ts`)
  - Description storage and retrieval
  - Compression/expansion logic
  - Cache management and statistics

- **SessionManager** (`session-manager.test.ts`)
  - Session lifecycle (create, delete, expire)
  - Tool expansion/collapse per session
  - Session timeout and cleanup
  - Multi-session isolation

- **MCPClientManager** (`client-manager.test.ts`)
  - Server connection management
  - Client lifecycle
  - Error handling for failed connections
  - Multi-server initialization

- **Server Configuration** (`servers-config.test.ts`)
  - Configuration validation
  - Enabled/disabled server filtering

### Integration Tests

Integration tests verify interactions between modules:

- **Compression + Session Integration** (`compression-session-integration.test.ts`)
  - Tool expansion workflow
  - Multi-session state isolation
  - Session lifecycle with compression
  - Statistics and monitoring

### End-to-End Tests

E2E tests validate complete workflows:

- **Tool Aggregation Workflow** (`tool-aggregation-workflow.test.ts`)
  - Full compression and expansion cycle
  - Multi-server tool aggregation
  - Session-based selective expansion
  - Error handling and edge cases
  - Performance and statistics tracking

- **⭐ Comprehensive User Journey** (`user-journey.test.ts`) - **NEW!**
  - **Complete multi-session workflow** simulating realistic user behavior
  - **10-phase journey** from initial state to session cleanup
  - Tests the entire feature set in a connected workflow:
    1. Initial state - tools not compressed
    2. User compresses descriptions
    3. Session 1 - user expands specific tools
    4. Session 1 ends
    5. Session 2 - new conversation, tools still compressed
    6. Session 2 - user expands different tools
    7. Multi-session isolation verification
    8. User collapses tools
    9. Session 3 - compression persistence
    10. Cleanup and verification
  - **Management Tools API testing** - validates all management tools work together
  - **Concurrent session testing** - verifies 3+ simultaneous sessions work correctly

### 🚀 Real LLM Integration Tests (Optional)

**New!** Tests with actual AI using Ollama:

- **Real LLM Integration** (`e2e-real/real-llm-integration.test.ts`)
  - Uses **real language model** (Ollama with Llama 3.2) instead of mocks
  - Validates actual MCP protocol stdio communication
  - Tests real LLM compression intelligence
  - Verifies LLM understands tool descriptions and follows workflows
  - Confirms end-to-end system works with actual AI inference

**Prerequisites:** Requires Ollama installed and running locally
- Install: `curl -fsSL https://ollama.com/install.sh | sh`
- Start: `ollama serve`
- Run: `npm run test:e2e:real-llm`
- Or use Docker: `npm run docker:e2e`

See [`e2e-real/README.md`](./e2e-real/README.md) for detailed setup and usage.

**Note:** Real LLM tests are excluded from default `npm test` run. Must be run explicitly.

## Running Tests

### All Tests
```bash
npm test
```

### Watch Mode (for development)
```bash
npm run test:watch
```

### Unit Tests Only
```bash
npm run test:unit
```

### Integration Tests Only
```bash
npm run test:integration
```

### E2E Tests Only (Mocked)
```bash
npm run test:e2e
```

### 🚀 Real LLM E2E Tests (Requires Ollama)
```bash
# Local testing (requires Ollama running)
npm run test:e2e:real-llm

# Docker testing (handles Ollama automatically)
npm run docker:e2e
```

### Coverage Report
```bash
npm run test:coverage
```

## Coverage Goals

The project maintains the following coverage thresholds:
- **Branches**: 80%
- **Functions**: 80%
- **Lines**: 80%
- **Statements**: 80%

## Test Utilities

### Mock MCP Clients

Located in `tests/__mocks__/mcp-mocks.ts`:

- `MockMCPClient` - Generic mock MCP client
- `createMockFilesystemClient()` - Pre-configured filesystem server mock
- `createMockGitHubClient()` - Pre-configured GitHub server mock
- `createFailingMockClient()` - Mock client that fails to connect
- `getMockLogger()` - Mock Pino logger for tests
- `SAMPLE_COMPRESSIONS` - Sample compressed descriptions

### Example Usage

```typescript
import {
  createMockFilesystemClient,
  SAMPLE_COMPRESSIONS
} from '../__mocks__/mcp-mocks';

const client = createMockFilesystemClient();
await client.connect();

const tools = await client.listTools();
// Returns mock filesystem tools (read_file, write_file, list_directory)
```

## Writing Tests

### Unit Test Template

```typescript
import { describe, it, expect, beforeEach } from '@jest/globals';
import { YourModule } from '../../src/path/to/module.js';

describe('YourModule', () => {
  let instance: YourModule;

  beforeEach(() => {
    instance = new YourModule();
  });

  describe('method', () => {
    it('should do something', () => {
      const result = instance.method();
      expect(result).toBe(expected);
    });
  });
});
```

### Integration Test Template

```typescript
import { describe, it, expect, beforeEach } from '@jest/globals';
import { Module1 } from '../../src/module1.js';
import { Module2 } from '../../src/module2.js';

describe('Module1 and Module2 Integration', () => {
  let module1: Module1;
  let module2: Module2;

  beforeEach(() => {
    module1 = new Module1();
    module2 = new Module2();
  });

  it('should work together', () => {
    // Test interaction between modules
  });
});
```

## Best Practices

### Do's ✅

- Use descriptive test names that explain what is being tested
- Test both success and failure scenarios
- Test edge cases and boundary conditions
- Use `beforeEach` to reset state between tests
- Mock external dependencies (MCP clients, file system, etc.)
- Aim for high coverage but don't sacrifice test quality for coverage numbers

### Don'ts ❌

- Don't test implementation details
- Don't write tests that depend on other tests
- Don't use hard-coded timeouts unless necessary
- Don't skip cleanup in `afterEach` hooks
- Don't test third-party library internals

## Continuous Integration

The test suite is designed to run in CI/CD pipelines:

```yaml
# Example GitHub Actions workflow
- name: Run tests
  run: npm test

- name: Check coverage
  run: npm run test:coverage

- name: Upload coverage
  uses: codecov/codecov-action@v3
  with:
    files: ./coverage/lcov.info
```

## Debugging Tests

### Run Single Test File
```bash
npx jest tests/unit/compression-cache.test.ts
```

### Run Single Test
```bash
npx jest -t "should save compressed description"
```

### Debug with Node Inspector
```bash
node --inspect-brk node_modules/.bin/jest --runInBand
```

### Verbose Output
```bash
npm test -- --verbose
```

## Common Issues

### ESM Import Errors

If you encounter import errors, ensure:
1. All imports use `.js` extensions (even for `.ts` files)
2. `jest.config.js` has proper ESM configuration
3. `package.json` has `"type": "module"`

### Mock Issues

If mocks aren't working:
1. Ensure `jest.mock()` is called before imports
2. Check that mock paths are correct
3. Verify `moduleNameMapper` in jest config

### Timeout Errors

For async tests that timeout:
1. Increase `testTimeout` in jest config
2. Ensure all promises are properly awaited
3. Check for unhandled promise rejections

## Contributing

When adding new features:

1. Write tests first (TDD approach)
2. Ensure all tests pass: `npm test`
3. Check coverage: `npm run test:coverage`
4. Update this README if adding new test categories

## Resources

- [Jest Documentation](https://jestjs.io/docs/getting-started)
- [Testing Best Practices](https://testingjavascript.com/)
- [MCP SDK Documentation](https://github.com/modelcontextprotocol/sdk)
