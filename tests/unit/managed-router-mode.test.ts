import { describe, expect, it } from '@jest/globals';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  isManagedRouterConfigured,
  managedRouterUnavailableMessage,
} from '../../src/cli/runtime-mode.js';

describe('managed router mode', () => {
  it('is enabled only when an active release pointer exists', () => {
    const baseDir = mkdtempSync(join(tmpdir(), 'mcp-managed-mode-'));
    expect(isManagedRouterConfigured(baseDir)).toBe(false);

    writeFileSync(join(baseDir, 'active-release.json'), '{}');
    expect(isManagedRouterConfigured(baseDir)).toBe(true);

    rmSync(baseDir, { recursive: true, force: true });
    expect(existsSync(baseDir)).toBe(false);
  });

  it('gives restricted Codex shells an actionable host-execution retry', () => {
    const message = managedRouterUnavailableMessage({
      CODEX_SANDBOX_NETWORK_DISABLED: '1',
    });

    expect(message).toContain('host/elevated execution');
    expect(message).toContain('sandbox_permissions=require_escalated');
    expect(message).toContain('do not run mcp-cli daemon start');
  });

  it('uses router-owner recovery guidance outside a restricted Codex shell', () => {
    const message = managedRouterUnavailableMessage({});

    expect(message).toContain('mcp-proxy-upgrade status');
    expect(message).toContain('only if host execution also fails');
  });
});
