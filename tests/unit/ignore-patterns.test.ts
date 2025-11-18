import { describe, it, expect } from '@jest/globals';
import { matchesIgnorePattern } from '../../src/config/loader.js';

describe('Ignore Pattern Matching', () => {
  describe('matchesIgnorePattern', () => {
    it('should match exact tool names', () => {
      expect(matchesIgnorePattern('filesystem__read_file', ['filesystem__read_file'])).toBe(true);
      expect(matchesIgnorePattern('filesystem__write_file', ['filesystem__read_file'])).toBe(false);
    });

    it('should match server wildcard patterns', () => {
      expect(matchesIgnorePattern('filesystem__read_file', ['filesystem__*'])).toBe(true);
      expect(matchesIgnorePattern('filesystem__write_file', ['filesystem__*'])).toBe(true);
      expect(matchesIgnorePattern('github__create_issue', ['filesystem__*'])).toBe(false);
    });

    it('should match tool name wildcard patterns', () => {
      expect(matchesIgnorePattern('filesystem__set_file', ['*__set*'])).toBe(true);
      expect(matchesIgnorePattern('github__set_config', ['*__set*'])).toBe(true);
      expect(matchesIgnorePattern('filesystem__read_file', ['*__set*'])).toBe(false);
    });

    it('should match full wildcard', () => {
      expect(matchesIgnorePattern('any__tool', ['*'])).toBe(true);
      expect(matchesIgnorePattern('anything', ['*'])).toBe(true);
    });

    it('should be case insensitive', () => {
      expect(matchesIgnorePattern('FileSystem__Read_File', ['filesystem__*'])).toBe(true);
      expect(matchesIgnorePattern('filesystem__read_file', ['FILESYSTEM__*'])).toBe(true);
      expect(matchesIgnorePattern('GitHub__Create_Issue', ['*__create*'])).toBe(true);
    });

    it('should match multiple patterns', () => {
      const patterns = ['filesystem__*', '*__delete*', 'github__create_issue'];

      expect(matchesIgnorePattern('filesystem__read_file', patterns)).toBe(true);
      expect(matchesIgnorePattern('server__delete_item', patterns)).toBe(true);
      expect(matchesIgnorePattern('github__create_issue', patterns)).toBe(true);
      expect(matchesIgnorePattern('github__list_issues', patterns)).toBe(false);
    });

    it('should handle empty pattern list', () => {
      expect(matchesIgnorePattern('any__tool', [])).toBe(false);
    });

    it('should handle complex wildcards', () => {
      expect(matchesIgnorePattern('filesystem__test_read', ['*__test_*'])).toBe(true);
      expect(matchesIgnorePattern('test__file__read', ['test__*__*'])).toBe(true);
      expect(matchesIgnorePattern('a__b__c__d', ['*__c__*'])).toBe(true);
    });

    it('should escape regex special characters', () => {
      expect(matchesIgnorePattern('test__file.txt', ['test__file.txt'])).toBe(true);
      expect(matchesIgnorePattern('test__file(1)', ['test__file(1)'])).toBe(true);
      expect(matchesIgnorePattern('test__[file]', ['test__[file]'])).toBe(true);
    });

    it('should handle management tools', () => {
      const patterns = ['set_*', 'compress_*'];

      expect(matchesIgnorePattern('set_session', patterns)).toBe(true);
      expect(matchesIgnorePattern('compress_tools', patterns)).toBe(true);
      expect(matchesIgnorePattern('create_session', patterns)).toBe(false);
    });

    it('should match prefix patterns', () => {
      expect(matchesIgnorePattern('filesystem__read_file', ['filesystem__read*'])).toBe(true);
      expect(matchesIgnorePattern('filesystem__read_dir', ['filesystem__read*'])).toBe(true);
      expect(matchesIgnorePattern('filesystem__write_file', ['filesystem__read*'])).toBe(false);
    });

    it('should match suffix patterns', () => {
      expect(matchesIgnorePattern('filesystem__delete', ['*__delete'])).toBe(true);
      expect(matchesIgnorePattern('github__delete', ['*__delete'])).toBe(true);
      expect(matchesIgnorePattern('filesystem__delete_file', ['*__delete'])).toBe(false);
    });
  });
});
