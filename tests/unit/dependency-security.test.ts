import { describe, expect, it } from '@jest/globals';
import { parse, normalize, equal } from 'fast-uri';
import { Address4, Address6, AddressError } from 'ip-address';

// Pure dependency behavior checks; no network exploit simulation.

describe('Host canonicalization across equivalent spellings', () => {
  it('folds decoded host case', () => {
    expect(parse('//%41.com').host).toBe('a.com');
  });

  it('normalizes the host idempotently', () => {
    expect(normalize('//%41.com')).toBe('//a.com');
    expect(normalize(normalize('//%41.com'))).toBe('//a.com');
  });

  it('compares encoded and literal hosts equally', () => {
    expect(equal('//%41.com', '//a.com')).toBe(true);
  });

  it('preserves path case', () => {
    expect(equal('//%41.com/Path', '//a.com/path')).toBe(false);
  });
});

describe('Address-family containment boundaries', () => {
  it.each(['isInSubnet', 'isHostInSubnet'] as const)('%s rejects IPv6 in IPv4', (method) => {
    expect(new Address6('a00::1')[method](new Address4('10.0.0.0/8'))).toBe(false);
  });

  it.each(['isInSubnet', 'isHostInSubnet'] as const)('%s rejects IPv4 in IPv6', (method) => {
    expect(new Address4('32.0.0.1')[method](new Address6('2000::/3'))).toBe(false);
  });

  it.each(['isInSubnet', 'isHostInSubnet'] as const)(
    '%s preserves same-family and explicit conversion controls',
    (method) => {
      expect(new Address4('10.0.0.1')[method](new Address4('10.0.0.0/8'))).toBe(true);
      expect(new Address4('8.8.8.8')[method](new Address4('10.0.0.0/8'))).toBe(false);
      expect(new Address6('2001:db8::1')[method](new Address6('2001:db8::/32'))).toBe(true);
      expect(new Address6('2001:db9::1')[method](new Address6('2001:db8::/32'))).toBe(false);
      expect(new Address6('::ffff:10.0.0.1').to4()[method](new Address4('10.0.0.0/8'))).toBe(true);
    }
  );
});

describe('Bounded IPv6 parsing diagnostics', () => {
  it('accepts the 45-character IPv6 boundary', () => {
    const address = 'ffff:ffff:ffff:ffff:ffff:ffff:255.255.255.255';
    expect(address).toHaveLength(45);
    expect(Address6.isValid(address)).toBe(true);
    expect(new Address6(address).correctForm()).toBe('ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff');
  });

  it('rejects 46 characters without an amplified diagnostic', () => {
    const address = '!'.repeat(46);
    expect(() => new Address6(address)).toThrow(AddressError);
    try {
      new Address6(address);
    } catch (error) {
      expect(error).toBeInstanceOf(AddressError);
      expect((error as AddressError).parseMessage).toBeUndefined();
    }
    expect(Address6.isValid(address)).toBe(false);
  });
});

import { createRequire } from 'node:module';
import { resolve } from 'node:path';

const dependencyRequire = createRequire(resolve(process.cwd(), 'package.json'));

type BraceExpand = (
  source: string,
  options?: {
    max?: number;
    maxLength?: number;
    maxDepth?: number;
    maxRewrites?: number;
  }
) => string[];
const braceCjs = dependencyRequire('brace-expansion') as {
  expand: BraceExpand;
};
const testExcludeRequire = createRequire(dependencyRequire.resolve('test-exclude'));
const globConsumerRequire = createRequire(testExcludeRequire.resolve('glob'));
const nestedMinimatch = globConsumerRequire('minimatch') as {
  braceExpand: (pattern: string) => string[];
};
const nestedMinimatchRequire = createRequire(globConsumerRequire.resolve('minimatch'));
const nestedBrace = nestedMinimatchRequire('brace-expansion') as BraceExpand;
const minimatchConsumer = dependencyRequire('minimatch') as {
  braceExpand: (pattern: string) => string[];
};

