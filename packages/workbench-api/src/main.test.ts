/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// resolvePort — fail-fast on invalid WORKBENCH_PORT
//
// resolvePort is loaded dynamically (not statically, see the side-effect
// suite below). Destructuring it from the dynamic import also gives it a
// real, checked type — the same approved pattern packages/agent-pod uses.
// ---------------------------------------------------------------------------

describe('resolvePort — fail-fast on invalid WORKBENCH_PORT', () => {
  it('accepts a valid integer within range', async () => {
    const { resolvePort } = await import('./main.js');
    expect(resolvePort('3000')).toEqual({ ok: true, port: 3000 });
  });

  it('fails fast when the env var is set but empty (unset → 8080, "" → error)', async () => {
    const { resolvePort } = await import('./main.js');
    // Unset (undefined) still means the documented default of 8080.
    expect(resolvePort(undefined)).toEqual({ ok: true, port: 8080 });
    // A set-but-empty value is an explicit misconfiguration; it must fail
    // fast with the same descriptive error as any other invalid value.
    const empty = resolvePort('');
    expect(empty.ok).toBe(false);
    if (!empty.ok) {
      expect(empty.error.message).toContain('WORKBENCH_PORT');
      // Point (e) of the ctkadvisors/kagent#55 review: `toContain('')` is a
      // vacuous assertion (every string contains the empty string). Assert the
      // exact quoted empty value instead — JSON.stringify('') === '""' — which
      // is the value rendered into the error message above.
      expect(empty.error.message).toContain('""');
      expect(empty.error.message).toContain(JSON.stringify(''));
    }
  });

  it('rejects a non-numeric value (the NaN case)', async () => {
    const { resolvePort } = await import('./main.js');
    const res = resolvePort('abc');
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toBeInstanceOf(Error);
      expect(res.error.message).toContain('WORKBENCH_PORT');
      expect(res.error.message).toContain('abc');
    }
  });

  it('rejects a float-looking value rather than letting parseInt silently truncate it', async () => {
    const { resolvePort } = await import('./main.js');
    expect(resolvePort('8080.5').ok).toBe(false);
  });

  it('rejects a value with surrounding whitespace or a sign', async () => {
    const { resolvePort } = await import('./main.js');
    expect(resolvePort(' 8080').ok).toBe(false);
    expect(resolvePort('+8080').ok).toBe(false);
  });

  it('rejects a zero port (below the valid range)', async () => {
    // 0 is a structurally valid integer but not a bindable port; it must be
    // rejected by the range check, not by the regex or the default path.
    const { resolvePort } = await import('./main.js');
    const res = resolvePort('0');
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.message).toContain('0');
    }
  });

  it('rejects a value above the valid range', async () => {
    const { resolvePort } = await import('./main.js');
    expect(resolvePort('70000').ok).toBe(false);
  });

  it('accepts the range boundaries 1 and 65535', async () => {
    const { resolvePort } = await import('./main.js');
    expect(resolvePort('1')).toEqual({ ok: true, port: 1 });
    expect(resolvePort('65535')).toEqual({ ok: true, port: 65535 });
  });

  it('uses a consistent message style across the invalid and out-of-range paths', async () => {
    const { resolvePort } = await import('./main.js');
    const invalid = resolvePort('abc');
    const oob = resolvePort('70000');
    if (!invalid.ok && !oob.ok) {
      // Both errors must be produced by the same style: quoted value via
      // JSON.stringify plus a shared "expected an integer…" clause.
      expect(invalid.error.message).toContain(JSON.stringify('abc'));
      expect(oob.error.message).toContain(JSON.stringify('70000'));
      expect(invalid.error.message).toContain('expected an integer in the range');
      expect(oob.error.message).toContain('expected an integer in the range');
    }
  });
});

// ---------------------------------------------------------------------------
// No side effects on import.
//
// Proves that loading ./main.js cannot execute main(), start the server, or
// start the informer. main() only runs under an explicit "direct invocation"
// guard on process.argv[1] + import.meta.url, which is never true from inside
// a vitest run. We therefore:
//   1. record the process listener counts for both SIGINT AND SIGTERM BEFORE
//      the very first dynamic import,
//   2. await that first import,
//   3. assert neither signal handler count changed (main() never ran), and
//   4. assert main() is not exported, so it cannot be invoked directly either.
//
// A fresh module graph (resetModules) isolates the second, "again" load so it
// is genuinely a re-import rather than a memoized module-object reuse.
//
// Point (c) of the ctkadvisors/kagent#55 review asked for the listener
// baseline to be captured BEFORE the first import of main.js, not after the
// string of dynamic imports that the resolvePort describe block above performs.
// We therefore capture the baseline once at test-module load (before the first
// dynamic import anywhere in this file) and assert it is unchanged everywhere.
// ---------------------------------------------------------------------------

// Signal-handler counts captured at test-module load, before the very first
// dynamic import of ./main.js anywhere in this file.
const SIGINT_BASELINE = process.listenerCount('SIGINT');
const SIGTERM_BASELINE = process.listenerCount('SIGTERM');

describe('importing main.js — no side effects on import', () => {
  afterEach(() => {
    vi.resetModules();
  });

  it('baseline signal-handler count is captured before the first import', () => {
    // This is the first test to run in the block, before any dynamic import
    // of main.js has been awaited. If the baseline were captured after an
    // import, main() would already have registered handlers and these would
    // fail — the whole suite hinges on this ordering.
    expect(process.listenerCount('SIGINT')).toBe(SIGINT_BASELINE);
    expect(process.listenerCount('SIGTERM')).toBe(SIGTERM_BASELINE);
  });

  it('records listeners, then a fresh dynamic import changes neither SIGINT nor SIGTERM', async () => {
    vi.resetModules();

    const sigintBefore = process.listenerCount('SIGINT');
    const sigtermBefore = process.listenerCount('SIGTERM');
    // The pre-import baseline is exactly what we measured at load time.
    expect(sigintBefore).toBe(SIGINT_BASELINE);
    expect(sigtermBefore).toBe(SIGTERM_BASELINE);

    // This is the FIRST dynamic import of ./main.js in a fresh module graph.
    // If main() ran on load it would register handlers via `process.on(...)`
    // for both signals, so either count must rise.
    const first = await import('./main.js');
    // resolvePort must be reachable through the dynamic import too.
    expect(typeof first.resolvePort).toBe('function');

    expect(process.listenerCount('SIGINT')).toBe(sigintBefore);
    expect(process.listenerCount('SIGTERM')).toBe(sigtermBefore);
  });

  it('does not attach listeners even when re-imported after resetModules', async () => {
    const sigintBefore = process.listenerCount('SIGINT');
    const sigtermBefore = process.listenerCount('SIGTERM');

    vi.resetModules();
    await import('./main.js');
    vi.resetModules();
    await import('./main.js');

    expect(process.listenerCount('SIGINT')).toBe(sigintBefore);
    expect(process.listenerCount('SIGTERM')).toBe(sigtermBefore);
  });

  it('does not start a server or informers on import — only resolvePort is exported', async () => {
    vi.resetModules();
    const mod = (await import('./main.js')) as Record<string, unknown>;

    // main() is deliberately not exported: only the pure guard is. Nothing
    // here can start the Hono server or the informer set without an explicit
    // direct invocation.
    expect(mod.resolvePort).toBeTypeOf('function');
    expect('main' in mod).toBe(false);
    // No other export should start with the boot verbs either.
    expect(Object.keys(mod).filter((k) => k.toLowerCase().startsWith('start'))).toEqual([]);
  });
});
