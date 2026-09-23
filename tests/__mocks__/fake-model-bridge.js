#!/usr/bin/env node

/**
 * Stand-in for python/needle_bridge.py that speaks the same JSON-lines
 * protocol, so the bridge client and every model-backed feature can be tested
 * without Python or model weights.
 *
 * Behaviour is deterministic:
 * - embed: bag-of-words hashed into 64 dims, so texts sharing words are close
 * - select: the first tool whose name words all appear in the query, with
 *   arguments filled from `key=value` pairs in the query
 * - extract: each schema property filled from a `property: value` line
 *
 * FAKE_BRIDGE_MODE switches in failure modes: fatal, crash-on-request,
 * silent (never answers), slow-start.
 */

import { createInterface } from 'readline';

const mode = process.env.FAKE_BRIDGE_MODE ?? '';
const DIM = 64;

function send(message) {
  process.stdout.write(JSON.stringify(message) + '\n');
}

function words(text) {
  return String(text)
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length > 2);
}

function hash(word) {
  let value = 2166136261;
  for (const char of word) {
    value = Math.imul(value ^ char.charCodeAt(0), 16777619) >>> 0;
  }
  return value % DIM;
}

function embed(text) {
  const vector = new Float32Array(DIM);
  for (const word of words(text)) vector[hash(word)] += 1;
  vector[DIM - 1] += 0.5; // shared component, like a real model's mean direction
  return Buffer.from(vector.buffer).toString('base64');
}

function argumentsFrom(text) {
  const args = {};
  for (const match of String(text).matchAll(/(\w+)=("[^"]*"|\S+)/g)) {
    args[match[1]] = match[2].replace(/^"|"$/g, '');
  }
  return args;
}

function handle(method, params) {
  if (method === 'ping') return { model: 'fake' };
  if (method === 'embed') {
    return { dim: DIM, vectors: params.texts.map(embed) };
  }
  if (method === 'select') {
    const query = new Set(words(params.query));
    const tool = params.tools.find((candidate) =>
      words(candidate.name.replace(/__/g, ' ')).every((word) => query.has(word))
    );
    return tool
      ? {
          calls: [{ name: tool.name, arguments: argumentsFrom(params.query) }],
          suppressed: [],
          confidence: 0.93,
          reasoning: `matched ${tool.name}`,
          ungrounded: [],
        }
      : { calls: [], suppressed: [], confidence: 0.2, ungrounded: [] };
  }
  if (method === 'extract') {
    const properties = params.schema.parameters?.properties ?? {};
    const value = {};
    for (const [name, spec] of Object.entries(properties)) {
      const match = String(params.text).match(new RegExp(`${name}:\\s*([^\\n,]+)`, 'i'));
      if (!match) continue;
      const raw = match[1].trim();
      value[name] = spec.type === 'integer' || spec.type === 'number' ? Number(raw) : raw;
    }
    const found = Object.keys(value).length > 0;
    return {
      calls: found ? [{ name: params.schema.name, arguments: value }] : [],
      suppressed: [],
      confidence: found ? 0.8 : 0.1,
      ungrounded: [],
      value: found ? value : null,
      withheld: false,
    };
  }
  throw new Error(`unknown method: ${method}`);
}

async function main() {
  if (mode === 'fatal') {
    send({ fatal: 'cannot import needle (fake)' });
    process.exit(1);
  }
  if (mode === 'slow-start') {
    await new Promise((resolve) => setTimeout(resolve, 60_000));
  }
  process.stderr.write('fake bridge starting\n');
  process.stdout.write('not json, ignored\n');
  send({ ready: true, model: 'fake' });

  const lines = createInterface({ input: process.stdin });
  lines.on('line', (line) => {
    if (!line.trim()) return;
    const request = JSON.parse(line);
    if (mode === 'crash-on-request') process.exit(3);
    if (mode === 'silent') return;
    try {
      send({ id: request.id, result: handle(request.method, request.params ?? {}) });
    } catch (error) {
      send({ id: request.id, error: { message: error.message } });
    }
  });
}

main();