// Bound work by documented parser budgets and exact outputs, never elapsed time.
describe.each([
  ['CommonJS', braceCjs.expand],
  ['Nested CommonJS 2.x', nestedBrace],
] as const)('Brace expansion limits (%s)', (_format, expand) => {
  it('returns a literal when the rewrite budget is exhausted', () => {
    for (const cap of [0, 2]) {
      const source = '{a}' + '}'.repeat(cap + 1) + ',z}';
      expect(expand(source, { maxRewrites: cap })).toEqual([source]);
    }
  });

  it('retains the ordinary rewrite within its budget', () => {
    expect(expand('{a},b}', { maxRewrites: 1 })).toEqual(['a}', 'b']);
  });

  it('bounds default rewrites on a small one-kilobyte pattern', () => {
    const source = '{a}' + '}'.repeat(1002) + ',z}';
    expect(source.length).toBeLessThan(1100);
    expect(expand(source)).toEqual([source]);
  });

  it('treats nesting beyond an explicit depth budget literally', () => {
    const source = '{{{{{a,b}}}}}';
    expect(expand(source, { maxDepth: 0 })).toEqual([source]);
    expect(expand(source, { maxDepth: 2 })).toEqual([source]);
    expect(expand('{a,b}', { maxDepth: 2 })).toEqual(['a', 'b']);
  });

  it('preserves normal nested, escaped, ranged and limited expansions', () => {
    expect(expand('{a,{b,c}}{1..2}')).toEqual(['a1', 'a2', 'b1', 'b2', 'c1', 'c2']);
    expect(expand('\\{a,b\\}')).toEqual(['{a,b}']);
    expect(expand('{a,b}{1,2}', { max: 1 })).toEqual(['a1']);
    expect(expand('{aa,bb}', { maxLength: 2 })).toEqual(['aa']);
  });
});

describe.each([
  ['root 10.x', minimatchConsumer],
  ['nested 9.x', nestedMinimatch],
] as const)('Actual minimatch brace consumer (%s)', (_consumer, actualMinimatch) => {
  it('uses the dependency default rewrite bound', () => {
    const source = '{a}' + '}'.repeat(1002) + ',z}';
    expect(actualMinimatch.braceExpand(source)).toEqual([source]);
  });
  it('preserves normal and escaped glob alternatives', () => {
    expect(actualMinimatch.braceExpand('src/{a,b}{1..2}.ts')).toEqual([
      'src/a1.ts',
      'src/a2.ts',
      'src/b1.ts',
      'src/b2.ts',
    ]);
    expect(actualMinimatch.braceExpand('src/\\{a,b\\}.ts')).toEqual(['src/{a,b}.ts']);
  });
});

// TestExclude pattern checks do not walk or inspect the filesystem.
const TestExclude = dependencyRequire('test-exclude') as new (options: {
  cwd: string;
  include: string[];
  exclude: string[];
  extension: string[];
}) => { shouldInstrument(filename: string): boolean };
describe('Coverage exclusion consumer compatibility', () => {
  it('preserves include, exclude and explicit re-inclusion decisions', () => {
    const root = process.cwd();
    const consumer = new TestExclude({
      cwd: root,
      include: ['src/**/*.{js,ts}'],
      exclude: ['**/*.test.ts', '!src/keep.test.ts'],
      extension: ['.js', '.ts'],
    });
    expect(consumer.shouldInstrument(resolve(root, 'src/logic.ts'))).toBe(true);
    expect(consumer.shouldInstrument(resolve(root, 'src/logic.js'))).toBe(true);
    expect(consumer.shouldInstrument(resolve(root, 'src/logic.test.ts'))).toBe(false);
    expect(consumer.shouldInstrument(resolve(root, 'src/keep.test.ts'))).toBe(true);
    expect(consumer.shouldInstrument(resolve(root, 'docs/logic.ts'))).toBe(false);
    expect(consumer.shouldInstrument(resolve(root, 'node_modules/logic.ts'))).toBe(false);
  });
});

