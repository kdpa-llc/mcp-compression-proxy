import { spawn, type ChildProcess, type SpawnOptions } from 'child_process';
import { createInterface } from 'readline';
import type { Logger } from 'pino';
import type { ModelConfig } from '../config/schema.js';
import type {
  ModelBackend,
  ModelCall,
  ModelExtraction,
  ModelSelection,
  ModelToolSpec,
} from './types.js';

export const DEFAULT_MODEL_TIMEOUT_SECONDS = 60;
export const DEFAULT_MODEL_IDLE_TIMEOUT_SECONDS = 600;
/** After a failed start, fail fast for this long instead of respawning per request. */
const START_FAILURE_BACKOFF_MS = 60_000;
/** Loading the engine and weights takes seconds; allow more than one request. */
const START_TIMEOUT_FLOOR_MS = 120_000;

type SpawnFn = (command: string, args: string[], options: SpawnOptions) => ChildProcess;

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface RawSelection {
  calls?: ModelCall[];
  suppressed?: ModelCall[];
  confidence?: number | null;
  reasoning?: string;
  ungrounded?: string[];
}

function toSelection(raw: RawSelection): ModelSelection {
  return {
    calls: Array.isArray(raw.calls) ? raw.calls : [],
    suppressed: Array.isArray(raw.suppressed) ? raw.suppressed : [],
    confidence: typeof raw.confidence === 'number' ? raw.confidence : null,
    ...(typeof raw.reasoning === 'string' ? { reasoning: raw.reasoning } : {}),
    ungrounded: Array.isArray(raw.ungrounded) ? raw.ungrounded : [],
  };
}

function decodeVector(encoded: string): Float32Array {
  const bytes = Buffer.from(encoded, 'base64');
  // Copy into an aligned buffer: a Buffer slice may not start on a 4-byte boundary.
  const aligned = new ArrayBuffer(bytes.length);
  new Uint8Array(aligned).set(bytes);
  return new Float32Array(aligned);
}

/**
 * Talks to python/needle_bridge.py over newline-delimited JSON on stdio.
 *
 * The process starts on first use, is shared by concurrent requests, and
 * stops after `idleTimeout` seconds without work. While idle it is unref'd so
 * it never keeps the proxy alive; a failed start is remembered for a minute
 * so a missing Python package costs one error, not one spawn per search.
 */
export class NeedleBridge implements ModelBackend {
  readonly name = 'needle';
  private child: ChildProcess | undefined;
  private starting: Promise<ChildProcess> | undefined;
  private cancelStart: (() => void) | undefined;
  private closeOutput: (() => void) | undefined;
  private readonly pending = new Map<number, Pending>();
  private nextId = 1;
  private idleTimer: ReturnType<typeof setTimeout> | undefined;
  private startFailure: { at: number; message: string } | undefined;
  private closed = false;

  constructor(
    private readonly config: ModelConfig,
    private readonly scriptPath: string,
    private readonly logger: Logger,
    private readonly spawnFn: SpawnFn = spawn,
    private readonly now: () => number = Date.now
  ) {}

  private get timeoutMs(): number {
    return (this.config.timeout ?? DEFAULT_MODEL_TIMEOUT_SECONDS) * 1000;
  }

  private get idleTimeoutMs(): number {
    return (this.config.idleTimeout ?? DEFAULT_MODEL_IDLE_TIMEOUT_SECONDS) * 1000;
  }

  /** Why the model is unavailable, while a recent start failure is remembered. */
  unavailableReason(): string | undefined {
    if (this.startFailure && this.now() - this.startFailure.at < START_FAILURE_BACKOFF_MS) {
      return this.startFailure.message;
    }
    return undefined;
  }

  private ensureStarted(): Promise<ChildProcess> {
    if (this.closed) {
      return Promise.reject(new Error('Model bridge is closed'));
    }
    if (this.child) {
      return Promise.resolve(this.child);
    }
    const reason = this.unavailableReason();
    if (reason) {
      return Promise.reject(new Error(`Local model unavailable: ${reason}`));
    }
    this.starting ??= this.start().finally(() => {
      this.starting = undefined;
    });
    return this.starting;
  }

