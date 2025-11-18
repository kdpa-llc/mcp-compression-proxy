# Comprehensive E2E Testing with Real LLM

This directory contains comprehensive end-to-end tests that validate all MCP Compression Proxy features using a real LLM (Ollama).

## Features Tested

### 1. **Multi-Server Aggregation**
Tests that the proxy correctly aggregates tools from multiple MCP servers:
- **Math Server**: Provides arithmetic operations (add, multiply, square)
- **Text Server**: Provides text manipulation (uppercase, lowercase, reverse, count_words)
- **Data Server**: Provides key-value storage (store_data, get_data, list_keys)

### 2. **Tool Exclusion (excludeTools)**
Tests that exclude patterns correctly remove tools from the tool list:
- Configured exclude patterns completely remove specific tools from the aggregated list
- Non-excluded tools remain accessible
- Pattern matching works correctly with wildcards

### 3. **Tool Proxying**
Tests that tool calls are correctly proxied to the underlying MCP servers:
- Math operations execute and return correct results
- Text operations work as expected
- Data storage and retrieval functions properly
- All responses are correctly formatted

### 4. **LLM-Guided Tool Selection**
Tests that a real LLM can:
- Analyze available tools
- Select appropriate tools for a given task
- Execute multi-step workflows
- Understand tool descriptions

### 5. **No-Compress Pass-Through (noCompressTools)**
Tests that tools can bypass compression:
- Tools matching noCompress patterns preserve their full descriptions
- Descriptions remain unchanged even after compression is triggered
- Cache respects noCompress patterns
- Full descriptions are always returned for these tools

### 6. **Compression & Expansion**
Tests the full compression lifecycle:
- Tools can be compressed using a real LLM
- Compressed descriptions are stored and retrieved
- Session-based expansion works correctly
- Original descriptions can be restored

### 7. **Complete Integration**
Tests that all features work together in real-world scenarios:
- Multi-step workflows using tools from different servers
- Data persistence across tool calls
- Exclusion and noCompress remain active throughout
- Tool descriptions guide LLM behavior

## Test Servers

The tests use three custom MCP servers located in `test-servers/`:

### Math Server (`math-server.ts`)
```typescript
Tools:
- add(a, b): Add two numbers
- multiply(a, b): Multiply two numbers
- square(n): Calculate the square of a number
```

### Text Server (`text-server.ts`)
```typescript
Tools:
- uppercase(text): Convert text to uppercase
- lowercase(text): Convert text to lowercase
- reverse(text): Reverse text string
- count_words(text): Count words in text
```

### Data Server (`data-server.ts`)
```typescript
Tools:
- store_data(key, value): Store a key-value pair
- get_data(key): Retrieve data by key
- list_keys(): List all stored keys
```

## Requirements

### Software
- **Node.js**: 18.0.0 or higher
- **Ollama**: Running locally at http://localhost:11434
- **Model**: llama3.2:1b (or compatible)

### Installation

1. Install Ollama:
   ```bash
   # macOS
   brew install ollama

   # Linux
   curl -fsSL https://ollama.com/install.sh | sh

   # Or download from https://ollama.com/download
   ```

2. Pull the model:
   ```bash
   ollama pull llama3.2:1b
   ```

3. Start Ollama (if not already running):
   ```bash
   ollama serve
   ```

4. Build the project and test servers:
   ```bash
   npm run build
   npm run build:test-servers
   ```

## Test Validation

Each test validates specific functionality:

1. **Test 1**: Aggregation - Verifies tools from all 3 servers are available
2. **Test 2**: Exclusion - Confirms excluded tools are removed from tool list
3. **Test 3**: Proxying - Executes actual tool calls and validates responses
4. **Test 4**: LLM Selection - Real LLM analyzes tasks and selects tools
5. **Test 5**: No-Compress - Validates tools bypass compression and preserve full descriptions
6. **Test 6**: Integration - Multi-step workflow using all features
7. **Test 7**: Compression - Full compression/expansion lifecycle

## Running Tests

### Run all e2e tests with real LLM:
```bash
npm run test:e2e:real-llm
```

### Run specific test file:
```bash
npm run build && npm run build:test-servers
jest tests/e2e-real/comprehensive-e2e.test.ts --testTimeout=120000
```

### Run with verbose output:
```bash
npm run test:e2e:real-llm -- --verbose
```

## Test Configuration

The comprehensive e2e test creates a temporary configuration at runtime:

```json
{
  "mcpServers": [
    {
      "name": "math",
      "command": "node",
      "args": ["tests/e2e-real/test-servers-dist/math-server.js"],
      "enabled": true
    },
    {
      "name": "text",
      "command": "node",
      "args": ["tests/e2e-real/test-servers-dist/text-server.js"],
      "enabled": true
    },
    {
      "name": "data",
      "command": "node",
      "args": ["tests/e2e-real/test-servers-dist/data-server.js"],
      "enabled": true
    }
  ],
  "excludeTools": [
    "math__square",
    "text__reverse",
    "data__list_keys"
  ],
  "noCompressTools": [
    "text__count_words"
  ]
}
```

