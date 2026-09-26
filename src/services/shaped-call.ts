import type { PayloadReference, PayloadStore } from '../cli/payload-interceptor.js';
import type { ModelBackend } from '../models/types.js';
import { shapeOutput, validateShapeSpec, type ShapeMeta, type ShapeSpec } from './output-shaper.js';

/** A payload as reported to the agent: enough to read or search it. */
export interface PayloadHandle {
  id: string;
  chars: number;
}

export interface ShapedOutput {
  data?: unknown;
  meta: ShapeMeta;
  /** The complete, unshaped output, kept so the shaped answer can be checked. */
  source?: PayloadHandle;
  /** Set instead of `data` when even the shaped answer exceeds the threshold. */
  shapedPayload?: PayloadHandle;
}

function handle(reference: PayloadReference | undefined): PayloadHandle | undefined {
  return reference ? { id: reference.id, chars: reference.chars } : undefined;
}

/** Whether a request carries anything to shape with. */
export function hasShapeSpec(spec: ShapeSpec | undefined): spec is ShapeSpec {
  return !!spec && (spec.want !== undefined || (typeof spec.where === 'string' && spec.where.trim() !== ''));
}

/** Pull want/where/limit out of loosely typed request parameters. */
export function readShapeSpec(params: Record<string, unknown> | undefined): ShapeSpec | undefined {
  if (!params) return undefined;
  const spec: ShapeSpec = {};
  if (params.want !== undefined) spec.want = params.want;
  if (typeof params.where === 'string') spec.where = params.where;
  const limit = Number(params.limit);
  if (Number.isInteger(limit) && limit > 0) spec.limit = limit;
  validateShapeSpec(spec);
  return hasShapeSpec(spec) ? spec : undefined;
}

/**
 * Shape a tool's output and keep the original as a payload.
 *
 * The source is stored whatever its size (threshold 0): a shaped answer is a
 * claim about the output, and the caller must be able to check it. The shaped
 * answer itself still respects the payload threshold.
 */
export async function shapeAndStore(
  output: string,
  spec: ShapeSpec,
  payloadStore: PayloadStore,
  threshold: number,
  model?: Pick<ModelBackend, 'embed' | 'extract'>
): Promise<ShapedOutput> {
  const source = handle(payloadStore.capture(output, 0).reference);
  const shaped = await shapeOutput(output, spec, model);

  // shapeOutput's data is parsed JSON, text or null - never undefined.
  const serialized = JSON.stringify(shaped.data);
  if (serialized.length > threshold) {
    // Over the threshold, capture always stores it, so this has a reference.
    const stored = handle(payloadStore.capture(serialized, threshold).reference);
    return {
      meta: {
        ...shaped.meta,
        notes: [
          ...shaped.meta.notes,
          `The shaped answer is still ${serialized.length} chars; it was stored as a payload. Narrow want, add where, or lower limit.`,
        ],
      },
      ...(source ? { source } : {}),
      shapedPayload: stored,
    };
  }

  return { data: shaped.data, meta: shaped.meta, ...(source ? { source } : {}) };
}

/** Returned only after a backend call succeeded, never by a shape-only operation. */
export interface CompletedShapedOutput extends ShapedOutput {
  execution: 'completed';
  /** A local post-call failure; it does not mean the backend operation failed. */
  warning?: string;
  /** Lossless fallback when the original could not be retained as a payload. */
  originalOutput?: string;
}

/**
 * Keep a successful backend outcome recoverable if optional shaping fails.
 * The deferred callback also encloses model lookup and payload storage. Do not
 * put the backend execution inside it: backend errors must retain their meaning.
 */
export async function shapeCompletedCall(
  output: string,
  payloadStore: PayloadStore,
  shape: () => Promise<ShapedOutput>
): Promise<CompletedShapedOutput> {
  try {
    return { ...(await shape()), execution: 'completed' };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    let source: PayloadHandle | undefined;
    try {
      // Usually reuses the already captured original; also recovers if storing
      // the shaped answer evicted it before failing.
      const reference = payloadStore.capture(output, 0).reference;
      // A failed write can leave a partial file behind. Do not offer a handle
      // unless the retained original can actually be read back losslessly.
      if (reference && payloadStore.read(reference.id, { all: true }).content === output) {
        source = handle(reference);
      }
    } catch {
      // A storage failure must not replace an already completed backend result.
    }
    return {
      execution: 'completed',
      warning: `Backend call completed, but shaping failed: ${reason}. Do not repeat the backend call because of this warning.`,
      meta: {
        method: 'none',
        missing: [],
        mismatched: [],
        notes: ['The unshaped original is available through source or originalOutput.'],
      },
      ...(source ? { source } : { originalOutput: output }),
    };
  }
}
