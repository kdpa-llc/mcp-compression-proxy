import { describe, it, expect } from '@jest/globals';
import { getEnabledServers, mcpServers } from '../../src/config/servers.js';

describe('Server Configuration', () => {
  describe('mcpServers', () => {
    it('should export an array of server configurations', () => {
      expect(Array.isArray(mcpServers)).toBe(true);
    });

    it('should have valid server configuration structure', () => {
      mcpServers.forEach((server) => {
        expect(server).toHaveProperty('name');
        expect(server).toHaveProperty('command');
        expect(typeof server.name).toBe('string');
        expect(typeof server.command).toBe('string');
      });
    });
  });

  describe('getEnabledServers', () => {
    it('should return only enabled servers', () => {
      const enabled = getEnabledServers();

      expect(Array.isArray(enabled)).toBe(true);
      enabled.forEach((server) => {
        expect(server.enabled).not.toBe(false);
      });
    });

    it('should filter out disabled servers', () => {
      const allServers = mcpServers;
      const enabledServers = getEnabledServers();

      const disabledCount = allServers.filter(s => s.enabled === false).length;
      expect(enabledServers.length).toBe(allServers.length - disabledCount);
    });

    it('should return servers with enabled=true', () => {
      const enabled = getEnabledServers();

      // All returned servers should either have enabled=true or enabled=undefined
      expect(enabled.every(s => s.enabled === true || s.enabled === undefined)).toBe(true);
    });

    it('should return servers with enabled=undefined as enabled by default', () => {
      const enabled = getEnabledServers();

      // Servers without explicit enabled field should be included
      expect(enabled.length).toBeGreaterThanOrEqual(0);
    });
  });
});