type RetryOptions = {
  method: string;
  body?: import('node:stream').Readable;
  headers?: Record<string, string>;
  retryOptions: {
    maxRetries?: number;
    retry?: (error: Error, context: unknown, callback: (error?: Error) => void) => void;
  };
};
type RetryFixture = {
  onConnect(abort: (error: Error) => void): void;
  onHeaders(status: number, headers: string[], resume: () => void, message: string): boolean;
  onData(chunk: Buffer): boolean;
  onError(error: Error): void;
  onComplete(trailers: string[]): void;
};
type RetryHandlers = {
  dispatch(options: RetryOptions, handler: RetryFixture): void;
  handler: {
    onConnect(abort: (error: Error) => void): void;
    onHeaders(status: number): boolean;
    onData(chunk: Buffer): boolean;
    onError(error: Error): void;
    onComplete(): void;
  };
};
// Anchor the installed Actions consumer's import-only entry without loading it.
const actionsRequire = createRequire(
  resolve(process.cwd(), 'node_modules/@actions/http-client/lib/index.js')
);
const NestedRetryHandler = actionsRequire('undici/lib/handler/retry-handler.js') as new (
  options: RetryOptions,
  handlers: RetryHandlers
) => RetryFixture;

const { Readable: FixtureReadable } = dependencyRequire(
  'node:stream'
) as typeof import('node:stream');
const { RequestRetryError: NestedRequestRetryError } = actionsRequire(
  'undici/lib/core/errors.js'
) as { RequestRetryError: typeof Error };

function retryFixture(method = 'GET', retries = true, body?: import('node:stream').Readable) {
  const requests: RetryOptions[] = [];
  const statuses: number[] = [];
  const chunks: Buffer[] = [];
  const errors: Error[] = [];
  const aborts: Error[] = [];
  let cancel: (error: Error) => void = () => {};
  let complete = 0;
  const retry = new NestedRetryHandler(
    {
      method,
      body,
      retryOptions: retries
        ? { retry: (_error, _context, callback) => callback() }
        : { maxRetries: 0 },
    },
    {
      dispatch(options) {
        // A finite in-memory callback sink: no network, timer or recursion.
        if (requests.length >= 2) throw new Error('fixture dispatch budget');
        requests.push(options);
      },
      handler: {
        onConnect(abort) {
          cancel = abort;
        },
        onHeaders(status) {
          statuses.push(status);
          return true;
        },
        onData(chunk) {
          chunks.push(chunk);
          return true;
        },
        onError(error) {
          errors.push(error);
        },
        onComplete() {
          complete++;
        },
      },
    }
  );
  retry.onConnect((error) => aborts.push(error));
  return {
    retry,
    requests,
    statuses,
    errors,
    aborts,
    cancel: (error: Error) => cancel(error),
    body: () => Buffer.concat(chunks).toString(),
    completed: () => complete,
  };
}
const socketFailure = () =>
  Object.assign(new Error('fixture reset'), {
    code: 'ECONNRESET',
  });
const resumeFixture = () => {};

