import type { CompressorConfig } from '../config/schema.js';
import type { SamplingHost, SamplingResult } from './compression-sampler.js';

export const DEFAULT_COMPRESSOR_TIMEOUT_SECONDS = 120;

type FetchFn = (input: string, init: RequestInit) => Promise<Response>;

/**
 * A SamplingHost backed by an OpenAI-compatible chat completions endpoint.
 *
 * MCP sampling is deprecated in the 2026-07-28 specification and many clients
 * never offered it, which left compression to a manual round trip through the
 * agent. Any endpoint that speaks /chat/completions - Ollama, LM Studio, vLLM,
 * llama.cpp's server or a hosted API - can write the descriptions instead,
 * reusing the same prompt, batching and validation as sampling.
 */
export function openAiSamplingHost(config: CompressorConfig, fetchFn: FetchFn = fetch): SamplingHost {
  const endpoint = `${config.url.replace(/\/+$/, '')}/chat/completions`;
  const timeoutMs = (config.timeout ?? DEFAULT_COMPRESSOR_TIMEOUT_SECONDS) * 1000;

  return {
    getClientCapabilities: () => ({ sampling: {} }),

    async createMessage(params): Promise<SamplingResult> {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetchFn(endpoint, {
          method: 'POST',
          signal: controller.signal,
          headers: {
            'content-type': 'application/json',
            ...(config.apiKey ? { authorization: `Bearer ${config.apiKey}` } : {}),
            ...config.headers,
          },
          body: JSON.stringify({
            model: config.model,
            messages: [
              ...(params.systemPrompt ? [{ role: 'system', content: params.systemPrompt }] : []),
              ...params.messages.map((message) => ({
                role: message.role,
                content: message.content.text,
              })),
            ],
            max_tokens: params.maxTokens,
            temperature: 0,
          }),
        });

        const body = await response.text();
        if (!response.ok) {
          throw new Error(
            `Compressor endpoint returned ${response.status}: ${body.slice(0, 200)}`
          );
        }

        let text: unknown;
        try {
          text = (JSON.parse(body) as { choices?: Array<{ message?: { content?: unknown } }> })
            .choices?.[0]?.message?.content;
        } catch (error) {
          throw new Error('Compressor endpoint returned a non-JSON response', { cause: error });
        }
        if (typeof text !== 'string') {
          throw new Error('Compressor endpoint response had no message content');
        }
        return { content: { type: 'text', text } };
      } catch (error) {
        if ((error as { name?: string }).name === 'AbortError') {
          throw new Error(`Compressor endpoint timed out after ${timeoutMs / 1000}s`, {
            cause: error,
          });
        }
        throw error;
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
