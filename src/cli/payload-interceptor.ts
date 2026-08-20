import { createHash } from 'crypto';
import { mkdtempSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const DEFAULT_THRESHOLD = 500;

/**
 * Private directory for intercepted payloads, created on first use.
 *
 * Writing `mcp_output_<hash>.txt` straight into the shared temp directory
 * made the path predictable from the content alone: another local user could
 * pre-plant a symlink there and turn our write into an arbitrary-file
 * overwrite, or simply read whatever a backend MCP server had just returned.
 * mkdtemp gives us a 0700 directory with an unpredictable name, so neither is
 * reachable. The name is stable for the lifetime of the process, which keeps
 * identical content mapping to a single file.
 */
let payloadDir: string | undefined;

function getPayloadDir(): string {
  if (payloadDir === undefined) {
    payloadDir = mkdtempSync(join(tmpdir(), 'mcp-output-'));
  }
  return payloadDir;
}

/**
 * Intercepts large tool call outputs, saves them to a temp file,
 * and returns a reference instead of the full payload.
 */
export function interceptPayload(
  output: string,
  threshold?: number
): string {
  const limit = threshold ?? DEFAULT_THRESHOLD;

  if (output.length <= limit) {
    return output;
  }

  const hash = createHash('sha256').update(output).digest('hex').slice(0, 12);
  const filename = `mcp_output_${hash}.txt`;
  const filepath = join(getPayloadDir(), filename);

  try {
    // 'wx' fails rather than following anything already at the path.
    writeFileSync(filepath, output, { encoding: 'utf-8', mode: 0o600, flag: 'wx' });
  } catch (error) {
    // Same content already written by this process - the existing file is the
    // file we were about to write, so reuse it. Anything else is a real error.
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
      throw error;
    }
  }

  return `Output saved to ${filepath} (${output.length} chars). Read file for full content.`;
}
