/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/* eslint-disable @typescript-eslint/require-await,
   @typescript-eslint/no-redundant-type-constituents,
   @typescript-eslint/no-unnecessary-type-assertion --
   in-memory client stubs match the async client surface without
   I/O; type-narrowing assertions exist for test-doc clarity. */

import { describe, expect, it } from 'vitest';

import type { BlackboardClient, BlackboardEntry } from '@kagent/blackboard';
import { RevisionMismatchError } from '@kagent/blackboard';
import type { ToolInvocationContext } from '@kagent/agent-loop';

import { defineBlackboardTools } from './builtin-tools.js';

const ctx: ToolInvocationContext = { abortSignal: new AbortController().signal };

/**
 * In-memory BlackboardClient with controllable behavior. Mirrors NATS
 * semantics tightly enough that the four tool wrappers' CAS / cap-gate
 * paths can be exercised without standing up NATS.
 */
function makeFakeClient(): BlackboardClient & {
  store: Map<string, BlackboardEntry>;
  forceConflictOnce: () => void;
} {
  const store = new Map<string, BlackboardEntry>();
  let nextRev = 1;
  let conflictPending = false;
  return {
    store,
    forceConflictOnce: (): void => {
      conflictPending = true;
    },
    async read(key) {
      return store.get(key) ?? null;
    },
    async put(key, value) {
      const rev = nextRev++;
      store.set(key, { value, revision: rev });
      return rev;
    },
    async create(key, value) {
      if (store.has(key)) {
        throw new RevisionMismatchError(key, undefined, store.get(key)?.revision);
      }
      const rev = nextRev++;
      store.set(key, { value, revision: rev });
      return rev;
    },
    async cas(key, value, expectedRev) {
      if (conflictPending) {
        conflictPending = false;
        const cur = store.get(key);
        throw new RevisionMismatchError(key, expectedRev, cur?.revision);
      }
      const cur = store.get(key);
      if (cur === undefined || cur.revision !== expectedRev) {
        throw new RevisionMismatchError(key, expectedRev, cur?.revision);
      }
      const rev = nextRev++;
      store.set(key, { value, revision: rev });
      return rev;
    },
    async list(prefix, _maxKeys) {
      const all = [...store.keys()];
      if (prefix === undefined) return all;
      return all.filter((k) => k.startsWith(prefix));
    },
  };
}

interface ToolDef {
  name: string;
  handler: (
    args: Record<string, unknown>,
    ctx: ToolInvocationContext,
  ) => Promise<unknown> | unknown;
}

function defsByName(client: BlackboardClient, claim?: unknown): Record<string, ToolDef> {
  const tools = defineBlackboardTools({
    client,
    ...(claim !== undefined && {
      claim: claim as Parameters<typeof defineBlackboardTools>[0]['claim'],
    }),
  });
  const out: Record<string, ToolDef> = {};
  for (const t of tools) {
    out[t.name] = { name: t.name, handler: t.handler as ToolDef['handler'] };
  }
  return out;
}

function parseJson(result: unknown): unknown {
  // Tools return either a string or [{type: 'text', text}].
  if (Array.isArray(result)) {
    const block = result[0] as { type?: string; text?: string };
    if (block?.type === 'text' && typeof block.text === 'string') {
      return JSON.parse(block.text) as unknown;
    }
  }
  if (typeof result === 'string') return JSON.parse(result);
  return result;
}

describe('defineBlackboardTools — registration', () => {
  it('returns exactly four tools with stable names', () => {
    const tools = defineBlackboardTools({ client: makeFakeClient() });
    expect(tools.map((t) => t.name).sort()).toEqual([
      'append_blackboard',
      'list_blackboard',
      'read_blackboard',
      'write_blackboard',
    ]);
  });
});

describe('read_blackboard', () => {
  it('refuses with policy_denied when no claim', async () => {
    const client = makeFakeClient();
    const tools = defsByName(client);
    await expect(tools.read_blackboard!.handler({ key: 'foo' }, ctx)).rejects.toThrow(
      /policy_denied/,
    );
  });

  it('refuses with policy_denied when key not in claim.read', async () => {
    const client = makeFakeClient();
    const tools = defsByName(client, { read: ['only-this'] });
    await expect(tools.read_blackboard!.handler({ key: 'other' }, ctx)).rejects.toThrow(
      /policy_denied/,
    );
  });

  it('returns null for absent key when admitted', async () => {
    const client = makeFakeClient();
    const tools = defsByName(client, { read: ['*'] });
    const res = parseJson(await tools.read_blackboard!.handler({ key: 'absent' }, ctx));
    expect(res).toBeNull();
  });

  it('returns the entry for a present key', async () => {
    const client = makeFakeClient();
    await client.put('k', 'v');
    const tools = defsByName(client, { read: ['*'] });
    const res = parseJson(await tools.read_blackboard!.handler({ key: 'k' }, ctx)) as {
      value: unknown;
    };
    expect(res.value).toBe('v');
  });

  it('refuses overlong keys', async () => {
    const tools = defsByName(makeFakeClient(), { read: ['*'] });
    const tooLong = 'x'.repeat(257);
    await expect(tools.read_blackboard!.handler({ key: tooLong }, ctx)).rejects.toThrow(/max 256/);
  });
});

