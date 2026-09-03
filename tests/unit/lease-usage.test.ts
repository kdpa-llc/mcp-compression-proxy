import { describe, expect, it } from '@jest/globals';
import { readFileSync } from 'fs';
import { join } from 'path';

describe('managed client usage', () => {
  it('prevents production callers from bypassing lifecycle leases', () => {
    const callers = [
      'src/index.ts',
      'src/cli/daemon.ts',
      'src/services/stats-service.ts',
    ];

    for (const relativePath of callers) {
      const source = readFileSync(join(process.cwd(), relativePath), 'utf-8');
      expect(source).not.toMatch(/clientManager\.getClient\(/);
      expect(source).not.toMatch(/clientManager\.getConnectedClients\(/);
    }
  });
});
