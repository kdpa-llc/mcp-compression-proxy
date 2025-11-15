import { spawn, ChildProcess } from 'child_process';

/**
 * Ollama client for real LLM integration testing
 */
export class OllamaClient {
  private baseUrl: string;
  private model: string;

  constructor(
    baseUrl: string = 'http://localhost:11434',
    model: string = 'llama3.2:1b'
  ) {
    this.baseUrl = baseUrl;
    this.model = model;
  }

  /**
   * Check if Ollama is running
   */
  async isRunning(): Promise<boolean> {
    try {
      const response = await fetch(`${this.baseUrl}/api/tags`);
      return response.ok;
    } catch {
      return false;
    }
  }

  /**
   * Pull a model (if not already available)
   */
  async pullModel(): Promise<void> {
    const response = await fetch(`${this.baseUrl}/api/pull`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: this.model }),
    });

    if (!response.ok) {
      throw new Error(`Failed to pull model ${this.model}`);
    }

    // Wait for streaming response to complete
    const reader = response.body?.getReader();
    if (reader) {
      while (true) {
        const { done } = await reader.read();
        if (done) break;
      }
    }
  }

  /**
   * Generate a completion
   */
  async generate(prompt: string): Promise<string> {
    const response = await fetch(`${this.baseUrl}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: this.model,
        prompt,
        stream: false,
      }),
    });

    if (!response.ok) {
      throw new Error(`Ollama generate failed: ${response.statusText}`);
    }

    const data = await response.json() as { response: string };
    return data.response;
  }

  /**
   * Chat completion with structured output
   */
  async chat(systemPrompt: string, userMessage: string): Promise<string> {
    const response = await fetch(`${this.baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: this.model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userMessage },
        ],
        stream: false,
      }),
    });

    if (!response.ok) {
      throw new Error(`Ollama chat failed: ${response.statusText}`);
    }

    const data = await response.json() as { message: { content: string } };
    return data.message.content;
  }

  /**
   * Compress tool descriptions using LLM
   */
  async compressToolDescriptions(tools: Array<{
    serverName: string;
    toolName: string;
    description: string;
  }>): Promise<Array<{
    serverName: string;
    toolName: string;
    compressedDescription: string;
  }>> {
    const systemPrompt = `You are a tool description compression expert. Your task is to compress verbose tool descriptions into concise versions while preserving all critical information.

Rules:
1. Preserve key parameters and their types
2. Keep important constraints (file size limits, auth requirements, etc.)
3. Remove verbose explanations and marketing language
4. Use abbreviations where clear (e.g., "GH" for GitHub, "max" for maximum)
5. Maintain clarity - compression should not cause confusion

You MUST respond with ONLY a valid JSON array, no other text.`;

    const userMessage = `Compress these tool descriptions:

${JSON.stringify(tools, null, 2)}

Return ONLY a JSON array with this exact format:
[
  {
    "serverName": "string",
    "toolName": "string",
    "compressedDescription": "string"
  }
]`;

    const response = await this.chat(systemPrompt, userMessage);

    // Extract JSON from response (LLM might add extra text)
    const jsonMatch = response.match(/\[[\s\S]*\]/);
    if (!jsonMatch) {
      throw new Error(`Failed to extract JSON from LLM response: ${response}`);
    }

    return JSON.parse(jsonMatch[0]);
  }
}

/**
 * Start Ollama server process
 */
export function startOllama(): ChildProcess {
  const process = spawn('ollama', ['serve'], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  return process;
}

/**
 * Wait for Ollama to be ready
 */
export async function waitForOllama(
  maxWaitMs: number = 30000,
  checkIntervalMs: number = 1000
): Promise<void> {
  const client = new OllamaClient();
  const startTime = Date.now();

  while (Date.now() - startTime < maxWaitMs) {
    if (await client.isRunning()) {
      return;
    }
    await new Promise(resolve => setTimeout(resolve, checkIntervalMs));
  }

  throw new Error(`Ollama did not start within ${maxWaitMs}ms`);
}
