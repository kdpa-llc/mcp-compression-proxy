import { describe, it, expect, jest } from '@jest/globals';
import type { Logger } from 'pino';
import { openAiSamplingHost } from '../../src/services/openai-compressor.js';
import { CompressionSampler } from '../../src/services/compression-sampler.js';

type FetchFn = (input: string, init: RequestInit) => Promise<Response>;

function respond(status: number, body: unknown): Response {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
}

const params = {
  messages: [{ role: 'user' as const, content: { type: 'text' as const, text: 'Compress these' } }],
  maxTokens: 100,
  systemPrompt: 'You compress.',
};

describe('openAiSamplingHost', () => {
  it('posts a chat completion and returns the message text', async () => {
    const fetchFn = jest.fn<FetchFn>(async () =>
      respond(200, { choices: [{ message: { content: 'short' } }] })
    );
    const host = openAiSamplingHost(
      { url: 'http://localhost:11434/v1/', model: 'llama3.2', apiKey: 'k', headers: { 'x-extra': '1' } },
      fetchFn
    );

    expect(host.getClientCapabilities()).toEqual({ sampling: {} });
    await expect(host.createMessage(params)).resolves.toEqual({
      content: { type: 'text', text: 'short' },
    });

    const [url, init] = fetchFn.mock.calls[0];
    expect(url).toBe('http://localhost:11434/v1/chat/completions');
    expect(init.headers).toMatchObject({ authorization: 'Bearer k', 'x-extra': '1' });
    expect(JSON.parse(String(init.body))).toEqual({
      model: 'llama3.2',
      messages: [
        { role: 'system', content: 'You compress.' },
        { role: 'user', content: 'Compress these' },
      ],
      max_tokens: 100,
      temperature: 0,
    });
  });

  it('omits the authorization header and system message when not given', async () => {
    const fetchFn = jest.fn<FetchFn>(async () =>
      respond(200, { choices: [{ message: { content: 'x' } }] })
    );
    await openAiSamplingHost({ url: 'http://h/v1', model: 'm' }, fetchFn).createMessage({
      ...params,
      systemPrompt: undefined,
    });

    const init = fetchFn.mock.calls[0][1];
    expect(init.headers).not.toHaveProperty('authorization');
    expect(JSON.parse(String(init.body)).messages).toHaveLength(1);
  });

  it.each([
    [respond(401, 'bad key'), 'returned 401: bad key'],
    [respond(200, 'not json'), 'non-JSON response'],
    [respond(200, { choices: [] }), 'no message content'],
  ])('reports a bad response clearly', async (response, message) => {
    const host = openAiSamplingHost({ url: 'http://h', model: 'm' }, async () => response);
    await expect(host.createMessage(params)).rejects.toThrow(message);
  });

  it('times out a request that never answers', async () => {
    const fetchFn: FetchFn = (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => {
          const error = new Error('aborted');
          error.name = 'AbortError';
          reject(error);
        });
      });
    const host = openAiSamplingHost({ url: 'http://h', model: 'm', timeout: 0.05 }, fetchFn);
    await expect(host.createMessage(params)).rejects.toThrow('timed out after 0.05s');
  });

  it('drives the existing compression sampler end to end', async () => {
    const fetchFn = jest.fn<FetchFn>(async () =>
      respond(200, {
        choices: [
          {
            message: {
              content: '[{"serverName":"fs","toolName":"read_file","description":"Read a file."}]',
            },
          },
        ],
      })
    );
    const logger = { debug: jest.fn(), warn: jest.fn() } as unknown as Logger;
    const sampler = new CompressionSampler(logger, openAiSamplingHost({ url: 'http://h', model: 'm' }, fetchFn));

    const result = await sampler.compress([
      { serverName: 'fs', toolName: 'read_file', description: 'Read the complete contents of a file.' },
    ]);

    expect(result.descriptions).toEqual([
      { serverName: 'fs', toolName: 'read_file', description: 'Read a file.' },
    ]);
  });
});
