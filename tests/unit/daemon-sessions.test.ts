import { describe, it, expect, jest, afterEach } from '@jest/globals';
import net from 'net';
import { PassThrough } from 'stream';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { attachToDaemon } from '../../src/daemon/bridge.js';
import { connectToDaemon } from '../../src/daemon/connect.js';
import { claimPidFile, launchDaemon } from '../../src/daemon/launcher.js';
import { ATTACH_PROTOCOL, isAttachRequest, readLine, stringEnv } from '../../src/daemon/protocol.js';
import { SessionHost } from '../../src/daemon/session-host.js';
import { StreamClientTransport } from '../helpers/stream-transport.js';
import { daemonFixture } from '../helpers/daemon-fixture.js';

const tick = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms));

function tempDir(): string {
  return realpathSync(mkdtempSync(join(tmpdir(), 'mcpd-')));
}

/** A fake daemon that answers each connection with `reply(firstLine, socket)`. */
async function fakeDaemon(socketPath: string, reply: (line: string, socket: net.Socket) => void) {
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    readLine(socket).then(
      ({ line }) => reply(line, socket),
      () => undefined
    );
  });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  return {
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  };
}

describe('attach protocol', () => {
  it('recognises an attach request', () => {
    const request = { type: 'attach', protocol: 1, version: '1', cwd: '/', env: {} };
    expect(isAttachRequest(request)).toBe(true);
    expect(isAttachRequest({ ...request, env: undefined })).toBe(false);
    expect(isAttachRequest({ ...request, type: 'call' })).toBe(false);
    expect(isAttachRequest({ id: '1', method: 'tools' })).toBe(false);
    expect(isAttachRequest(null)).toBe(false);
    expect(isAttachRequest('attach')).toBe(false);
  });

  it('keeps only string variables', () => {
    expect(stringEnv({ A: 'a', B: undefined })).toEqual({ A: 'a' });
  });

  describe('readLine', () => {
    it('returns the first line and what followed it, then stops reading', async () => {
      const stream = new PassThrough();
      const pending = readLine(stream);
      stream.write('{"a":');
      stream.write('1}\nrest');
      const { line, rest } = await pending;
      expect(line).toBe('{"a":1}');
      expect(rest.toString()).toBe('rest');
      expect(stream.isPaused()).toBe(true);
    });

    it('accepts string chunks', async () => {
      const stream = new PassThrough({ encoding: 'utf-8' });
      const pending = readLine(stream);
      stream.write('hello\n');
      expect((await pending).line).toBe('hello');
    });

    it('fails on an overlong line, an early end, an error or a timeout', async () => {
      const long = new PassThrough();
      const tooLong = readLine(long, { maxBytes: 4 });
      long.write('12345');
      await expect(tooLong).rejects.toThrow('exceeds 4 bytes');

      const ended = new PassThrough();
      const early = readLine(ended);
      ended.end('partial');
      await expect(early).rejects.toThrow('closed before a complete line');

      const broken = new PassThrough();
      const failed = readLine(broken);
      broken.destroy(new Error('reset'));
      await expect(failed).rejects.toThrow('reset');

      await expect(readLine(new PassThrough(), { timeoutMs: 10 })).rejects.toThrow('No reply within 10ms');
    });
  });
});

