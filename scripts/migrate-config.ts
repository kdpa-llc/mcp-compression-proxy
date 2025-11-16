#!/usr/bin/env node

/**
 * Migration script to convert TypeScript config to JSON
 * Usage: npm run migrate-config
 */

import { writeFileSync, mkdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { homedir } from 'os';
import { mcpServers } from '../src/config/servers.js';

const DEFAULT_USER_CONFIG_PATH = join(homedir(), '.mcp-aggregator', 'servers.json');
const DEFAULT_PROJECT_CONFIG_PATH = join(process.cwd(), 'servers.json');

function migrateConfig(outputPath: string = DEFAULT_USER_CONFIG_PATH) {
  // Check if config already exists
  if (existsSync(outputPath)) {
    console.error(`❌ Configuration file already exists at: ${outputPath}`);
    console.error('   To prevent accidental overwrites, please remove or rename the existing file first.');
    process.exit(1);
  }

  // Ensure directory exists
  const dir = dirname(outputPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
    console.log(`📁 Created directory: ${dir}`);
  }

  // Convert TypeScript config to JSON format
  const jsonConfig = {
    mcpServers: mcpServers.map(server => {
      const config: any = {
        name: server.name,
        command: server.command,
      };

      if (server.args && server.args.length > 0) {
        config.args = server.args;
      }

      if (server.env && Object.keys(server.env).length > 0) {
        // Convert env vars to use ${VAR} syntax for those that reference process.env
        config.env = { ...server.env };
      }

      if (server.enabled !== undefined) {
        config.enabled = server.enabled;
      }

      return config;
    }),
  };

  // Write JSON file with pretty formatting
  writeFileSync(outputPath, JSON.stringify(jsonConfig, null, 2) + '\n', 'utf-8');

  console.log('\n✅ Migration successful!');
  console.log(`📄 Configuration written to: ${outputPath}`);
  console.log('\nNext steps:');
  console.log('1. Review the generated JSON configuration');
  console.log('2. Update environment variables to use ${VAR_NAME} syntax if needed');
  console.log('3. Test your configuration');
  console.log('4. Remove or comment out the TypeScript config in src/config/servers.ts');
}

// Parse command line arguments
const args = process.argv.slice(2);
const outputPath = args[0];

if (args.includes('--help') || args.includes('-h')) {
  console.log('Usage: npm run migrate-config [output-path]');
  console.log('');
  console.log('Migrates TypeScript configuration to JSON format.');
  console.log('');
  console.log('Arguments:');
  console.log('  output-path    Optional. Path to write JSON config (default: ~/.mcp-aggregator/servers.json)');
  console.log('');
  console.log('Examples:');
  console.log('  npm run migrate-config                    # Migrate to user-level config');
  console.log('  npm run migrate-config ./servers.json     # Migrate to project-level config');
  process.exit(0);
}

try {
  migrateConfig(outputPath);
} catch (error) {
  console.error('❌ Migration failed:', error instanceof Error ? error.message : error);
  process.exit(1);
}