describe('Nested Undici retry framing', () => {
  it.each([404, 302])('bounds a resumed %s body to its forwarded length', (status) => {
    const f = retryFixture();
    f.retry.onHeaders(status, ['content-length', '2'], resumeFixture, 'fixture');
    f.retry.onData(Buffer.from('a'));
    f.retry.onError(socketFailure());
    expect(f.requests).toHaveLength(1);
    expect(f.requests[0]?.headers?.range).toBe('bytes=1-1');
    expect(f.statuses).toEqual([status]);
    expect(f.body()).toBe('a');
  });

  it.each([404, 302])(
    'rejects an overlong resume after %s without new downstream headers',
    (status) => {
      const f = retryFixture();
      f.retry.onHeaders(status, ['content-length', '2'], resumeFixture, 'fixture');
      f.retry.onData(Buffer.from('a'));
      f.retry.onError(socketFailure());
      const accepted = f.retry.onHeaders(
        206,
        ['content-length', '3', 'content-range', 'bytes 1-3/4'],
        resumeFixture,
        'fixture'
      );
      if (accepted) f.retry.onData(Buffer.from('bcd'));
      expect(accepted).toBe(false);
      expect(f.aborts).toHaveLength(1);
      expect(f.aborts[0]?.message).toMatch(/Content-Range mismatch/);
      expect(f.aborts[0]).toBeInstanceOf(NestedRequestRetryError);
      expect(f.aborts[0]).toMatchObject({ code: 'UND_ERR_REQ_RETRY' });
      expect(f.statuses).toEqual([status]);
      expect(f.body()).toBe('a');
    }
  );

  it.each(['GET', 'HEAD'])(
    'does not retry a forwarded %s response without a resumable body',
    (method) => {
      const f = retryFixture(method);
      f.retry.onHeaders(
        404,
        method === 'HEAD' ? ['content-length', '2'] : [],
        resumeFixture,
        'fixture'
      );
      const error = socketFailure();
      f.retry.onError(error);
      expect(f.requests).toEqual([]);
      expect(f.errors).toEqual([error]);
      expect(f.statuses).toEqual([404]);
    }
  );

  it.each([200, 206])('preserves a valid partial %s response and completes once', (status) => {
    const f = retryFixture();
    const headers =
      status === 206
        ? ['content-length', '2', 'content-range', 'bytes 0-1/2']
        : ['content-length', '2'];
    f.retry.onHeaders(status, headers, resumeFixture, 'fixture');
    f.retry.onData(Buffer.from('a'));
    f.retry.onError(socketFailure());
    expect(f.requests[0]?.headers?.range).toBe('bytes=1-1');
    expect(
      f.retry.onHeaders(
        206,
        ['content-length', '1', 'content-range', 'bytes 1-1/2'],
        resumeFixture,
        'fixture'
      )
    ).toBe(true);
    f.retry.onData(Buffer.from('b'));
    f.retry.onComplete([]);
    expect(f.statuses).toEqual([status]);
    expect(f.body()).toBe('ab');
    expect(f.completed()).toBe(1);
    expect(f.aborts).toEqual([]);
  });

  it.each(['bytes 0-0/2', 'bytes 1-2/3'])('reports %s as a controlled range error', (range) => {
    const f = retryFixture();
    f.retry.onHeaders(200, ['content-length', '2'], resumeFixture, 'fixture');
    f.retry.onData(Buffer.from('a'));
    f.retry.onError(socketFailure());
    expect(() => {
      const accepted = f.retry.onHeaders(
        206,
        ['content-length', range === 'bytes 0-0/2' ? '1' : '2', 'content-range', range],
        resumeFixture,
        'fixture'
      );
      expect(accepted).toBe(false);
    }).not.toThrow();
    expect(f.aborts).toHaveLength(1);
    expect(f.aborts[0]?.message).toMatch(/Content-Range mismatch/);
    expect(f.aborts[0]).toBeInstanceOf(NestedRequestRetryError);
    expect(f.aborts[0]).toMatchObject({ code: 'UND_ERR_REQ_RETRY' });
    expect(f.body()).toBe('a');
  });

  it('does not replay an already consumed in-memory request body', () => {
    const body = FixtureReadable.from([Buffer.from('a')]);
    try {
      expect(body.read()?.toString()).toBe('a');
      expect(FixtureReadable.isDisturbed(body)).toBe(true);
      const f = retryFixture('POST', true, body);
      const error = socketFailure();
      f.retry.onError(error);
      expect(f.requests).toEqual([]);
      expect(f.errors).toEqual([error]);
    } finally {
      body.destroy();
    }
  });

  it('rejects a content length that disagrees with a partial response range', () => {
    const f = retryFixture();
    expect(
      f.retry.onHeaders(
        206,
        ['content-length', '2', 'content-range', 'bytes 0-0/1'],
        resumeFixture,
        'fixture'
      )
    ).toBe(false);
    expect(f.aborts).toHaveLength(1);
    expect(f.aborts[0]).toBeInstanceOf(NestedRequestRetryError);
    expect(f.aborts[0]).toMatchObject({ code: 'UND_ERR_REQ_RETRY' });
    expect(f.aborts[0]?.message).toMatch(/Content-Length mismatch/);
    expect(f.statuses).toEqual([]);
    expect(f.body()).toBe('');
  });

  it('preserves cancellation and configured zero-retry controls', () => {
    const cancelled = retryFixture();
    const error = socketFailure();
    cancelled.cancel(error);
    cancelled.retry.onError(error);
    expect(cancelled.requests).toEqual([]);
    expect(cancelled.aborts).toEqual([error]);
    expect(cancelled.errors).toEqual([error]);

    const disabled = retryFixture('GET', false);
    disabled.retry.onError(error);
    expect(disabled.requests).toEqual([]);
    expect(disabled.errors).toEqual([error]);
  });
});