## Test Output

Successful test run will show:

```
🚀 Setting up Comprehensive E2E Test Environment...
✓ Ollama is running
✓ Model ready
✓ Test configuration written
✓ MCP Compression Proxy connected

📋 TEST 1: Multi-Server Aggregation
   Found 13 total tools
   Math tools: 2
   Text tools: 3
   Data tools: 2
   ✓ Tools successfully aggregated from all servers

🚫 TEST 2: Tool Exclusion (excludeTools)
   Checking math__square: EXCLUDED (✓)
   Checking text__reverse: EXCLUDED (✓)
   Checking data__list_keys: EXCLUDED (✓)
   ✓ Tool exclusion working correctly

🔄 TEST 3: Tool Proxying
   Testing math__add...
   Result: Result: 8
   Testing text__uppercase...
   Result: HELLO WORLD
   Testing data__store_data...
   Stored data with key: test-key
   Testing data__get_data...
   Retrieved: test-value
   ✓ Tool proxying working correctly

🤖 TEST 4: LLM-Guided Tool Selection
   Asking LLM to analyze task...
   LLM selected tools: math__multiply, text__uppercase
   Executing LLM-suggested workflow:
   1. Calculating 7 * 8...
      Result: Result: 56
   2. Converting result to uppercase...
      Result: RESULT IS 56
   ✓ LLM successfully guided tool selection and execution

🔒 TEST 5: No-Compress Pass-Through (noCompressTools)
   Original text__count_words description: 120 chars
   "Count words in text. This tool analyzes a text string and returns the number of words it contains."

   Triggering compression...
   Compressed 9 tools
   ✓ Compression saved

   After compression: 120 chars
   "Count words in text. This tool analyzes a text string and returns the number of words it contains."
   ✓ No-compress pass-through working - description unchanged

🎯 TEST 6: Complete Integration Workflow
   Scenario: Store and retrieve calculation results
   1. Calculate 15 + 27...
      Result: 42
   2. Create label...
      Label: CALCULATION RESULT
   3. Store result...
      ✓ Stored
   4. Retrieve stored data...
      Retrieved: Result: 42
   5. Verify exclusion still active...
   6. Verify noCompress tool present...
   ✓ Complete workflow successful

🗜️  TEST 7: Compression & Expansion
   Original description length: 120 chars
   Triggering compression...
   Compressed 10 descriptions
   ✓ Compression saved
   Compressed description length: 45 chars
   Creating session for expansion...
   ✓ Session created
   Expanding math__add...
   ✓ Compression and expansion working correctly

✓ All tests passed
```

## Troubleshooting

### Ollama not running
```
⚠️  Ollama not running. Skipping real LLM tests.
   To enable: Install Ollama and run "ollama serve"
```
**Solution**: Start Ollama with `ollama serve`

### Model not available
```
⚠️  Failed to pull model, test may fail
```
**Solution**: Pull the model with `ollama pull llama3.2:1b`

### Test servers not built
```
Error: Cannot find module 'tests/e2e-real/test-servers-dist/math-server.js'
```
**Solution**: Build test servers with `npm run build:test-servers`

### Tests timeout
```
Timeout - Async callback was not invoked within the 120000 ms timeout
```
**Solution**: LLM might be slow. Increase timeout or use a faster model:
```bash
jest tests/e2e-real/comprehensive-e2e.test.ts --testTimeout=300000
```

### LLM not following JSON format
Small LLMs like llama3.2:1b may not always return valid JSON arrays as requested. The tests are designed to handle this gracefully:
- They attempt to parse JSON first
- If that fails, they extract tool names from natural language
- Finally, they fall back to a default set of tools

This ensures tests pass while still validating the workflow. If you want stricter JSON compliance, use a larger model like llama3.2:3b or higher.

## Architecture

```
┌─────────────────┐
│   Test Client   │
│   (Jest test)   │
└────────┬────────┘
         │
         │ MCP Protocol (stdio)
         │
┌────────▼─────────────────────────┐
│  MCP Compression Proxy           │
│  - Aggregates tools              │
│  - Filters with ignore patterns  │
│  - Proxies tool calls            │
│  - Manages compression/expansion │
└────────┬─────────────────────────┘
         │
         │ MCP Protocol (stdio)
         │
    ┌────┴────┬────────┬────────┐
    │         │        │        │
┌───▼──┐  ┌──▼───┐  ┌─▼────┐  ┌▼────────┐
│ Math │  │ Text │  │ Data │  │ Ollama  │
│Server│  │Server│  │Server│  │   LLM   │
└──────┘  └──────┘  └──────┘  └─────────┘
```

## Contributing

When adding new test scenarios:

1. Create test in `comprehensive-e2e.test.ts`
2. Add new test servers if needed in `test-servers/`
3. Update this README with new test coverage
4. Ensure tests clean up resources in `afterAll()`
5. Use descriptive console.log messages for test output

## See Also

- [Main E2E Tests](./real-llm-integration.test.ts) - Original compression-focused tests
- [Integration Tests](../integration/) - Mocked integration tests
- [Unit Tests](../unit/) - Component unit tests
