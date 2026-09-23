/**
 * What the proxy asks of a local model. Every method may reject: callers
 * treat the model as an optional accelerator and fall back to the model-free
 * path, so no feature depends on one being installed.
 */
export interface ModelBackend {
  readonly name: string;
  /** One vector per input text, in order. */
  embed(texts: string[]): Promise<Float32Array[]>;
  /** Pick tool calls for a request among the given tools. */
  selectTool(query: string, tools: ModelToolSpec[]): Promise<ModelSelection>;
  /** Fill one record of the given shape from free text. */
  extract(text: string, schema: ModelToolSpec): Promise<ModelExtraction>;
  close(): Promise<void>;
}

/** A tool as the model sees it: OpenAI-style name, description, parameters. */
export interface ModelToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface ModelCall {
  name: string;
  arguments: Record<string, unknown>;
}

export interface ModelSelection {
  calls: ModelCall[];
  /** Calls the engine withheld as too uncertain to act on. */
  suppressed: ModelCall[];
  /** The model's own score in [0,1]; null when the weights carry no calibration head. */
  confidence: number | null;
  reasoning?: string;
  /** `tool.field` values not found in the input. */
  ungrounded: string[];
}

export interface ModelExtraction extends ModelSelection {
  value: Record<string, unknown> | null;
  /** The record came from a withheld (low-confidence) call. */
  withheld: boolean;
}
