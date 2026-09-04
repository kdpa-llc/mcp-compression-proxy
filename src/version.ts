/**
 * Identity this proxy reports to MCP peers during the initialize handshake.
 *
 * VERSION is kept in sync with package.json by `npm run sync-version`, which
 * semantic-release runs during a release (see .releaserc.json). The
 * `tests/unit/version.test.ts` guard fails CI if the two ever drift, so this
 * constant never needs to be edited by hand.
 */
export const SERVER_NAME = 'mcp-compression-proxy';
export const VERSION = '1.1.0';
