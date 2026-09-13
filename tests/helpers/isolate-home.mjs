// Test-only Node preload. NODE_OPTIONS also carries this into daemon children.
import assert from 'node:assert/strict';
import { statSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import os from 'node:os';
import { syncBuiltinESMExports } from 'node:module';

const testRoot = process.env.MCP_TEST_ROOT;
assert(
  testRoot && isAbsolute(testRoot) && statSync(testRoot).isDirectory(),
  'MCP_TEST_ROOT must be an existing absolute test directory'
);

// Patch lookups within this child only; never rewrite HOME or USERPROFILE.
os.homedir = () => testRoot;
syncBuiltinESMExports();

// Load the pure lookup seam before the real entrypoint discovers any config.
const { configHomeDirectory } = await import('../../dist/config/home-directory.js');
configHomeDirectory.get = () => testRoot;
