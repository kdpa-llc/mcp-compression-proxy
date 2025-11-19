#!/usr/bin/env node

import { spawn } from 'child_process';
import { readFileSync } from 'fs';

console.log('Testing compression-proxy...\n');

const proxy = spawn('node', ['dist/index.js'], {
  stdio: ['pipe', 'pipe', 'pipe']
});

let stdoutData = '';
let stderrData = '';
let requestId = 1;

proxy.stdout.on('data', (data) => {
  stdoutData += data.toString();
  
  // Try to parse JSON-RPC messages
  const lines = stdoutData.split('\n');
  stdoutData = lines.pop(); // Keep incomplete line
  
  for (const line of lines) {
    if (line.trim()) {
      try {
        const response = JSON.parse(line);
        console.log('Response:', JSON.stringify(response, null, 2));
        
        if (response.id === 2 && response.result && response.result.tools) {
          console.log(`\n✅ SUCCESS: Got ${response.result.tools.length} tools`);
          console.log('\nTool names:');
          response.result.tools.forEach(t => console.log(`  - ${t.name}`));
          proxy.kill();
          process.exit(0);
        }
      } catch (e) {
        // Not JSON, ignore
      }
    }
  }
});

proxy.stderr.on('data', (data) => {
  stderrData += data.toString();
  console.error('STDERR:', data.toString());
});

proxy.on('close', (code) => {
  console.log(`\nProxy exited with code ${code}`);
  process.exit(code);
});

// Send initialize request
setTimeout(() => {
  const initRequest = {
    jsonrpc: '2.0',
    id: requestId++,
    method: 'initialize',
    params: {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: {
        name: 'test-client',
        version: '1.0.0'
      }
    }
  };
  
  console.log('Sending initialize request...');
  proxy.stdin.write(JSON.stringify(initRequest) + '\n');
}, 100);

// Send tools/list request after initialize
setTimeout(() => {
  const toolsRequest = {
    jsonrpc: '2.0',
    id: requestId++,
    method: 'tools/list',
    params: {}
  };
  
  console.log('\nSending tools/list request (after 10s delay for backend init)...');
  proxy.stdin.write(JSON.stringify(toolsRequest) + '\n');
}, 10000);

// Timeout after 30 seconds
setTimeout(() => {
  console.log('\n❌ TIMEOUT: No response after 30 seconds');
  proxy.kill();
  process.exit(1);
}, 30000);
