import { describe, it, expect, afterEach } from '@jest/globals';
import net from 'net';
import { join } from 'path';
import { tmpdir } from 'os';
import { unlinkSync, existsSync } from 'fs';
import { randomUUID } from 'crypto';
import { sendRequest, isDaemonRunning } from '../../src/cli/ipc-client.js';
import type { IPCRequest, IPCResponse } from '../../src/types/index.js';

describe('IPC Client', () => {
  const socketPath = join(tmpdir(), `mcp-test-${randomUUID()}.sock`);
  let server: net.Server | null = null;
  const activeSockets: net.Socket[] = [];

  afterEach(async () => {
    // Destroy all active sockets first so server.close() can complete
    for (const s of activeSockets) {
      s.destroy();
    }
    activeSockets.length = 0;

    if (server) {
      await new Promise<void>((resolve) => {
        server!.close(() => resolve());
      });
      server = null;
    }
    if (existsSync(socketPath)) {
      try { unlinkSync(socketPath); } catch { /* ignore */ }
    }
  });

  function createMockServer(handler: (req: IPCRequest) => IPCResponse): Promise<void> {
    return new Promise((resolve) => {
      server = net.createServer((socket) => {
        let buffer = '';
        socket.on('data', (data) => {
          buffer += data.toString();
          const newlineIndex = buffer.indexOf('\n');
          if (newlineIndex !== -1) {
            const line = buffer.slice(0, newlineIndex);
            buffer = buffer.slice(newlineIndex + 1);
            const request: IPCRequest = JSON.parse(line);
            const response = handler(request);
            socket.write(JSON.stringify(response) + '\n');
          }
        });
      });
      server!.listen(socketPath, () => resolve());
    });
  }

  describe('sendRequest', () => {
    it('should send a request and receive a response', async () => {
      await createMockServer((req) => ({
        id: req.id,
        result: { message: 'ok' },
      }));

      const response = await sendRequest(socketPath, 'tools');

      expect(response.result).toEqual({ message: 'ok' });
      expect(response.error).toBeUndefined();
    });

    it('should forward error responses', async () => {
      await createMockServer((req) => ({
        id: req.id,
        error: { code: -1, message: 'not found' },
      }));

      const response = await sendRequest(socketPath, 'info', { server: 'x', tool: 'y' });

      expect(response.error).toEqual({ code: -1, message: 'not found' });
    });

    it('should pass params to the server', async () => {
      let receivedParams: Record<string, unknown> | undefined;

      await createMockServer((req) => {
        receivedParams = req.params;
        return { id: req.id, result: 'ok' };
      });

      await sendRequest(socketPath, 'search', { query: 'file' });

      expect(receivedParams).toEqual({ query: 'file' });
    });

    it('should reject when daemon is not running', async () => {
      const badPath = join(tmpdir(), 'nonexistent.sock');

      await expect(sendRequest(badPath, 'tools', undefined, 1000))
        .rejects.toThrow('Daemon is not running');
    });

    it('should timeout on slow responses', async () => {
      // Server that never responds
      server = net.createServer((socket) => {
        activeSockets.push(socket);
        // Do nothing - don't respond
      });
      await new Promise<void>((resolve) => {
        server!.listen(socketPath, () => resolve());
      });

      await expect(sendRequest(socketPath, 'tools', undefined, 500))
        .rejects.toThrow('timed out');
    }, 10000);
  });

  describe('isDaemonRunning', () => {
    it('should return true when daemon is reachable', async () => {
      await createMockServer((req) => ({
        id: req.id,
        result: { running: true },
      }));

      const running = await isDaemonRunning(socketPath);
      expect(running).toBe(true);
    });

    it('should return false when daemon is not reachable', async () => {
      const badPath = join(tmpdir(), 'nonexistent.sock');
      const running = await isDaemonRunning(badPath);
      expect(running).toBe(false);
    });
  });
});