describe('write_blackboard', () => {
  it('refuses with policy_denied when no claim', async () => {
    const tools = defsByName(makeFakeClient());
    await expect(tools.write_blackboard!.handler({ key: 'foo', value: 1 }, ctx)).rejects.toThrow(
      /policy_denied/,
    );
  });

  it('refuses when key not in claim.write', async () => {
    const tools = defsByName(makeFakeClient(), { write: ['only-this'] });
    await expect(tools.write_blackboard!.handler({ key: 'other', value: 1 }, ctx)).rejects.toThrow(
      /policy_denied/,
    );
  });

  it('writes when admitted', async () => {
    const client = makeFakeClient();
    const tools = defsByName(client, { write: ['*'] });
    const res = parseJson(
      await tools.write_blackboard!.handler({ key: 'k', value: { hello: 'world' } }, ctx),
    ) as { revision: number };
    expect(res.revision).toBeGreaterThan(0);
    expect(client.store.get('k')?.value).toEqual({ hello: 'world' });
  });

  it('refuses missing value', async () => {
    const tools = defsByName(makeFakeClient(), { write: ['*'] });
    await expect(tools.write_blackboard!.handler({ key: 'k' }, ctx)).rejects.toThrow(
      /value.*required/,
    );
  });
});

describe('list_blackboard', () => {
  it('refuses when read claim is empty', async () => {
    const tools = defsByName(makeFakeClient());
    await expect(tools.list_blackboard!.handler({}, ctx)).rejects.toThrow(/policy_denied/);
  });

  it('lists all keys when admitted', async () => {
    const client = makeFakeClient();
    await client.put('a', 1);
    await client.put('b', 2);
    const tools = defsByName(client, { read: ['*'] });
    const res = parseJson(await tools.list_blackboard!.handler({}, ctx)) as { keys: string[] };
    expect([...res.keys].sort()).toEqual(['a', 'b']);
  });

  it('filters by prefix', async () => {
    const client = makeFakeClient();
    await client.put('foo.1', 1);
    await client.put('foo.2', 2);
    await client.put('bar', 3);
    const tools = defsByName(client, { read: ['*'] });
    const res = parseJson(await tools.list_blackboard!.handler({ prefix: 'foo.' }, ctx)) as {
      keys: string[];
    };
    expect([...res.keys].sort()).toEqual(['foo.1', 'foo.2']);
  });
});

describe('append_blackboard', () => {
  it('refuses without read claim (read+write both required)', async () => {
    const tools = defsByName(makeFakeClient(), { write: ['*'] });
    await expect(tools.append_blackboard!.handler({ key: 'k', value: 1 }, ctx)).rejects.toThrow(
      /policy_denied/,
    );
  });

  it('refuses without write claim', async () => {
    const tools = defsByName(makeFakeClient(), { read: ['*'] });
    await expect(tools.append_blackboard!.handler({ key: 'k', value: 1 }, ctx)).rejects.toThrow(
      /policy_denied/,
    );
  });

  it('seeds an absent key with [value]', async () => {
    const client = makeFakeClient();
    const tools = defsByName(client, { read: ['*'], write: ['*'] });
    const res = parseJson(
      await tools.append_blackboard!.handler({ key: 'k', value: 'first' }, ctx),
    ) as { revision: number; length: number };
    expect(res.length).toBe(1);
    expect(client.store.get('k')?.value).toEqual(['first']);
  });

  it('appends to an existing array', async () => {
    const client = makeFakeClient();
    await client.put('k', ['a', 'b']);
    const tools = defsByName(client, { read: ['*'], write: ['*'] });
    const res = parseJson(
      await tools.append_blackboard!.handler({ key: 'k', value: 'c' }, ctx),
    ) as { length: number };
    expect(res.length).toBe(3);
    expect(client.store.get('k')?.value).toEqual(['a', 'b', 'c']);
  });

  it('refuses to coerce a non-array existing value', async () => {
    const client = makeFakeClient();
    await client.put('k', 'scalar-not-array');
    const tools = defsByName(client, { read: ['*'], write: ['*'] });
    await expect(tools.append_blackboard!.handler({ key: 'k', value: 'x' }, ctx)).rejects.toThrow(
      /not an array/,
    );
  });

  it('retries on revision conflict and converges', async () => {
    const client = makeFakeClient();
    await client.put('k', ['a']);
    client.forceConflictOnce();
    const tools = defsByName(client, { read: ['*'], write: ['*'] });
    const res = parseJson(
      await tools.append_blackboard!.handler({ key: 'k', value: 'b' }, ctx),
    ) as { length: number };
    expect(res.length).toBe(2);
    expect(client.store.get('k')?.value).toEqual(['a', 'b']);
  });

  it('three concurrent appends converge to length 3', async () => {
    // This exercises the CAS-loop's serial retry semantics — running
    // three appends sequentially against a fake client (the in-memory
    // fake serializes calls; real NATS would interleave but observe
    // the same final state).
    const client = makeFakeClient();
    const tools = defsByName(client, { read: ['*'], write: ['*'] });
    await tools.append_blackboard!.handler({ key: 'k', value: 1 }, ctx);
    await tools.append_blackboard!.handler({ key: 'k', value: 2 }, ctx);
    await tools.append_blackboard!.handler({ key: 'k', value: 3 }, ctx);
    expect(client.store.get('k')?.value).toEqual([1, 2, 3]);
  });
});
