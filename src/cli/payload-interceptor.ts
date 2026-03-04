import { createHash } from 'crypto';
import { writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const DEFAULT_THRESHOLD = 500;

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
  const filepath = join(tmpdir(), filename);

  writeFileSync(filepath, output, 'utf-8');

  return `Output saved to ${filepath} (${output.length} chars). Read file for full content.`;
}
