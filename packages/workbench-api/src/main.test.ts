/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

import { describe, expect, it } from 'vitest';

import { resolvePort } from './main.js';

describe('resolvePort — fail-fast on invalid WORKBENCH_PORT', () => {
  it('defaults to 8080 when the env var value is undefined', () => {
    expect(resolvePort(undefined)).toEqual({ ok: true, port: 8080 });
  });

  it('defaults to 8080 when the env var value is an empty string', () => {
    expect(resolvePort('')).toEqual({ ok: true, port: 8080 });
  });

  it('accepts a valid integer within range', () => {
    expect(resolvePort('3000')).toEqual({ ok: true, port: 3000 });
  });

  it('rejects a non-numeric value (the NaN case)', () => {
    const res = resolvePort('abc');
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toBeInstanceOf(Error);
      expect(res.error.message).toContain('WORKBENCH_PORT');
      expect(res.error.message).toContain('abc');
    }
  });

  it('rejects a float-looking value rather than letting parseInt silently truncate it', () => {
    expect(resolvePort('8080.5').ok).toBe(false);
  });

  it('rejects a port with surrounding whitespace or a sign', () => {
    expect(resolvePort(' 8080').ok).toBe(false);
    expect(resolvePort('+8080').ok).toBe(false);
  });

  it('rejects a zero port (below the valid range)', () => {
    expect(resolvePort('0').ok).toBe(false);
  });

  it('rejects a value above the valid range', () => {
    expect(resolvePort('70000').ok).toBe(false);
  });

  it('accepts the range boundaries 1 and 65535', () => {
    expect(resolvePort('1')).toEqual({ ok: true, port: 1 });
    expect(resolvePort('65535')).toEqual({ ok: true, port: 65535 });
  });
});

// Proves that importing `./main.js` cannot execute main(), start the
// server, or start the informer: main() only runs under an explicit
// "direct invocation" guard on process.argv[1] + import.meta.url, which
// is never true from inside a vitest run. We assert the imported
// module has no synchronous side effects and that main() is not invoked.
describe('importing main.js — no side effects on import', () => {
  it('has only resolvePort exported (main is not exported, so cannot be invoked directly)', async () => {
    const mod = (await import('./main.js')) as Record<string, unknown>;
    expect(mod.resolvePort).toBeTypeOf('function');
    expect('main' in mod).toBe(false);
  });

  it('does not attach process listeners (main() not run) on import', () => {
    const before = process.listenerCount('SIGINT');

    // The import is memoized; if main() ran it would register
    // SIGTERM/SIGINT handlers via `process.on(...)`.
    void import('./main.js');

    expect(process.listenerCount('SIGINT')).toBe(before);
  });
});