describe('attachToDaemon', () => {
  const dirs: string[] = [];
  const servers: Array<{ close: () => Promise<void> }> = [];
  afterEach(async () => {
    for (const server of servers.splice(0)) await server.close();
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function bridgeOptions(socketPath: string, overrides: Record<string, unknown> = {}) {
    return {
      socketPath,
      version: '1.0.0',
      cwd: '/work',
      env: { A: 'b' },
      input: new PassThrough(),
      output: new PassThrough(),
      ...overrides,
    };
  }

  async function daemonAt(reply: (line: string, socket: net.Socket) => void) {
    const dir = tempDir();
    dirs.push(dir);
    const socketPath = join(dir, 'd.sock');
    servers.push(await fakeDaemon(socketPath, reply));
    return socketPath;
  }

  it('reports a missing daemon', async () => {
    const dir = tempDir();
    dirs.push(dir);
    const result = await attachToDaemon(bridgeOptions(join(dir, 'none.sock')));
    expect(result).toMatchObject({ attached: false, reason: expect.stringContaining('ENOENT') });
  });

  it('sends the attach request and relays both ways once attached', async () => {
    let received: unknown;
    const socketPath = await daemonAt((line, socket) => {
      received = JSON.parse(line);
      socket.write('{"type":"attached","session":"s1"}\nearly');
      socket.on('data', (data) => socket.write(`echo:${data}`));
      socket.resume();
    });
    const options = bridgeOptions(socketPath);
    const output: string[] = [];
    options.output.on('data', (chunk: Buffer) => output.push(chunk.toString()));

    const result = await attachToDaemon(options);
    expect(result).toMatchObject({ attached: true, session: 's1' });
    expect(received).toEqual({ type: 'attach', protocol: ATTACH_PROTOCOL, version: '1.0.0', cwd: '/work', env: { A: 'b' } });

    options.input.write('ping');
    await tick();
    expect(output.join('')).toBe('earlyecho:ping');

    options.input.end();
    if (result.attached) await result.closed;
  });

  it('passes on a refusal, and rejects an unreadable reply or none in time', async () => {
    const refusing = await daemonAt((_line, socket) =>
      socket.end('{"type":"refused","code":"version-mismatch","message":"old","daemonVersion":"0.9","stopping":true}\n')
    );
    expect(await attachToDaemon(bridgeOptions(refusing))).toEqual({
      attached: false,
      reason: 'old',
      code: 'version-mismatch',
      stopping: true,
    });

    const garbled = await daemonAt((_line, socket) => socket.write('not json\n'));
    expect(await attachToDaemon(bridgeOptions(garbled))).toMatchObject({
      attached: false,
      reason: 'The daemon sent an unreadable reply',
    });

    const silent = await daemonAt(() => undefined);
    expect(await attachToDaemon(bridgeOptions(silent, { timeoutMs: 20 }))).toMatchObject({
      attached: false,
      reason: 'No reply within 20ms',
    });
  });
});

describe('connectToDaemon', () => {
  const dirs: string[] = [];
  const servers: Array<{ close: () => Promise<void> }> = [];
  afterEach(async () => {
    for (const server of servers.splice(0)) await server.close();
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function setup() {
    const dir = tempDir();
    dirs.push(dir);
    const socketPath = join(dir, 'd.sock');
    const accept = async () =>
      servers.push(
        await fakeDaemon(socketPath, (_line, socket) => socket.write('{"type":"attached","session":"s"}\n'))
      );
    const options = {
      socketPath,
      version: '1',
      cwd: '/',
      env: {},
      input: new PassThrough(),
      output: new PassThrough(),
    };
    return { socketPath, accept, options };
  }

  it('uses a running daemon without starting another', async () => {
    const { accept, options } = setup();
    await accept();
    const launch = jest.fn(async () => true);
    expect(await connectToDaemon({ ...options, launch })).toMatchObject({ attached: true });
    expect(launch).not.toHaveBeenCalled();
  });

  it('starts a daemon when none answers, and reports one that will not start', async () => {
    const { accept, options } = setup();
    const launch = jest.fn(async () => {
      await accept();
      return true;
    });
    expect(await connectToDaemon({ ...options, launch })).toMatchObject({ attached: true });
    expect(launch).toHaveBeenCalledTimes(1);

    const other = setup();
    expect(await connectToDaemon({ ...other.options, launch: async () => false })).toEqual({
      attached: false,
      reason: 'The daemon did not start; see its log',
    });
    expect(await connectToDaemon(other.options)).toMatchObject({ attached: false });
  });

  it('waits for a daemon making way for this version, then starts one', async () => {
    const { socketPath, options } = setup();
    let exiting: { close: () => Promise<void> } | undefined = await fakeDaemon(socketPath, (_line, socket) =>
      socket.end('{"type":"refused","code":"version-mismatch","message":"old","daemonVersion":"0","stopping":true}\n')
    );
    const running = jest.fn(async () => {
      await exiting?.close();
      exiting = undefined;
      return false;
    });
    const launch = jest.fn(async () => {
      servers.push(
        await fakeDaemon(socketPath, (_line, socket) => socket.write('{"type":"attached","session":"new"}\n'))
      );
      return true;
    });
    expect(await connectToDaemon({ ...options, launch, isRunning: running })).toMatchObject({
      attached: true,
      session: 'new',
    });
    expect(running).toHaveBeenCalled();
  });

  it('gives up on a daemon of another version that is still serving', async () => {
    const { socketPath, options } = setup();
    servers.push(
      await fakeDaemon(socketPath, (_line, socket) =>
        socket.end('{"type":"refused","code":"version-mismatch","message":"busy","daemonVersion":"0","stopping":false}\n')
      )
    );
    const launch = jest.fn(async () => true);
    expect(await connectToDaemon({ ...options, launch })).toMatchObject({ attached: false, reason: 'busy' });
    expect(launch).not.toHaveBeenCalled();
  });

  it('waits no longer than it was told for a daemon to exit', async () => {
    const { socketPath, options } = setup();
    servers.push(
      await fakeDaemon(socketPath, (_line, socket) =>
        socket.end('{"type":"refused","code":"version-mismatch","message":"old","daemonVersion":"0","stopping":true}\n')
      )
    );
    const started = Date.now();
    const result = await connectToDaemon({
      ...options,
      launch: async () => false,
      isRunning: async () => true,
      stopWaitMs: 150,
    });
    expect(result.attached).toBe(false);
    expect(Date.now() - started).toBeGreaterThanOrEqual(140);
  });
});

describe('daemon launcher', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it('claims the PID file once, and takes over one left by a dead daemon', () => {
    const dir = tempDir();
    dirs.push(dir);
    const pidFile = join(dir, 'daemon.pid');

    expect(claimPidFile(pidFile, process.pid)).toBe(true);
    expect(readFileSync(pidFile, 'utf-8')).toBe(String(process.pid));
    // The test process is alive, so another claimant is refused.
    expect(claimPidFile(pidFile, 1234567)).toBe(false);
    // Claiming again as the holder succeeds.
    expect(claimPidFile(pidFile, process.pid)).toBe(true);

    writeFileSync(pidFile, '2147483646');
    expect(claimPidFile(pidFile, 42)).toBe(true);
    writeFileSync(pidFile, 'garbage');
    expect(claimPidFile(pidFile, 43)).toBe(true);
    expect(readFileSync(pidFile, 'utf-8')).toBe('43');
  });

  it('treats a PID it may not signal as taken', () => {
    const dir = tempDir();
    dirs.push(dir);
    const pidFile = join(dir, 'daemon.pid');
    writeFileSync(pidFile, '777');
    const kill = jest.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('EPERM'), { code: 'EPERM' });
    });
    try {
      expect(claimPidFile(pidFile, 1)).toBe(false);
    } finally {
      kill.mockRestore();
    }
  });

  it('refuses nothing it cannot write, and rethrows why', () => {
    expect(() => claimPidFile(join(tmpdir(), 'no-such-dir-xyz', 'daemon.pid'))).toThrow('ENOENT');
  });

  it('gives up on a PID path it can neither read nor remove', () => {
    const dir = tempDir();
    dirs.push(dir);
    // A directory where the file should be: exclusive create says it exists,
    // reading it fails, and unlinking a directory fails too.
    const pidFile = join(dir, 'daemon.pid');
    mkdirSync(pidFile);
    expect(claimPidFile(pidFile, 5)).toBe(false);
  });

  it('starts a detached daemon and waits until it answers', async () => {
    const dir = tempDir();
    dirs.push(dir);
    const socketPath = join(dir, 'd.sock');
    const unref = jest.fn();
    let server: { close: () => Promise<void> } | undefined;
    const spawnFn = jest.fn((_command: string, _args: string[], _options: unknown) => {
      setTimeout(async () => {
        server = await fakeDaemon(socketPath, (line, socket) =>
          socket.write(JSON.stringify({ id: JSON.parse(line).id, result: { running: true } }) + '\n')
        );
      }, 50);
      return { unref } as never;
    });
    try {
      expect(await launchDaemon({ daemonScript: 'daemon.js', socketPath, spawnFn, env: { X: '1' } })).toBe(true);
      expect(spawnFn).toHaveBeenCalledWith(process.execPath, ['daemon.js'], {
        detached: true,
        stdio: 'ignore',
        env: { X: '1' },
      });
      expect(unref).toHaveBeenCalled();
    } finally {
      await server?.close();
    }

    expect(
      await launchDaemon({ daemonScript: 'daemon.js', socketPath: join(dir, 'never.sock'), spawnFn: () => ({ unref }) as never, timeoutMs: 200 })
    ).toBe(false);
  });
});

