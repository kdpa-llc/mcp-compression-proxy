import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import type { Logger } from 'pino';
import {
  CompressionSampler,
  type SamplingHost,
  type SamplingResult,
} from '../../src/services/compression-sampler.js';
import type { ObservedTool } from '../../src/services/stats-service.js';

/**
 * Host-side compression via MCP sampling (#22).
 */
describe('CompressionSampler', () => {
  let logger: Logger;
  let createMessage: jest.Mock<(params: unknown) => Promise<SamplingResult>>;
  let capabilities: { sampling?: unknown } | undefined;

  const tools: ObservedTool[] = [
    { serverName: 'fs', toolName: 'read', description: 'A very long description of read' },
    { serverName: 'fs', toolName: 'write', description: 'A very long description of write' },
  ];

  /** A reply shaped the way a well-behaved host returns it. */
  const replyWith = (text: string): SamplingResult => ({ content: { type: 'text', text } });

  function makeSampler(batchSize?: number): CompressionSampler {
    const host: SamplingHost = {
      getClientCapabilities: () => capabilities,
      createMessage: createMessage as unknown as SamplingHost['createMessage'],
    };
    return new CompressionSampler(logger, host, batchSize);
  }

  beforeEach(() => {
    logger = {
      debug: jest.fn(),
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    } as unknown as Logger;

    createMessage = jest.fn<(params: unknown) => Promise<SamplingResult>>();
    capabilities = { sampling: {} };
  });

  describe('isSupported', () => {
    it('is true when the client advertises sampling', () => {
      expect(makeSampler().isSupported()).toBe(true);
    });

    it('is false when the client does not', () => {
      capabilities = {};
      expect(makeSampler().isSupported()).toBe(false);
    });

    it('is false before a client has connected', () => {
      capabilities = undefined;
      expect(makeSampler().isSupported()).toBe(false);
    });

    it('is false rather than throwing when the host errors', () => {
      const host: SamplingHost = {
        getClientCapabilities: () => {
          throw new Error('not connected');
        },
        createMessage: createMessage as unknown as SamplingHost['createMessage'],
      };

      expect(new CompressionSampler(logger, host).isSupported()).toBe(false);
    });
  });

  describe('compress', () => {
    it('returns compressed descriptions from a clean reply', async () => {
      createMessage.mockResolvedValue(
        replyWith(
          JSON.stringify([
            { serverName: 'fs', toolName: 'read', description: 'Read a file' },
            { serverName: 'fs', toolName: 'write', description: 'Write a file' },
          ])
        )
      );

      const result = await makeSampler().compress(tools);

      expect(result.descriptions).toEqual([
        { serverName: 'fs', toolName: 'read', description: 'Read a file' },
        { serverName: 'fs', toolName: 'write', description: 'Write a file' },
      ]);
      expect(result.batchesFailed).toBe(0);
    });

    it('does nothing and makes no request for an empty list', async () => {
      const result = await makeSampler().compress([]);

      expect(result.descriptions).toEqual([]);
      expect(result.batchesAttempted).toBe(0);
      expect(createMessage).not.toHaveBeenCalled();
    });

    it('sends the original descriptions and a system prompt', async () => {
      createMessage.mockResolvedValue(replyWith('[]'));

      await makeSampler().compress(tools);

      const params = createMessage.mock.calls[0][0] as {
        messages: Array<{ content: { text: string } }>;
        systemPrompt: string;
        maxTokens: number;
      };

      expect(params.messages[0].content.text).toContain('A very long description of read');
      expect(params.systemPrompt).toContain('JSON array');
      expect(params.maxTokens).toBeGreaterThan(0);
    });

    it('splits large sets into batches', async () => {
      createMessage.mockResolvedValue(replyWith('[]'));

      const many: ObservedTool[] = Array.from({ length: 7 }, (_, i) => ({
        serverName: 'srv',
        toolName: `tool${i}`,
        description: 'x',
      }));

      const result = await makeSampler(3).compress(many);

      expect(result.batchesAttempted).toBe(3);
      expect(createMessage).toHaveBeenCalledTimes(3);
    });

    it('keeps earlier results when a later batch is rejected', async () => {
      createMessage
        .mockResolvedValueOnce(
          replyWith(JSON.stringify([{ serverName: 'fs', toolName: 'read', description: 'Read' }]))
        )
        .mockRejectedValueOnce(new Error('User rejected sampling request'));

      const result = await makeSampler(1).compress(tools);

      expect(result.descriptions).toHaveLength(1);
      expect(result.batchesFailed).toBe(1);
      expect(result.batchesAttempted).toBe(2);
    });

    describe('reply parsing', () => {
      const single = [tools[0]];

      it('finds the array inside surrounding prose', async () => {
        createMessage.mockResolvedValue(
          replyWith(
            'Sure! Here you go:\n```json\n[{"serverName":"fs","toolName":"read","description":"Read"}]\n```\nHope that helps.'
          )
        );

        const result = await makeSampler().compress(single);

        expect(result.descriptions).toEqual([
          { serverName: 'fs', toolName: 'read', description: 'Read' },
        ]);
      });

      it('joins a multi-part content array', async () => {
        createMessage.mockResolvedValue({
          content: [
            { type: 'text', text: '[{"serverName":"fs","toolName":"read",' },
            { type: 'text', text: '"description":"Read"}]' },
          ],
        });

        const result = await makeSampler().compress(single);

        expect(result.descriptions).toHaveLength(1);
      });

      it('drops tools that were never requested', async () => {
        createMessage.mockResolvedValue(
          replyWith(
            JSON.stringify([
              { serverName: 'fs', toolName: 'read', description: 'Read' },
              { serverName: 'evil', toolName: 'invented', description: 'Hallucinated' },
            ])
          )
        );

        const result = await makeSampler().compress(single);

        // A hallucinated name would otherwise be cached and shown to the model.
        expect(result.descriptions).toEqual([
          { serverName: 'fs', toolName: 'read', description: 'Read' },
        ]);
        expect(logger.warn).toHaveBeenCalled();
      });

      it.each([
        ['not JSON at all', 'I cannot do that'],
        ['a malformed array', '[{"serverName":'],
        ['a JSON object rather than an array', '{"serverName":"fs"}'],
      ])('treats %s as a failed batch', async (_label, reply) => {
        createMessage.mockResolvedValue(replyWith(reply));

        const result = await makeSampler().compress(single);

        expect(result.descriptions).toEqual([]);
        expect(result.batchesFailed).toBe(1);
      });

      it.each([
        ['a missing description', { serverName: 'fs', toolName: 'read' }],
        ['an empty description', { serverName: 'fs', toolName: 'read', description: '   ' }],
        ['a non-string description', { serverName: 'fs', toolName: 'read', description: 42 }],
      ])('skips an entry with %s', async (_label, entry) => {
        createMessage.mockResolvedValue(replyWith(JSON.stringify([entry])));

        const result = await makeSampler().compress(single);

        expect(result.descriptions).toEqual([]);
      });

      it('trims whitespace from returned descriptions', async () => {
        createMessage.mockResolvedValue(
          replyWith(
            JSON.stringify([{ serverName: 'fs', toolName: 'read', description: '  Read a file \n' }])
          )
        );

        const result = await makeSampler().compress(single);

        expect(result.descriptions[0].description).toBe('Read a file');
      });

      it('handles an empty content payload', async () => {
        createMessage.mockResolvedValue({});

        const result = await makeSampler().compress(single);

        expect(result.descriptions).toEqual([]);
        expect(result.batchesFailed).toBe(1);
      });
    });
  });
});
