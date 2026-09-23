import type { PayloadReference, PayloadStore } from '../cli/payload-interceptor.js';
import type { ModelBackend } from '../models/types.js';
import { shapeOutput, type ShapeMeta, type ShapeSpec } from './output-shaper.js';

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
      ...(stored ? { shapedPayload: stored } : {}),
    };
  }

  return { data: shaped.data, meta: shaped.meta, ...(source ? { source } : {}) };
}