type StreamState = {
  origin: string;
  lastEventId: string;
  reconnectionTime: number;
};
type StreamEvent = {
  type: string;
  options: { data: string; lastEventId: string; origin: string };
};
const { EventSourceStream: NestedEventSourceStream } = actionsRequire(
  'undici/lib/web/eventsource/eventsource-stream.js'
) as {
  EventSourceStream: new (options: {
    eventSourceSettings: StreamState;
    push: (event: StreamEvent) => boolean;
  }) => {
    _transform(chunk: Buffer, encoding: string, done: () => void): void;
    destroy(): void;
  };
};

describe('Nested Undici event-stream compatibility', () => {
  it.each([1, 4])('preserves BOM, CRLF and UTF-8 across %s-byte chunks', (width) => {
    const state = {
      origin: 'https://fixture.invalid',
      lastEventId: '',
      reconnectionTime: 0,
    };
    const events: StreamEvent[] = [];
    const parser = new NestedEventSourceStream({
      eventSourceSettings: state,
      push(event) {
        events.push(event);
        return true;
      },
    });
    const bytes = Buffer.from(
      '\uFEFFid: safe\r\nretry: 12\r\nevent: note\r\ndata: café\r\ndata: two\r\n\r\n'
    );
    let callbacks = 0;
    try {
      for (let i = 0; i < bytes.length; i += width) {
        parser._transform(bytes.subarray(i, i + width), 'buffer', () => callbacks++);
      }
      expect(callbacks).toBe(Math.ceil(bytes.length / width));
      expect(events).toEqual([
        {
          type: 'note',
          options: {
            data: 'café\ntwo',
            lastEventId: 'safe',
            origin: state.origin,
          },
        },
      ]);
      expect(state.reconnectionTime).toBe(12);
    } finally {
      parser.destroy();
    }
  });

  it('ignores invalid retry and null-containing ID fields', () => {
    const state = {
      origin: 'https://fixture.invalid',
      lastEventId: 'safe',
      reconnectionTime: 12,
    };
    const events: StreamEvent[] = [];
    const parser = new NestedEventSourceStream({
      eventSourceSettings: state,
      push(event) {
        events.push(event);
        return true;
      },
    });
    try {
      parser._transform(Buffer.from('id: bad\0id\nretry: 2x\ndata: ok\n\n'), 'buffer', () => {});
      expect(state).toEqual({
        origin: 'https://fixture.invalid',
        lastEventId: 'safe',
        reconnectionTime: 12,
      });
      expect(events[0]?.options.data).toBe('ok');
    } finally {
      parser.destroy();
    }
  });
});