  private start(): Promise<ChildProcess> {
    const command = this.config.command ?? 'python3';
    const args = this.config.args ?? [this.scriptPath];
    this.logger.info({ command, args }, 'Starting local model bridge');

    return new Promise<ChildProcess>((resolve, reject) => {
      let settled = false;
      let child: ChildProcess;
      try {
        child = this.spawnFn(command, args, {
          stdio: ['pipe', 'pipe', 'pipe'],
          env: {
            ...process.env,
            ...this.config.env,
            // Never negotiable: the proxy promises nothing leaves the machine.
            NEEDLE_TELEMETRY: '0',
            DO_NOT_TRACK: '1',
            PYTHONUNBUFFERED: '1',
          },
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.startFailure = { at: this.now(), message };
        reject(new Error(`Local model unavailable: ${message}`));
        return;
      }

      const lines = child.stdout ? createInterface({ input: child.stdout }) : undefined;
      const stopStarting = (error: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(startTimer);
        this.cancelStart = undefined;
        lines?.close();
        child.stdin?.end();
        child.kill();
        reject(error);
      };
      const fail = (message: string) => {
        if (settled) return;
        this.startFailure = { at: this.now(), message };
        this.logger.warn({ reason: message }, 'Local model bridge failed to start');
        stopStarting(new Error(`Local model unavailable: ${message}`));
      };

      const startTimer = setTimeout(
        () => fail('timed out loading the model'),
        Math.max(this.timeoutMs, START_TIMEOUT_FLOOR_MS)
      );
      startTimer.unref?.();
      // Keep cancellation available before ready assigns this.child. Closing is
      // deliberate shutdown, not a failed load that should start a backoff.
      this.cancelStart = () => stopStarting(new Error('Model bridge is closed'));

      child.on('error', (error) => fail(error.message));
      // Writing to a bridge that has just died raises EPIPE on stdin; with no
      // listener that is an uncaught exception that would take the proxy
      // down. The exit handler already rejects whatever was in flight.
      child.stdin?.on('error', (error) => {
        this.logger.debug({ error: error.message }, 'Local model bridge stdin closed');
      });
      child.on('exit', (code, signal) => {
        fail(`bridge exited during startup (${signal ?? `code ${code}`})`);
        lines?.close();
        this.handleExit(child, code, signal);
      });

      child.stderr?.setEncoding('utf-8');
      child.stderr?.on('data', (chunk: string) => {
        this.logger.debug({ stderr: chunk.slice(0, 2000) }, 'Local model bridge stderr');
      });

      if (!lines) {
        fail('bridge has no stdout');
        return;
      }
      lines.on('line', (line) => {
        let message: Record<string, unknown>;
        try {
          message = JSON.parse(line) as Record<string, unknown>;
        } catch {
          this.logger.debug({ line: line.slice(0, 200) }, 'Ignoring non-JSON bridge output');
          return;
        }

        if (!settled) {
          if (typeof message.fatal === 'string') {
            fail(message.fatal);
          } else if (message.ready === true) {
            settled = true;
            clearTimeout(startTimer);
            this.cancelStart = undefined;
            this.child = child;
            this.closeOutput = () => lines?.close();
            this.startFailure = undefined;
            this.logger.info('Local model bridge ready');
            resolve(child);
          }
          return;
        }
        // A cancelled, failed or retired child cannot answer a later process's
        // requests, even if it emits buffered output after being stopped.
        if (!this.closed && this.child === child) this.handleResponse(message);
      });
    });
  }

  private handleResponse(message: Record<string, unknown>): void {
    const id = message.id as number;
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    clearTimeout(pending.timer);

    const error = message.error as { message?: string } | undefined;
    if (error) {
      pending.reject(new Error(`Local model error: ${error.message ?? 'unknown'}`));
    } else {
      pending.resolve(message.result);
    }
    this.afterSettle();
  }

  private handleExit(
    child: ChildProcess,
    code: number | null,
    signal: NodeJS.Signals | null
  ): void {
    if (this.child !== child) return;
    this.child = undefined;
    this.closeOutput?.();
    this.closeOutput = undefined;
    clearTimeout(this.idleTimer);
    const error = new Error(`Local model bridge exited (${signal ?? `code ${code}`})`);
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
      this.pending.delete(id);
    }
  }

  /** Keep the process referenced only while there is work in flight. */
  private setReferenced(referenced: boolean): void {
    const child = this.child;
    for (const handle of [child, child?.stdin, child?.stdout, child?.stderr]) {
      const refable = handle as unknown as { ref?: () => void; unref?: () => void } | null;
      if (referenced) refable?.ref?.();
      else refable?.unref?.();
    }
  }

  private afterSettle(): void {
    if (this.pending.size > 0) return;
    this.setReferenced(false);
    clearTimeout(this.idleTimer);
    if (this.idleTimeoutMs > 0) {
      // request() clears this timer, so it only fires with nothing in flight.
      this.idleTimer = setTimeout(() => {
        this.logger.info('Stopping idle local model bridge');
        this.stopChild();
      }, this.idleTimeoutMs);
      this.idleTimer.unref?.();
    }
  }

  private async request<T>(method: string, params: Record<string, unknown>): Promise<T> {
    const child = await this.ensureStarted();
    // Ready resolves a promise: close/exit can run before this continuation.
    if (this.closed) throw new Error('Model bridge is closed');
    if (this.child !== child) throw new Error('Local model bridge exited before request');
    clearTimeout(this.idleTimer);
    this.setReferenced(true);

    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Local model request timed out after ${this.timeoutMs / 1000}s`));
        this.afterSettle();
      }, this.timeoutMs);

      this.pending.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
        timer,
      });
      child.stdin?.write(JSON.stringify({ id, method, params }) + '\n');
    });
  }

  async embed(texts: string[]): Promise<Float32Array[]> {
    if (texts.length === 0) return [];
    const result = await this.request<{ vectors: string[] }>('embed', { texts });
    return result.vectors.map(decodeVector);
  }

  async selectTool(query: string, tools: ModelToolSpec[]): Promise<ModelSelection> {
    return toSelection(await this.request<RawSelection>('select', { query, tools }));
  }

  async extract(text: string, schema: ModelToolSpec): Promise<ModelExtraction> {
    const raw = await this.request<
      RawSelection & { value?: Record<string, unknown> | null; withheld?: boolean }
    >('extract', { text, schema });
    return {
      ...toSelection(raw),
      value: raw.value && typeof raw.value === 'object' ? raw.value : null,
      withheld: raw.withheld === true,
    };
  }

  private stopChild(): void {
    const child = this.child;
    if (!child) return;
    this.child = undefined;
    this.closeOutput?.();
    this.closeOutput = undefined;
    child.stdin?.end();
    child.kill();
  }

  async close(): Promise<void> {
    this.closed = true;
    this.cancelStart?.();
    clearTimeout(this.idleTimer);
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(new Error('Model bridge is closed'));
      this.pending.delete(id);
    }
    this.stopChild();
  }
}
