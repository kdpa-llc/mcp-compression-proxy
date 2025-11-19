#!/usr/bin/env node

import fs from 'fs';
import path from 'path';
import Ajv from 'ajv';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Read the config file
const configPath = path.join(process.env.HOME, '.mcp-compression-proxy/servers.json');
const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));

console.log(`Loaded config with ${config.mcpServers.length} servers`);

// Create a simple schema for testing
const testSchema = {
  type: 'object',
  properties: {
    mcpServers: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          command: { type: 'string' },
          args: { type: 'array', items: { type: 'string' } },
          env: { type: 'object' },
          enabled: { type: 'boolean' },
          disabled: { type: 'boolean' },
          timeout: { type: 'number' },
          type: { type: 'string' },
          autoApprove: { type: 'array', items: { type: 'string' } },
        },
        required: ['name', 'command'],
        additionalProperties: true
      }
    },
    excludeTools: { type: 'array', items: { type: 'string' } },
    noCompressTools: { type: 'array', items: { type: 'string' } }
  },
  required: ['mcpServers'],
  additionalProperties: false
};

const ajv = new Ajv({ allErrors: true });
const validate = ajv.compile(testSchema);

console.log('\nValidating config...');
const isValid = validate(config);

if (!isValid) {
  console.log('Validation failed:');
  validate.errors.forEach((err, i) => {
    console.log(`${i + 1}. ${err.instancePath || 'root'}: ${err.message}`);
    if (err.data) {
      console.log(`   Data: ${JSON.stringify(err.data, null, 2)}`);
    }
  });
} else {
  console.log('✅ Config validation passed!');
  
  // Count enabled servers
  const enabledServers = config.mcpServers.filter(server => {
    if (server.disabled === true) return false;
    return server.enabled !== false;
  });
  
  console.log(`\nServers summary:`);
  console.log(`- Total servers: ${config.mcpServers.length}`);
  console.log(`- Enabled servers: ${enabledServers.length}`);
  console.log(`- Enabled server names: ${enabledServers.map(s => s.name).join(', ')}`);
}
