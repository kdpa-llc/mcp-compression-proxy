# Real LLM E2E Tests

This directory contains **true end-to-end integration tests** that validate the MCP Tool Aggregator with a **real language model**, not mocks.

## Overview

Unlike the mocked E2E tests in `tests/e2e/`, these tests:

✅ Use a **real LLM** (Ollama with Llama 3.2) for compression
✅ Test the **actual MCP protocol** via stdio communication
✅ Validate that **tool descriptions guide real LLM behavior**
✅ Verify the **complete workflow** with actual AI inference
✅ Confirm **LLM understanding** of multi-step workflows

## What Gets Tested

### 1. **Complete Compression Workflow**
- MCP server starts and communicates via stdio
- Client calls `compress_tools` management tool
- Real LLM receives tool descriptions
- LLM intelligently compresses descriptions (actual AI inference)
- Client calls `save_compressed_tools` with LLM output
- Verification that compression is applied

### 2. **Session-Based Expansion**
- Create session via `create_session` tool
- Expand specific tools via `expand_tool`
- Verify expanded tools show full descriptions
- Validate session isolation

### 3. **LLM Understanding of Instructions**
- Verify LLM interprets tool descriptions correctly
- Confirm LLM understands multi-step workflow
- Validate LLM follows natural language instructions

## Prerequisites

### Option 1: Local Testing (Recommended)

**Install Ollama:**
```bash
# macOS/Linux
curl -fsSL https://ollama.com/install.sh | sh

# Or visit: https://ollama.com/download
```

**Start Ollama:**
```bash
ollama serve
```

**Pull the model:**
```bash
ollama pull llama3.2:1b  # Fast, lightweight (1.3GB)
# OR
ollama pull llama3.2:3b  # Better quality (2GB)
```

**Build and test:**
```bash
npm run build
npm run test:e2e:real-llm
```

### Option 2: Docker (Easiest)

**Run everything with Docker Compose:**
```bash
npm run docker:e2e
```

This automatically:
- Starts Ollama in a container
- Pulls the LLM model
- Builds the MCP server
- Runs the tests
- Cleans up

### Option 3: CI/CD (Automatic)

Tests run automatically in GitHub Actions on push/PR. See `.github/workflows/e2e-real-llm.yml`

## Running Tests

### Run all real LLM tests:
```bash
npm run test:e2e:real-llm
```

### Run with Docker:
```bash
npm run docker:e2e
```

### Run specific test:
```bash
npx jest tests/e2e-real/real-llm-integration.test.ts -t "should complete full compression workflow"
```

### Run with different model:
```bash
OLLAMA_MODEL=llama3.2:3b npm run test:e2e:real-llm
```

## Test Output

The tests provide detailed console output showing each phase:

```
🚀 Setting up Real LLM E2E Test Environment...
✓ Ollama is running
📥 Ensuring llama3.2:1b model is available...
✓ Model ready
🔧 Starting MCP Tool Aggregator server...
✓ MCP server connected

📋 PHASE 1: List initial tools
   Found 7 tools

🗜️  PHASE 2: Call compress_tools
   Response preview: Found 5 tools to compress...
   Extracted 5 tools to compress

🤖 PHASE 3: Real LLM compression
   Sending to Ollama for intelligent compression...
   LLM compressed 5 tool descriptions

   Tool: filesystem__read_file
   Original (156 chars): Reads the complete contents of a file at the specified path...
   Compressed (47 chars): Read file (text, max 10MB, abs/rel paths)

💾 PHASE 4: Save compressed descriptions
   Saved 5 compressed tool descriptions. These will now be used when listing tools.

✅ PHASE 5: Verify compression is active
   Sample tool: filesystem__read_file
   Description length: 47 chars
   Compression ratio: 30.1%

🎉 Real LLM E2E test passed!
```

## Performance

**Test Duration:**
- Setup: ~5-10 seconds (Ollama startup + model loading)
- Test execution: ~30-60 seconds (LLM inference)
- Total: **~1-2 minutes**

**Model Sizes:**
- `llama3.2:1b` - 1.3GB (faster, good enough for testing)
- `llama3.2:3b` - 2GB (better quality)
- `llama3.1:8b` - 4.7GB (highest quality, slower)

## Troubleshooting

### Ollama not running

```
⚠️  Ollama not running. Skipping real LLM tests.
   To enable: Install Ollama and run "ollama serve"
```

**Solution:**
```bash
ollama serve
```

### Model not found

```
Error: model 'llama3.2:1b' not found
```

**Solution:**
```bash
ollama pull llama3.2:1b
```

### Connection refused

```
Error: fetch failed: ECONNREFUSED 127.0.0.1:11434
```

**Solution:**
Check Ollama is running:
```bash
curl http://localhost:11434/api/tags
```

### Tests timeout

**Solution:** Increase timeout or use smaller model:
```bash
# Use faster model
OLLAMA_MODEL=llama3.2:1b npm run test:e2e:real-llm

# Or increase timeout
npx jest tests/e2e-real --testTimeout=300000
```

## CI/CD Integration

### GitHub Actions

The workflow in `.github/workflows/e2e-real-llm.yml` runs automatically on:
- Push to `main` or `development`
- Pull requests
- Manual dispatch (with model selection)

**Manual trigger:**
1. Go to Actions tab
2. Select "E2E Tests with Real LLM"
3. Click "Run workflow"
4. Choose model (optional)

### Test Matrix

The workflow can test against multiple models:
- `llama3.2:1b` (default, fast)
- `llama3.2:3b` (better quality)

Enable matrix testing by triggering manually.

## Why Real LLM Tests Matter

### What Mocked Tests Can't Validate

❌ LLM actually understands tool descriptions
❌ LLM follows natural language instructions
❌ Compression quality and intelligibility
❌ Real MCP protocol communication
❌ stdio transport reliability
❌ End-to-end system integration

### What Real LLM Tests Prove

✅ **Tool descriptions work** - LLM understands what to do
✅ **Workflow guidance works** - LLM follows multi-step instructions
✅ **Compression is intelligent** - Real AI inference, not string manipulation
✅ **MCP protocol is correct** - Actual client-server communication
✅ **System is production-ready** - Everything works together

## Cost

**Free!** Ollama runs locally with open-source models. No API costs.

## Architecture

```
┌─────────────────────┐
│  Jest Test Runner   │
└──────────┬──────────┘
           │
           ├─────────────────┐
           │                 │
           ▼                 ▼
   ┌──────────────┐   ┌─────────────┐
   │  MCP Client  │   │   Ollama    │
   │    (SDK)     │   │   (LLM)     │
   └──────┬───────┘   └──────┬──────┘
          │                  │
          │ stdio            │ HTTP
          ▼                  ▼
   ┌──────────────┐   ┌─────────────┐
   │  MCP Server  │   │  Llama 3.2  │
   │ (Aggregator) │   │    Model    │
   └──────────────┘   └─────────────┘
```

## Example Test Output

See actual test run:
```bash
npm run test:e2e:real-llm -- --verbose
```

## Contributing

When adding new real LLM tests:

1. **Keep tests focused** - Test specific integration points
2. **Add clear logging** - Show what's happening at each phase
3. **Handle timeouts** - LLM inference can be slow
4. **Verify quality** - Check compression actually improves things
5. **Document assumptions** - What model/environment is expected

## Resources

- [Ollama Documentation](https://ollama.com/docs)
- [Llama Models](https://ollama.com/library/llama3.2)
- [MCP SDK](https://github.com/modelcontextprotocol/sdk)
- [GitHub Actions Workflow](./.github/workflows/e2e-real-llm.yml)
