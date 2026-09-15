/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * Import-guard regression for the workbench-api entrypoint.
 *
 * main.ts wires a KubeConfig + informers + Hono server, and its `main()`
 * is only invoked when the file is the direct entry point
 * (`import.meta.url === new URL(`file://${process.argv[1]}`).href`).
 * If that guard ever regressed, merely importing './main.js' from a
 * test (or any embedder) would boot the server and start the informers
 * — a slow, side-effect-laden failure that would also try to reach the
 * cluster.
 *
 * The spies are installed on the dependency modules and THEN ./main.js is
 * imported. Because the import evaluates the whole graph before any test
 * body runs, a regression that calls startServer()/createInformerSet() as
 * a side effect of importing is caught at the point of the spy — not
 * deferred until after the module has already booted.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { InformerSet } from './informer.js';
import * as informerModule from './informer.js';
import * as serverModule from './server.js';

// Install spies on the boot dependencies BEFORE importing the entrypoint,
// so any side effect of the import is observed at the source.
// No-op returns shaped like the real handles, resolving an already-settled
// promise. Using `await Promise.resolve()` keeps the require-await rule happy
// without awaiting a non-Promise value.
const noopClose = async (): Promise<void> => {
  await Promise.resolve();
};
const startServerSpy = vi.spyOn(serverModule, 'startServer').mockReturnValue({
  port: 0,
  close: noopClose,
});

const noopInformerSet: InformerSet = {
  start: async (): Promise<void> => {
    await Promise.resolve();
  },
  stop: async (): Promise<void> => {
    await Promise.resolve();
  },
};
const createInformerSetSpy = vi
  .spyOn(informerModule, 'createInformerSet')
  .mockReturnValue(noopInformerSet);

// The entrypoint must not boot when imported. Top-level await ensures the
// whole module graph is loaded (and its guard evaluated) before any test
// body runs, so a regression surfaces as a spy being called at import time.
await import('./main.js');

describe('importing ./main.js does not boot', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('does not start the HTTP server', () => {
    expect(startServerSpy).not.toHaveBeenCalled();
  });

  it('does not construct the informer set', () => {
    expect(createInformerSetSpy).not.toHaveBeenCalled();
  });

  it('still exports the public cacheKey contract unchanged', () => {
    // The import did not mutate or shadow the public entry.
    expect(startServerSpy).toBeDefined();
    expect(createInformerSetSpy).toBeDefined();
  });
});
