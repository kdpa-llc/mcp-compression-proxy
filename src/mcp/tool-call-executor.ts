import {
  CallToolResultSchema,
  type CallToolResult,
} from '@modelcontextprotocol/sdk/types.js';
import type { Logger } from 'pino';
import { matchesIgnorePattern } from '../config/loader.js';
import type { AuthFailureConfirmer, MCPClientManager } from './client-manager.js';

/** Raised for a call to a tool matched by `excludeTools`. */
export class ToolExcludedError extends Error {
  constructor(serverName: string, toolName: string) {
    super(`Tool '${serverName}__${toolName}' is excluded by the excludeTools configuration`);
    this.name = 'ToolExcludedError';
  }
}

type AttemptResult =
  | { result: CallToolResult; authFailure: boolean }
  | { error: unknown; authFailure: boolean };

function searchableText(value: unknown): string {
  if (value instanceof Error) {
    return `${value.name}: ${value.message}`;
  }
  if (typeof value === 'string') {
    return value;
  }

  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function isCallToolResult(value: unknown): value is CallToolResult {
  return (
    typeof value === 'object' &&
    value !== null &&
    Array.isArray((value as { content?: unknown }).content)
  );
}

export function matchesAuthenticationFailure(
  value: unknown,
  patterns: string[]
): boolean {
  if (patterns.length === 0) return false;

  const text = searchableText(value).toLowerCase();
  return patterns.some((pattern) => {
    const normalized = pattern.trim().toLowerCase();
    return normalized.length > 0 && text.includes(normalized);
  });
}

/**
 * A successful result shorter than this that matches an auth pattern is
 * treated as an auth failure outright: error bodies are short. Longer ones
 * may be content that merely quotes the pattern, and get a second opinion
 * when one is configured.
 */
export const AUTH_CONFIRM_MIN_CHARS = 2000;

function resultText(result: CallToolResult): string {
  return result.content
    .flatMap((item) => (item.type === 'text' && typeof item.text === 'string' ? [item.text] : []))
    .join('\n');
}

/**
 * Whether a pattern match on a tool result is a real auth failure. Fails
 * safe: without a confirmer, for error results, for short results, and when
 * the confirmer itself fails, the match stands, as it always did.
 */
async function confirmAuthFailure(
  result: CallToolResult,
  confirmer: AuthFailureConfirmer | undefined
): Promise<boolean> {
  if (!confirmer || result.isError === true) return true;
  const text = resultText(result);
  if (text.length < AUTH_CONFIRM_MIN_CHARS) return true;
  try {
    return await confirmer(text);
  } catch {
    return true;
  }
}

function isRetrySafe(
  serverName: string,
  toolName: string,
  patterns: string[]
): boolean {
  return (
    matchesIgnorePattern(toolName, patterns) ||
    matchesIgnorePattern(`${serverName}__${toolName}`, patterns)
  );
}

async function attemptToolCall(
  manager: MCPClientManager,
  logger: Logger,
  serverName: string,
  toolName: string,
  args: Record<string, unknown>,
  authErrorPatterns: string[]
): Promise<AttemptResult> {
  let authFailure = false;

  try {
    const result = await manager.withClient(
      serverName,
      async ({ client, invalidate, markFailure }) => {
        try {
          const rawResult = await client.callTool(
            {
              name: toolName,
              arguments: args,
            },
            CallToolResultSchema
          );
          if (!isCallToolResult(rawResult)) {
            throw new Error('Task-based MCP tool results are not supported by the proxy');
          }
          const callResult = rawResult;
          const patternMatched = matchesAuthenticationFailure(callResult, authErrorPatterns);
          if (
            patternMatched &&
            (await confirmAuthFailure(callResult, manager.getAuthFailureConfirmer()))
          ) {
            authFailure = true;
            invalidate('auth-error');
          } else if (patternMatched) {
            logger.info(
              { server: serverName, tool: toolName },
              'Auth error pattern appeared inside tool content; the model judged it not an authentication failure'
            );
          } else if (callResult.isError === true) {
            markFailure(`Tool '${toolName}' reported an error`);
          }
          return callResult;
        } catch (error) {
          if (matchesAuthenticationFailure(error, authErrorPatterns)) {
            authFailure = true;
            invalidate('auth-error');
          }
          throw error;
        }
      }
    );

    return { result, authFailure };
  } catch (error) {
    return { error, authFailure };
  }
}

/**
 * Execute a backend tool call and recover once from configured authentication
 * failures. Every auth failure invalidates the exact connection generation.
 * Automatic replay is restricted to explicitly configured read-only tools.
 */
export async function callToolWithAuthRecovery(
  manager: MCPClientManager,
  logger: Logger,
  serverName: string,
  toolName: string,
  args: Record<string, unknown>
): Promise<CallToolResult> {
  if (manager.isToolExcluded(serverName, toolName)) {
    throw new ToolExcludedError(serverName, toolName);
  }

  const policy = manager.getAuthRecoveryPolicy(serverName);
  const retrySafe = isRetrySafe(
    serverName,
    toolName,
    policy.authRetryTools
  );

  const first = await attemptToolCall(
    manager,
    logger,
    serverName,
    toolName,
    args,
    policy.authErrorPatterns
  );

  if (!first.authFailure || !retrySafe) {
    if (first.authFailure) {
      logger.warn(
        { server: serverName, tool: toolName },
        'Authentication failure invalidated the MCP connection; tool was not replayed'
      );
    }
    if ('error' in first) throw first.error;
    return first.result;
  }

  logger.warn(
    { server: serverName, tool: toolName },
    'Retrying read-only MCP tool after authentication recovery'
  );

  const second = await attemptToolCall(
    manager,
    logger,
    serverName,
    toolName,
    args,
    policy.authErrorPatterns
  );

  if ('error' in second) throw second.error;
  return second.result;
}
