import {
  DEFAULT_PAYLOAD_THRESHOLD,
  type PayloadReference,
  type PayloadStore,
} from '../cli/payload-interceptor.js';

export const MAX_CALL_SCRIPT_STEPS = 20;

export interface CallScriptStep {
  id: string;
  server: string;
  tool: string;
  arguments?: Record<string, unknown>;
  continueOnError?: boolean;
}

export interface CallScriptStepResult {
  id: string;
  server: string;
  tool: string;
  output: string;
  isError?: boolean;
  payload?: PayloadReference;
}

export interface CallScriptResult {
  steps: CallScriptStepResult[];
  stoppedAt?: string;
}

export type ScriptCallExecutor = (
  server: string,
  tool: string,
  args: Record<string, unknown>
) => Promise<{ output: string; isError?: boolean }>;

function decodePointerSegment(segment: string): string {
  return segment.replace(/~1/g, '/').replace(/~0/g, '~');
}

function resolveJsonPointer(value: unknown, pointer: string): unknown {
  if (pointer === '') return value;
  if (!pointer.startsWith('/')) {
    throw new Error(`JSON Pointer must be empty or start with "/": "${pointer}"`);
  }

  let current = value;
  for (const rawSegment of pointer.slice(1).split('/')) {
    const segment = decodePointerSegment(rawSegment);

    if (Array.isArray(current)) {
      if (!/^(0|[1-9]\d*)$/.test(segment)) {
        throw new Error(`JSON Pointer array index is invalid: "${segment}"`);
      }
      const index = Number(segment);
      if (index >= current.length) {
        throw new Error(`JSON Pointer array index is out of range: ${index}`);
      }
      current = current[index];
      continue;
    }

    if (typeof current === 'object' && current !== null) {
      if (!Object.prototype.hasOwnProperty.call(current, segment)) {
        throw new Error(`JSON Pointer property not found: "${segment}"`);
      }
      current = (current as Record<string, unknown>)[segment];
      continue;
    }

    throw new Error(`JSON Pointer cannot traverse through "${segment}"`);
  }

  return current;
}

function resolveReference(
  reference: string,
  priorResults: Map<string, unknown>
): unknown {
  const hashIndex = reference.indexOf('#');
  const stepId = hashIndex === -1 ? reference : reference.slice(0, hashIndex);
  const pointer = hashIndex === -1 ? '' : reference.slice(hashIndex + 1);
  if (!priorResults.has(stepId)) {
    throw new Error(`Unknown prior step "${stepId}" in reference "${reference}"`);
  }
  return resolveJsonPointer(priorResults.get(stepId), pointer);
}

function resolveReferences(
  value: unknown,
  priorResults: Map<string, unknown>
): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => resolveReferences(item, priorResults));
  }

  if (typeof value === 'object' && value !== null) {
    const entries = Object.entries(value);
    if (
      entries.length === 1 &&
      entries[0][0] === '$ref' &&
      typeof entries[0][1] === 'string'
    ) {
      return resolveReference(entries[0][1], priorResults);
    }

    return Object.fromEntries(
      entries.map(([key, nested]) => [
        key,
        resolveReferences(nested, priorResults),
      ])
    );
  }

  return value;
}

function parseOutput(output: string): unknown {
  try {
    return JSON.parse(output);
  } catch {
    return output;
  }
}

/**
 * Execute a bounded, declarative call chain.
 *
 * References use {"$ref":"stepId#/json/pointer"} and can only target earlier
 * steps. No arbitrary JavaScript or shell is evaluated.
 */
export async function runCallScript(
  steps: CallScriptStep[],
  execute: ScriptCallExecutor,
  payloadStore: PayloadStore,
  payloadThreshold = DEFAULT_PAYLOAD_THRESHOLD
): Promise<CallScriptResult> {
  if (steps.length > MAX_CALL_SCRIPT_STEPS) {
    throw new Error(`Call scripts may contain at most ${MAX_CALL_SCRIPT_STEPS} steps`);
  }

  const ids = new Set<string>();
  for (const step of steps) {
    if (!step.id) {
      throw new Error('Every call script step requires a non-empty id');
    }
    if (ids.has(step.id)) {
      throw new Error(`Duplicate script step id: "${step.id}"`);
    }
    ids.add(step.id);
  }

  const priorResults = new Map<string, unknown>();
  const results: CallScriptStepResult[] = [];

  for (const step of steps) {
    let resolvedArguments: Record<string, unknown>;
    try {
      const resolved = resolveReferences(
        step.arguments ?? {},
        priorResults
      );
      if (
        typeof resolved !== 'object' ||
        resolved === null ||
        Array.isArray(resolved)
      ) {
        throw new Error(`Arguments for step "${step.id}" must resolve to an object`);
      }
      resolvedArguments = resolved as Record<string, unknown>;
    } catch (error) {
      const output = error instanceof Error ? error.message : String(error);
      results.push({
        id: step.id,
        server: step.server,
        tool: step.tool,
        output,
        isError: true,
      });
      if (!step.continueOnError) {
        return { steps: results, stoppedAt: step.id };
      }
      priorResults.set(step.id, output);
      continue;
    }

    try {
      const callResult = await execute(
        step.server,
        step.tool,
        resolvedArguments
      );
      priorResults.set(step.id, parseOutput(callResult.output));
      const captured = payloadStore.capture(
        callResult.output,
        payloadThreshold
      );
      results.push({
        id: step.id,
        server: step.server,
        tool: step.tool,
        output: captured.output,
        isError: callResult.isError,
        payload: captured.reference,
      });

      if (callResult.isError && !step.continueOnError) {
        return { steps: results, stoppedAt: step.id };
      }
    } catch (error) {
      const output = error instanceof Error ? error.message : String(error);
      results.push({
        id: step.id,
        server: step.server,
        tool: step.tool,
        output,
        isError: true,
      });
      if (!step.continueOnError) {
        return { steps: results, stoppedAt: step.id };
      }
      priorResults.set(step.id, output);
    }
  }

  return { steps: results };
}
