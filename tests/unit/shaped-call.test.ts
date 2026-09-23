import { describe, it, expect, afterEach } from '@jest/globals';
import { PayloadStore } from '../../src/cli/payload-interceptor.js';
import { hasShapeSpec, readShapeSpec, shapeAndStore } from '../../src/services/shaped-call.js';

describe('shaped calls', () => {
  const stores: PayloadStore[] = [];
  const store = () => {
    const created = new PayloadStore();
    stores.push(created);
    return created;
  };

  afterEach(() => {
    stores.splice(0).forEach((created) => created.destroy());
  });

  it('reads want, where and a positive integer limit from request parameters', () => {
    expect(readShapeSpec(undefined)).toBeUndefined();
    expect(readShapeSpec({ server: 's' })).toBeUndefined();
    expect(readShapeSpec({ where: '  ' })).toBeUndefined();
    expect(readShapeSpec({ want: { a: 'string' }, limit: 3 })).toEqual({ want: { a: 'string' }, limit: 3 });
    expect(readShapeSpec({ where: 'auth', limit: 0 })).toEqual({ where: 'auth' });
    expect(hasShapeSpec({})).toBe(false);
  });

  it('keeps the full source as a payload even when it is small', async () => {
    const payloads = store();
    const shaped = await shapeAndStore('{"a":1,"b":2}', { want: { a: 'number' } }, payloads, 10_000);

    expect(shaped.data).toEqual({ a: 1 });
    expect(shaped.source?.chars).toBe(13);
    expect(payloads.read(shaped.source!.id, { all: true }).content).toBe('{"a":1,"b":2}');
  });

  it('stores a shaped answer that is still over the threshold', async () => {
    const payloads = store();
    const big = JSON.stringify(Array.from({ length: 50 }, (_unused, id) => ({ id, name: `item ${id}` })));
    const shaped = await shapeAndStore(big, { want: [{ name: 'string' }] }, payloads, 100);

    expect(shaped.data).toBeUndefined();
    expect(shaped.shapedPayload?.id).toBeDefined();
    expect(shaped.meta.notes.join(' ')).toContain('stored as a payload');
  });
});
