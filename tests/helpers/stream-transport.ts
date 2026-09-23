import type { Readable, Writable } from 'stream';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { ReadBuffer, serializeMessage } from '@modelcontextprotocol/sdk/shared/stdio.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';

/**
 * An MCP client transport over any pair of streams, framed like stdio. Lets a
 * test speak MCP through a socket or a daemon bridge without a child process.
 */
export class StreamClientTransport implements Transport {
  onmessage?: (message: JSONRPCMessage) => void;
  onclose?: () => void;
  onerror?: (error: Error) => void;
  private readonly buffer = new ReadBuffer();
  private closed = false;

  constructor(
    private readonly input: Readable,
    private readonly output: Writable
  ) {}

  async start(): Promise<void> {
    this.input.on('data', (chunk: Buffer) => {
      this.buffer.append(chunk);
      let message: JSONRPCMessage | null;
      while ((message = this.buffer.readMessage()) !== null) {
        this.onmessage?.(message);
      }
    });
    this.input.on('close', () => this.close());
    this.input.on('error', (error) => this.onerror?.(error));
  }

  async send(message: JSONRPCMessage): Promise<void> {
    this.output.write(serializeMessage(message));
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.output.end();
    this.onclose?.();
  }
}
