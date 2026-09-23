import type { AuthFailureConfirmer } from '../mcp/client-manager.js';
import type { ModelBackend } from './types.js';

/** How sure the model must be that a result is ordinary content to overrule a pattern match. */
export const DEFAULT_CONTENT_CONFIDENCE = 0.7;
/** A second opinion that takes longer than this is skipped; the pattern match stands. */
export const DEFAULT_CONFIRM_TIMEOUT_MS = 5000;

const HEAD_CHARS = 1800;
const TAIL_CHARS = 400;

/** The start and end of a long result: where an auth error or login page shows itself. */
export function excerpt(text: string): string {
  if (text.length <= HEAD_CHARS + TAIL_CHARS) return text;
  return `${text.slice(0, HEAD_CHARS)}\n...\n${text.slice(-TAIL_CHARS)}`;
}

/**
 * Ask the local model whether a long tool result that matched an auth error
 * pattern is an authentication failure or content that mentions one.
 *
 * Overrules the pattern only when the model positively says "content" with
 * confidence: a real auth failure left unhandled costs more than a spurious
 * reconnect. Measured with the base Needle 3 weights on a wiki page quoting
 * an auth error and on a login page, it answered both wrongly with
 * confidence 0.22 and 0.14 and took 4-11 s, so with the default floor it
 * changes nothing; it is opt-in for fine-tuned weights that do better.
 */
export function modelAuthConfirmer(
  model: Pick<ModelBackend, 'extract'>,
  minConfidence = DEFAULT_CONTENT_CONFIDENCE,
  timeoutMs = DEFAULT_CONFIRM_TIMEOUT_MS
): AuthFailureConfirmer {
  return async (resultText: string) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error('auth check timed out')), timeoutMs);
    });
    const request = model.extract(excerpt(resultText), {
      name: 'tool_result',
      description:
        'Classify a tool result: an authentication failure (login page, expired or invalid credentials, sign-in required) or ordinary content returned by the tool.',
      parameters: {
        type: 'object',
        properties: {
          kind: { type: 'string', enum: ['authentication_failure', 'content'] },
        },
        required: ['kind'],
      },
    });

    // A timeout rejects, and the caller treats that as "the pattern stands".
    // Racing also marks a late rejection of the losing request as handled.
    let extraction;
    try {
      extraction = await Promise.race([request, timeout]);
    } finally {
      clearTimeout(timer);
    }

    const isContent =
      extraction.value?.kind === 'content' &&
      !extraction.withheld &&
      extraction.confidence !== null &&
      extraction.confidence >= minConfidence;
    return !isContent;
  };
}
