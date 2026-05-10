/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * Phase 2 / CC-02 — reload-stability test.
 *
 * Mounts CommandView with the captured cc-snapshot.json fixture,
 * captures BOTH a DOM snapshot (panels + overlays via stable
 * selectors, no raw HTML strings — CSS-module hashes invalidate
 * those) AND a scene-graph snapshot (computeLayout output, with
 * Maps serialized via Object.fromEntries — Maps don't JSON-
 * serialize per RESEARCH.md Pitfall 4 / Open Question 3),
 * unmounts, re-mounts a FRESH React root with the same fixture,
 * captures again, and asserts both snapshots are deep-equal.
 *
 * Date.now() is frozen via vi.useFakeTimers({ toFake: ['Date'] }) +
 * vi.setSystemTime so AgentPanel's failure counters and pressure.ts's
 * telemetry classification (now − lastEventAt > 30s) produce
 * deterministic results across the two mount cycles. setTimeout /
 * setInterval / microtasks remain REAL — fetch promises and
 * @testing-library/react's waitFor poller work without manual timer
 * advancing.
 *
 * Closed list of presentation-only state allowed to vary across
 * reloads (per CONTEXT.md D-CC-02-A — anything else differing
 * across reloads MUST fail this test):
 *   - camera (pan/zoom)             — RESET to centered HQ
 *   - selection.keys / selection.focus — RESET
 *   - hoveredAgentKey               — RESET
 *   - muted / thrumMuted / audioReady — RESET
 *   - bookmarks                     — RESET (no localStorage in v0.2)
 *   - controlGroups                 — RESET
 *   - popover (DispatchPopover)     — RESET
 *   - taskActionMenu                — RESET
 *   - alertText                     — RESET
 *   - hintsOpen                     — RESET (defaults to closed)
 *   - replay                        — RESET
 *   - Short-lived FX (TTL < 1s)     — RESET
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, waitFor } from '@testing-library/react';

import { CommandView } from '../CommandView.js';
import { computeLayout } from './layout.js';
import type { AgentNode, LayoutResult } from './layout.js';
import type { AgentSummaryRow, TaskSummary } from '../types.js';

import fixture from './__fixtures__/cc-snapshot.json' with { type: 'json' };

// Mock the SSE subscription so jsdom doesn't try to open EventSource.
// Returning a no-op cleanup matches the established Phase 1 state.test.ts
// pattern (the captured callback is never invoked, so lastEventAt stays
// at its frozen initial Date.now() value — telemetry pressure stays absent).
vi.mock('../api.js', async (importActual) => {
  const actual = await importActual<typeof import('../api.js')>();
  return {
    ...actual,
    subscribeCacheEvents: vi.fn(() => () => {
      /* no-op cleanup */
    }),
  };
});

/**
 * Build agentNodes from the fixture (mirrors the agentNodes useMemo
 * in CommandView.tsx) so we can call computeLayout directly without
 * poking layoutRef.current (which is React-internal and not exposed —
 * RESEARCH.md Pitfall 4). The fixture has zero orphan task→agent
 * references (every task.targetAgent is in agents) so this iteration
 * matches what the dev-build CommandView produces under the same
 * fixture without tripping the assertCanvasOrphan dev assertion.
 */
function agentNodesFromFixture(): AgentNode[] {
  const map = new Map<string, AgentNode>();
  for (const a of fixture.agents as AgentSummaryRow[]) {
    const key = `${a.namespace}/${a.name}`;
    map.set(key, {
      key,
      namespace: a.namespace,
      name: a.name,
      ...(a.model !== undefined && { model: a.model }),
      ...(a.modelClass !== undefined && { modelClass: a.modelClass }),
      ...(a.tools !== undefined && { tools: a.tools }),
    });
  }
  for (const t of fixture.tasks as TaskSummary[]) {
    if (t.targetAgent === undefined) continue;
    const key = `${t.namespace}/${t.targetAgent}`;
    if (!map.has(key)) {
      map.set(key, {
        key,
        namespace: t.namespace,
        name: t.targetAgent,
        ...(t.model !== undefined && { model: t.model }),
      });
    }
  }
  return Array.from(map.values());
}

/**
 * Convert LayoutResult to a JSON-serializable shape. LayoutResult.agents
 * and LayoutResult.factions are ReadonlyMap (per layout.ts L53–57); raw
 * JSON.stringify produces `{}` for the Map fields and breaks deep-equal.
 * Object.fromEntries gives a stable key-sorted object suitable for
 * toEqual + toMatchSnapshot per RESEARCH.md Open Question 3 / A2.
 */
function serializableLayout(layout: LayoutResult): unknown {
  return {
    gateway: layout.gateway,
    agents: Object.fromEntries(layout.agents),
    factions: Object.fromEntries(layout.factions),
  };
}

