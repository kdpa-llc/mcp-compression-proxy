import { describe, expect, it, jest } from '@jest/globals';
import { PayloadStore } from '../../src/cli/payload-interceptor.js';
import { runCallScript } from '../../src/mcp/call-script.js';

describe('runCallScript', () => {
  it('executes sequential calls and resolves JSON Pointer references', async () => {
    const execute = jest.fn(async (
      _server: string,
      tool: string,
      args: Record<string, unknown>
    ) => {
      if (tool === 'search') {
        return {
          output: JSON.stringify({ results: [{ url: 'https://example.test/doc' }] }),
        };
      }
      return { output: JSON.stringify({ received: args }) };
    });

    const result = await runCallScript(
      [
        {
          id: 'search',
          server: 'docs',
          tool: 'search',
          arguments: { query: 'topic' },
        },
        {
          id: 'read',
          server: 'docs',
          tool: 'read',
          arguments: {
            url: { $ref: 'search#/results/0/url' },
          },
        },
      ],
      execute,
      new PayloadStore()
    );

    expect(result.stoppedAt).toBeUndefined();
    expect(execute).toHaveBeenNthCalledWith(
      2,
      'docs',
      'read',
      { url: 'https://example.test/doc' }
    );
    expect(result.steps).toHaveLength(2);
  });

  it('stops after an error unless continueOnError is set', async () => {
    const stopExecute = jest.fn(async (_server: string, tool: string) => ({
      output: tool === 'fail' ? 'failed' : 'ok',
      isError: tool === 'fail',
    }));

    const stopped = await runCallScript(
      [
        { id: 'first', server: 's', tool: 'fail' },
        { id: 'second', server: 's', tool: 'next' },
      ],
      stopExecute,
      new PayloadStore()
    );

    expect(stopped.stoppedAt).toBe('first');
    expect(stopExecute).toHaveBeenCalledTimes(1);

    const continueExecute = jest.fn(async (_server: string, tool: string) => ({
      output: tool === 'fail' ? 'failed' : 'ok',
      isError: tool === 'fail',
    }));
    const continued = await runCallScript(
      [
        {
          id: 'first',
          server: 's',
          tool: 'fail',
          continueOnError: true,
        },
        { id: 'second', server: 's', tool: 'next' },
      ],
      continueExecute,
      new PayloadStore()
    );

    expect(continued.stoppedAt).toBeUndefined();
    expect(continueExecute).toHaveBeenCalledTimes(2);
  });

  it('reports invalid or forward references without executing that step', async () => {
    const execute = jest.fn(async () => ({ output: 'ok' }));

    const result = await runCallScript(
      [
        {
          id: 'first',
          server: 's',
          tool: 't',
          arguments: { value: { $ref: 'later#/value' } },
        },
        { id: 'later', server: 's', tool: 't' },
      ],
      execute,
      new PayloadStore()
    );

    expect(result.stoppedAt).toBe('first');
    expect(result.steps[0].isError).toBe(true);
    expect(result.steps[0].output).toContain('Unknown prior step');
    expect(execute).not.toHaveBeenCalled();
  });

  it('rejects duplicate IDs and scripts longer than the maximum', async () => {
    const execute = jest.fn(async () => ({ output: 'ok' }));

    await expect(runCallScript(
      [
        { id: 'same', server: 's', tool: 'one' },
        { id: 'same', server: 's', tool: 'two' },
      ],
      execute,
      new PayloadStore()
    )).rejects.toThrow('Duplicate script step id');

    await expect(runCallScript(
      Array.from({ length: 21 }, (_, index) => ({
        id: `step-${index}`,
        server: 's',
        tool: 't',
      })),
      execute,
      new PayloadStore()
    )).rejects.toThrow('at most 20 steps');
  });

  it('caches large step output while retaining it for later references', async () => {
    const largeValue = 'x'.repeat(12_000);
    const execute = jest.fn(async (
      _server: string,
      tool: string,
      _args: Record<string, unknown>
    ) => {
      if (tool === 'large') {
        return { output: JSON.stringify({ value: largeValue }) };
      }
      return { output: 'done' };
    });
    const store = new PayloadStore();

    const result = await runCallScript(
      [
        { id: 'large', server: 's', tool: 'large' },
        {
          id: 'consume',
          server: 's',
          tool: 'consume',
          arguments: { value: { $ref: 'large#/value' } },
        },
      ],
      execute,
      store,
      10_000
    );

    expect(result.steps[0].payload).toBeDefined();
    expect(result.steps[0].output).toContain('Payload ID');
    expect(execute).toHaveBeenNthCalledWith(
      2,
      's',
      'consume',
      { value: largeValue }
    );

    store.destroy();
  });

  it('reports a shaped step while later references still see the full output', async () => {
    const store = new PayloadStore();
    const execute = jest.fn(async (_server: string, tool: string, args: Record<string, unknown>) => {
      if (tool === 'list') {
        return {
          output: JSON.stringify({
            items: [
              { id: 1, title: 'auth bug', secret: 'x' },
              { id: 2, title: 'docs', secret: 'y' },
            ],
          }),
        };
      }
      return { output: JSON.stringify({ received: args }) };
    });

    try {
      const result = await runCallScript(
        [
          { id: 'list', server: 's', tool: 'list', want: { items: [{ id: 'integer' }] }, where: 'auth' },
          { id: 'use', server: 's', tool: 'use', arguments: { secret: { $ref: 'list#/items/1/secret' } } },
        ],
        execute,
        store,
        10_000,
        async (output, spec) => {
          const { shapeAndStore } = await import('../../src/services/shaped-call.js');
          return shapeAndStore(output, spec, store, 10_000);
        }
      );

      expect(JSON.parse(result.steps[0].output)).toEqual({ items: [{ id: 1 }] });
      expect(result.steps[0].shaped?.meta.filter?.where).toBe('auth');
      expect(result.steps[0].shaped?.source?.id).toBeDefined();
      expect(execute).toHaveBeenLastCalledWith('s', 'use', { secret: 'y' });
    } finally {
      store.destroy();
    }
  });

  it('ignores want/where when no shaper is supplied', async () => {
    const store = new PayloadStore();
    try {
      const result = await runCallScript(
        [{ id: 'a', server: 's', tool: 't', want: { x: 'number' } }],
        async () => ({ output: '{"x":1,"y":2}' }),
        store
      );
      expect(result.steps[0].output).toBe('{"x":1,"y":2}');
      expect(result.steps[0].shaped).toBeUndefined();
    } finally {
      store.destroy();
    }
  });
});
