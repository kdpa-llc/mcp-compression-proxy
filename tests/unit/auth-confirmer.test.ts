import { describe, it, expect, jest } from '@jest/globals';
import { excerpt, modelAuthConfirmer } from '../../src/models/auth-confirmer.js';
import type { ModelBackend, ModelExtraction } from '../../src/models/types.js';

function model(result: Partial<ModelExtraction> | 'hang') {
  const extract = jest.fn<ModelBackend['extract']>(async () => {
    if (result === 'hang') return new Promise<ModelExtraction>(() => undefined);
    return {
      calls: [],
      suppressed: [],
      confidence: 0.9,
      ungrounded: [],
      value: null,
      withheld: false,
      ...result,
    };
  });
  return { extract };
}

describe('modelAuthConfirmer', () => {
  it('overrules the pattern only for confident "content"', async () => {
    expect(await modelAuthConfirmer(model({ value: { kind: 'content' } }))('text')).toBe(false);
    expect(await modelAuthConfirmer(model({ value: { kind: 'authentication_failure' } }))('text')).toBe(true);
    expect(await modelAuthConfirmer(model({ value: { kind: 'content' }, confidence: 0.3 }))('text')).toBe(true);
    expect(await modelAuthConfirmer(model({ value: { kind: 'content' }, confidence: null }))('text')).toBe(true);
    expect(await modelAuthConfirmer(model({ value: { kind: 'content' }, withheld: true }))('text')).toBe(true);
    expect(await modelAuthConfirmer(model({ value: null }))('text')).toBe(true);
  });

  it('gives up after the timeout so a slow model cannot stall the call', async () => {
    await expect(modelAuthConfirmer(model('hang'), 0.7, 20)('text')).rejects.toThrow('timed out');
  });

  it('sends the start and end of a long result', async () => {
    const stub = model({ value: { kind: 'content' } });
    await modelAuthConfirmer(stub)(`${'a'.repeat(3000)}TAIL`);

    const sent = stub.extract.mock.calls[0][0];
    expect(sent.length).toBeLessThan(2300);
    expect(sent.endsWith('TAIL')).toBe(true);
    expect(excerpt('short')).toBe('short');
  });
});