/**
 * Stable DOM selectors only — never raw HTML strings. CSS-module class
 * names carry build-time hash suffixes (per OpenCode LOW #8 documented
 * in DispositionOverlay.test.tsx Test 7) so innerHTML snapshots would
 * fail on every rebuild. We capture every source-bound element's
 * attributes + textContent, plus every anchor's href + text — that's
 * the surface CC-02 cares about (data binding + deep links), not chrome.
 */
function snapshotShape(container: HTMLElement): unknown {
  const sourceBound = Array.from(
    container.querySelectorAll('[data-source-field],[data-source-fields]'),
  ).map((el) => ({
    tag: el.tagName.toLowerCase(),
    singleField: el.getAttribute('data-source-field'),
    multiFields: el.getAttribute('data-source-fields'),
    text: el.textContent,
  }));
  const links = Array.from(container.querySelectorAll('a')).map((a) => ({
    href: a.getAttribute('href'),
    text: a.textContent,
  }));
  return { sourceBound, links };
}

/**
 * The fetch mock returns fixture data for every /api endpoint
 * useCommandSnapshot consumes. URL is matched by substring; response
 * envelopes mirror workbench-api's actual shapes:
 *   - /api/agents     → { items: AgentSummaryRow[] }       (per api.ts fetchAgents)
 *   - /api/tasks      → { items: TaskSummary[] }           (per api.ts fetchTasks)
 *   - /api/gateway/capacity → { rows, fetchedAt }          (per api.ts fetchGatewayCapacity)
 *   - /api/gateway/usage    → { rows: [], fetchedAt }      (fixture has no usage rows)
 *   - /api/dispositions → { items: DispositionOverlayRow[] } (per api.ts fetchDispositions)
 */
function urlOf(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.toString();
  // Request — has a `.url` string property; toString() on it would
  // produce "[object Request]" and trip eslint's no-base-to-string.
  return input.url;
}

function makeFetchMock(): ReturnType<typeof vi.spyOn> {
  return vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
    const url = urlOf(input);
    const fetchedAt = '2026-05-10T12:00:00Z';
    let body: unknown;
    if (url.includes('/api/gateway/capacity')) {
      body = { rows: fixture.gatewayCapacity, fetchedAt };
    } else if (url.includes('/api/gateway/usage')) {
      body = { rows: [], fetchedAt };
    } else if (url.includes('/api/dispositions')) {
      body = { items: fixture.dispositions };
    } else if (url.includes('/api/agents')) {
      body = { items: fixture.agents };
    } else if (url.includes('/api/tasks')) {
      body = { items: fixture.tasks };
    } else {
      body = {};
    }
    return Promise.resolve(
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
  });
}

describe('cc-reload (CC-02 — reload-stable rendering)', () => {
  beforeEach(() => {
    vi.stubEnv('NODE_ENV', 'development');
    // Fake ONLY Date so Date.now() is deterministic for AgentPanel
    // failure counters and pressure.ts telemetry classification.
    // setTimeout/setInterval/microtasks stay REAL so fetch promises
    // resolve and waitFor's poller works without manual timer advance.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-05-10T12:00:00Z'));
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('mount → unmount → fresh-remount with the same fixture: DOM and scene-graph snapshots are deep-equal', async () => {
    makeFetchMock();

    // First mount.
    const r1 = render(<CommandView onBack={() => {}} />);
    // Wait for hydration — the DispositionOverlay (over-budget marker
    // for researcher-01) and PressureOverlay both render source-bound
    // anchors after the initial fetches resolve.
    await waitFor(
      () => {
        expect(
          r1.container.querySelector('[data-source-field],[data-source-fields]'),
        ).not.toBeNull();
      },
      { timeout: 5000 },
    );

    const domSnap1 = snapshotShape(r1.container);
    const layoutSnap1 = serializableLayout(
      computeLayout(agentNodesFromFixture(), { width: 1280, height: 800 }),
    );

    r1.unmount();

    // Fresh remount — different React root, same fixture + frozen time.
    const r2 = render(<CommandView onBack={() => {}} />);
    await waitFor(
      () => {
        expect(
          r2.container.querySelector('[data-source-field],[data-source-fields]'),
        ).not.toBeNull();
      },
      { timeout: 5000 },
    );

    const domSnap2 = snapshotShape(r2.container);
    const layoutSnap2 = serializableLayout(
      computeLayout(agentNodesFromFixture(), { width: 1280, height: 800 }),
    );

    // Deep-equal across reloads is the CC-02 contract.
    expect(domSnap2).toEqual(domSnap1);
    expect(layoutSnap2).toEqual(layoutSnap1);

    // Persist canonical shape to git so future drift is loud.
    expect(domSnap2).toMatchSnapshot('dom');
    expect(layoutSnap2).toMatchSnapshot('layout');
  });
});
