import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
import type { Logger } from 'pino';
import { NeedleBridge } from '../../src/models/needle-bridge.js';

/** Only the process boundary is fake; readline and the bridge run unchanged. */
function fakeChild(stdout = true) {
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: stdout ? new PassThrough() : undefined,
    stderr: new PassThrough(),
    kill: jest.fn(), ref: jest.fn(), unref: jest.fn(),
    written: [] as Array<{ id: number; method: string }>,
  });
  child.stdin.on('data', (chunk: Buffer) => {
    child.written.push(...chunk.toString().trim().split('\n').map((line) => JSON.parse(line)));
  });
  return child;
}
type FakeChild = ReturnType<typeof fakeChild>;
const say = (child: FakeChild, value: unknown) => child.stdout?.write(`${JSON.stringify(value)}\n`);
const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };
function watch<T>(promise: Promise<T>) {
  const result: { status: string; value?: T; error?: Error } = { status: 'pending' };
  void promise.then(
    (value) => { Object.assign(result, { status: 'fulfilled', value }); },
    (error: Error) => { Object.assign(result, { status: 'rejected', error }); }
  );
  return result;
}

describe('NeedleBridge startup lifecycle', () => {
  const models: NeedleBridge[] = [];
  const children: FakeChild[] = [];
  const logger = { debug: jest.fn(), info: jest.fn(), warn: jest.fn() } as unknown as Logger;
  const child = (stdout = true) => { const value = fakeChild(stdout); children.push(value); return value; };
  function bridge(spawn: () => FakeChild, idleTimeout = 0) {
    const spawnFn = jest.fn(spawn);
    const model = new NeedleBridge(
      { provider: 'needle', timeout: 5, idleTimeout }, '/synthetic/needle_bridge.py',
      logger, spawnFn as never
    );
    models.push(model);
    return { model, spawnFn };
  }
  beforeEach(() => { jest.useFakeTimers(); });
  afterEach(async () => {
    await Promise.all(models.splice(0).map((model) => model.close()));
    await flush();
    for (const value of children.splice(0)) {
      value.stdin.destroy(); value.stdout?.destroy(); value.stderr.destroy();
    }
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  it('cancels startup once, rejects every waiter, and ignores late readiness and data', async () => {
    const process = child();
    const { model, spawnFn } = bridge(() => process);
    const waits = [watch(model.embed(['a'])), watch(model.selectTool('b', [])),
      watch(model.extract('c', { name: 'item', description: '', parameters: {} }))];
    expect(spawnFn).toHaveBeenCalledTimes(1);
    await model.close();
    await flush();
    expect(waits.map((wait) => wait.status)).toEqual(['rejected', 'rejected', 'rejected']);
    expect(waits.map((wait) => wait.error?.message)).toEqual(Array(3).fill('Model bridge is closed'));
    expect(process.kill).toHaveBeenCalledTimes(1);
    expect(process.stdin.writableEnded).toBe(true);
    expect(jest.getTimerCount()).toBe(0);
    expect(process.stdout?.listenerCount('data')).toBe(0);
    say(process, { ready: true });
    say(process, { id: 1, result: { vectors: [] } });
    process.emit('error', new Error('late child error'));
    process.stdin.emit('error', new Error('late EPIPE'));
    process.emit('exit', null, 'SIGTERM');
    await model.close();
    await flush();
    expect(process.written).toEqual([]);
    expect(process.kill).toHaveBeenCalledTimes(1);
    expect(model.unavailableReason()).toBeUndefined();
    await expect(model.embed(['new'])).rejects.toThrow('Model bridge is closed');
    expect(spawnFn).toHaveBeenCalledTimes(1);
  });

  it('does not dispatch if close follows ready before the awaiting calls resume', async () => {
    const process = child();
    const { model } = bridge(() => process);
    const first = watch(model.embed(['a']));
    const second = watch(model.embed(['b']));
    say(process, { ready: true });
    await model.close();
    await model.close();
    await flush();
    expect([first.status, second.status]).toEqual(['rejected', 'rejected']);
    expect([first.error?.message, second.error?.message]).toEqual(Array(2).fill('Model bridge is closed'));
    expect(process.written).toEqual([]);
    expect(process.kill).toHaveBeenCalledTimes(1);
    expect(process.stdout?.listenerCount('data')).toBe(0);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('does not dispatch if the child exits after ready before requests resume', async () => {
    const process = child();
    const { model } = bridge(() => process);
    const waiting = watch(model.embed(['a']));
    say(process, { ready: true });
    process.emit('exit', 3, null);
    await flush();
    expect(waiting.status).toBe('rejected');
    expect(waiting.error?.message).toContain('Local model bridge exited');
    expect(process.written).toEqual([]);
    expect(process.stdout?.listenerCount('data')).toBe(0);
    expect(jest.getTimerCount()).toBe(0);
    expect(model.unavailableReason()).toBeUndefined();
  });

  it('closes before first use without spawning a child', async () => {
    const process = child();
    const { model, spawnFn } = bridge(() => process);
    await model.close();
    await model.close();
    await expect(model.embed(['a'])).rejects.toThrow('Model bridge is closed');
    expect(spawnFn).not.toHaveBeenCalled();
    expect(process.kill).not.toHaveBeenCalled();
    expect(jest.getTimerCount()).toBe(0);
  });

  it('shares normal startup and settles concurrent responses independently', async () => {
    const process = child();
    const { model, spawnFn } = bridge(() => process);
    const first = watch(model.embed(['a']));
    const second = watch(model.selectTool('b', []));
    say(process, { ready: true });
    await flush();
    expect(spawnFn).toHaveBeenCalledTimes(1);
    expect(process.written.map((request) => request.method)).toEqual(['embed', 'select']);
    const [one, two] = process.written;
    say(process, { id: two.id, error: { message: 'synthetic failure' } });
    await flush();
    expect(second.error?.message).toBe('Local model error: synthetic failure');
    expect(first.status).toBe('pending');
    expect(process.unref).not.toHaveBeenCalled();
    say(process, { id: one.id, result: { vectors: [] } });
    await flush();
    expect(first).toMatchObject({ status: 'fulfilled', value: [] });
    expect(process.unref).toHaveBeenCalled();
    expect(jest.getTimerCount()).toBe(0);
  });

  it('preserves closing requests already dispatched after readiness', async () => {
    const process = child();
    const { model } = bridge(() => process);
    const first = watch(model.embed(['a']));
    const second = watch(model.embed(['b']));
    say(process, { ready: true });
    await flush();
    expect(process.written).toHaveLength(2);
    await model.close();
    await model.close();
    say(process, { id: process.written[0].id, result: { vectors: [] } });
    await flush();
    expect([first.error?.message, second.error?.message]).toEqual(Array(2).fill('Model bridge is closed'));
    expect(process.kill).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(0);
  });

  it.each(['error', 'exit', 'fatal', 'timeout', 'missing stdout'] as const)(
    'cleans startup %s once and preserves unavailable/backoff semantics', async (failure) => {
      const process = child(failure !== 'missing stdout');
      const { model, spawnFn } = bridge(() => process);
      const first = watch(model.embed(['a']));
      const second = watch(model.embed(['b']));
      if (failure === 'error') process.emit('error', new Error('synthetic start error'));
      if (failure === 'exit') process.emit('exit', 2, null);
      if (failure === 'fatal') say(process, { fatal: 'synthetic fatal' });
      if (failure === 'timeout') await jest.advanceTimersByTimeAsync(120_000);
      await flush();
      expect([first.status, second.status]).toEqual(['rejected', 'rejected']);
      expect(first.error?.message).toContain('Local model unavailable:');
      expect(second.error?.message).toContain('Local model unavailable:');
      expect(process.kill).toHaveBeenCalledTimes(1);
      expect(process.stdin.writableEnded).toBe(true);
      expect(process.stdout?.listenerCount('data') ?? 0).toBe(0);
      expect(jest.getTimerCount()).toBe(0);
      await expect(model.embed(['retry'])).rejects.toThrow('Local model unavailable:');
      expect(spawnFn).toHaveBeenCalledTimes(1);
      say(process, { ready: true });
      process.emit('error', new Error('late error'));
      process.emit('exit', 2, null);
      await model.close();
      expect(process.kill).toHaveBeenCalledTimes(1);
      expect(process.written).toEqual([]);
    }
  );

  it('preserves synchronous spawn failures without leaving startup resources', async () => {
    const { model, spawnFn } = bridge(() => { throw new Error('synthetic spawn error'); });
    await expect(model.embed(['a'])).rejects.toThrow('Local model unavailable: synthetic spawn error');
    await expect(model.embed(['b'])).rejects.toThrow('Local model unavailable: synthetic spawn error');
    await model.close();
    expect(spawnFn).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('ignores late responses from a failed startup after a later child becomes ready', async () => {
    const old = child();
    const current = child();
    let count = 0;
    const { model } = bridge(() => count++ === 0 ? old : current);
    const failed = watch(model.embed(['old']));
    say(old, { fatal: 'synthetic failed load' });
    await flush();
    expect(failed.status).toBe('rejected');
    await jest.advanceTimersByTimeAsync(60_000);
    const waiting = watch(model.embed(['new']));
    say(current, { ready: true });
    await flush();
    const id = current.written[0].id;
    say(old, { ready: true });
    say(old, { id, error: { message: 'stale child response' } });
    old.emit('exit', 1, null);
    await flush();
    expect(waiting.status).toBe('pending');
    say(current, { id, result: { vectors: [] } });
    await flush();
    expect(waiting).toMatchObject({ status: 'fulfilled', value: [] });
  });

  it('ignores late responses from an idle-stopped child after a new start', async () => {
    const old = child();
    const current = child();
    let count = 0;
    const { model } = bridge(() => count++ === 0 ? old : current, 1);
    const first = watch(model.embed(['old']));
    say(old, { ready: true });
    await flush();
    say(old, { id: old.written[0].id, result: { vectors: [] } });
    await flush();
    expect(first.status).toBe('fulfilled');
    await jest.advanceTimersByTimeAsync(1_000);
    expect(old.kill).toHaveBeenCalledTimes(1);
    const waiting = watch(model.embed(['new']));
    say(current, { ready: true });
    await flush();
    const id = current.written[0].id;
    say(old, { id, error: { message: 'stale idle response' } });
    old.emit('exit', 0, null);
    await flush();
    expect(waiting.status).toBe('pending');
    say(current, { id, result: { vectors: [] } });
    await flush();
    expect(waiting).toMatchObject({ status: 'fulfilled', value: [] });
    await model.close();
    expect(current.kill).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(0);
  });
});