describe('SessionHost', () => {
  type Fixture = ReturnType<typeof daemonFixture>;
  let fixture: Fixture | undefined;
  const closers: Array<() => Promise<void> | void> = [];
  afterEach(async () => {
    for (const close of closers.splice(0).reverse()) await close();
    await fixture?.cleanup();
    fixture = undefined;
  });

  async function hostOn(onRetire = jest.fn()) {
    fixture = daemonFixture();
    const current = fixture;
    const host = new SessionHost({
      version: '1.0.0',
      pool: current.pool,
      models: current.models,
      services: current.services,
      onRetire,
    });
    const server = net.createServer((socket) => {
      readLine(socket).then(({ line, rest }) => host.attach(socket, JSON.parse(line), rest));
    });
    await new Promise<void>((resolve) => server.listen(current.socketPath, resolve));
    closers.push(async () => {
      await host.closeAll();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    });
    return { host, fixture: current, onRetire };
  }

  async function connect(fixture: Fixture, version = '1.0.0') {
    const toDaemon = new PassThrough();
    const fromDaemon = new PassThrough();
    const result = await attachToDaemon({
      socketPath: fixture.socketPath,
      version,
      cwd: fixture.project,
      env: fixture.env,
      input: toDaemon,
      output: fromDaemon,
    });
    if (!result.attached) return { result, client: undefined };
    const client = new Client({ name: 'test', version: '1.0.0' }, { capabilities: {} });
    await client.connect(new StreamClientTransport(fromDaemon, toDaemon));
    closers.push(() => client.close());
    return { result, client };
  }

  const pidOf = async (client: Client) =>
    ((await client.callTool({ name: 'mock__tool_000', arguments: { input: '@pid' } })) as CallToolResult).content
      .map((item) => (item.type === 'text' ? item.text : ''))
      .join('');

  it("serves each attached client from its project's config, sharing one backend process", async () => {
    const { host, fixture } = await hostOn();
    const a = await connect(fixture);
    const b = await connect(fixture);
    expect(a.result).toMatchObject({ attached: true });

    const tools = await a.client?.listTools();
    expect(tools?.tools.map((tool) => tool.name)).toContain('mock__tool_002');
    expect(await pidOf(a.client as Client)).toBe(await pidOf(b.client as Client));
    expect(host.size).toBe(2);
    expect(host.status()).toEqual([
      expect.objectContaining({ cwd: fixture.project }),
      expect.objectContaining({ cwd: fixture.project }),
    ]);
    expect(fixture.pool.statuses()).toEqual([expect.objectContaining({ holders: 2 })]);

    await a.client?.close();
    await tick(50);
    expect(host.size).toBe(1);
    expect(fixture.pool.statuses()).toEqual([expect.objectContaining({ holders: 1 })]);
  }, 20000);

  it('makes way for another version once its sessions end', async () => {
    const { host, fixture, onRetire } = await hostOn();
    const current = await connect(fixture);

    const newer = await connect(fixture, '2.0.0');
    expect(newer.result).toMatchObject({ attached: false, code: 'version-mismatch', stopping: false });
    const late = await connect(fixture);
    expect(late.result).toMatchObject({ attached: false, code: 'retiring' });
    expect(onRetire).not.toHaveBeenCalled();

    await current.client?.close();
    await tick(50);
    expect(host.size).toBe(0);
    expect(onRetire).toHaveBeenCalledTimes(1);
  }, 20000);

  it('exits at once for another version when no one is attached', async () => {
    const { fixture, onRetire } = await hostOn();
    const newer = await connect(fixture, '2.0.0');
    expect(newer.result).toMatchObject({ attached: false, stopping: true });
    expect(onRetire).toHaveBeenCalledTimes(1);
  });

  it('lets go of the backends of a client that leaves while they connect', async () => {
    fixture = daemonFixture();
    const host = new SessionHost({
      version: '1.0.0',
      pool: fixture.pool,
      models: fixture.models,
      services: fixture.services,
    });
    const socket = new PassThrough();
    const attaching = host.attach(socket, {
      type: 'attach',
      protocol: ATTACH_PROTOCOL,
      version: '1.0.0',
      cwd: fixture.project,
      env: fixture.env,
    });
    socket.destroy();
    await attaching;
    expect(host.size).toBe(0);
    expect(fixture.pool.statuses().every((status) => status.holders === 0)).toBe(true);
  }, 20000);
});
