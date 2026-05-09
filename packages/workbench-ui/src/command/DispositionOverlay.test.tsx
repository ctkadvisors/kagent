/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * Phase 1 / DISP-04 — DispositionOverlay component tests.
 *
 * 12 tests cover:
 *   1. In-budget rendering (tokens remaining as a multi-field bind)
 *   2. Over-budget tokens (pressure marker present)
 *   3. Over-budget proposals
 *   4. Over-budget both (two markers)
 *   5. Base-building-only mode (no dramatic class; data still legible)
 *   6. Empty state (returns null)
 *   7. Reload stability (re-render with same snapshot → equal selector tree)
 *   8. Dev-mode source-binding assertion fires on synthesized orphan
 *   9. postsToday NOT surfaced (Future Research per REQUIREMENTS.md §4)
 *  10. Detail link target — existing route /agents/:ns/:name
 *  11. overBudgetEventCountToday rendered (Codex HIGH #4 / ROADMAP S.C.4)
 *  12. count is suppressed when overBudget is false
 *
 * Reload-stability test deliberately uses STABLE SELECTORS (data-source-
 * field(s) attributes + data-agent-ref + textContent) instead of raw
 * HTML-string snapshots per OpenCode LOW #8 — CSS-module class names
 * carry per-build hash suffixes and would cause spurious failures.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { DispositionOverlayRow } from '@kagent/dto/disposition';

import { DispositionOverlay } from './DispositionOverlay.js';

function makeRow(overrides: Partial<DispositionOverlayRow> = {}): DispositionOverlayRow {
  return {
    agentRef: 'kagent-system/researcher-01',
    namespace: 'kagent-system',
    agentName: 'researcher-01',
    configMapName: 'researcher-01-disposition',
    idleBehavior: {
      readChannels: [],
      attentionBudget: { tokensPerDay: 50_000, pollIntervalSeconds: 300 },
      proposalScope: { mayProposeAgainst: ['templates'], maxProposalsPerDay: 3 },
    },
    spentTokensToday: 45_000,
    postsToday: 0,
    proposalsToday: 1,
    overBudget: false,
    overBudgetEventCountToday: 0,
    dailyBoundaryUtc: '2026-05-09T00:00:00.000Z',
    ...overrides,
  };
}

function makeSnapshot(
  rows: DispositionOverlayRow[],
): { dispositions: ReadonlyMap<string, DispositionOverlayRow> } {
  return {
    dispositions: new Map(rows.map((r) => [r.agentRef, r])),
  };
}

describe('DispositionOverlay (DISP-04)', () => {
  beforeEach(() => {
    // Default: dev — assertion fires.
    vi.stubEnv('NODE_ENV', 'development');
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('Test 1 — in-budget rendering shows tokens remaining; tokens marker carries multi-field source-fields attribute', () => {
    const snapshot = makeSnapshot([makeRow()]);
    const { container } = render(<DispositionOverlay snapshot={snapshot} />);

    // "5,000 remaining" — 50,000 cap minus 45,000 spent.
    expect(screen.getByText(/5,000 remaining/)).toBeTruthy();
    // No over-budget marker.
    expect(screen.queryByText(/over budget/i)).toBeNull();
    // Tokens block carries the multi-field source-fields attribute
    // (Codex HIGH #5: computed value lists ALL inputs).
    const tokensBlock = container.querySelector(
      '[data-source-fields="spentTokensToday,idleBehavior"]',
    );
    expect(tokensBlock).not.toBeNull();
  });

  it('Test 2 — over-budget tokens renders pressure marker with multi-field attribute', () => {
    const snapshot = makeSnapshot([
      makeRow({
        spentTokensToday: 55_000,
        overBudget: true,
        overBudgetReason: 'tokens_exceeded',
        overBudgetEventCountToday: 1,
      }),
    ]);
    const { container } = render(<DispositionOverlay snapshot={snapshot} />);

    // The "+5,000 over budget" delta is rendered.
    expect(screen.getByText(/\+5,000 over budget/)).toBeTruthy();
    // Pressure marker (anchor) is present and carries the multi-field
    // source-fields attribute.
    const markers = container.querySelectorAll(
      'a[data-source-fields="spentTokensToday,idleBehavior"]',
    );
    expect(markers.length).toBeGreaterThanOrEqual(1);
  });

  it('Test 3 — over-budget proposals renders pressure marker with proposals,idleBehavior attribute', () => {
    const snapshot = makeSnapshot([
      makeRow({
        proposalsToday: 5,
        overBudget: true,
        overBudgetReason: 'proposals_exceeded',
        overBudgetEventCountToday: 1,
      }),
    ]);
    const { container } = render(<DispositionOverlay snapshot={snapshot} />);

    // 5 proposals minus cap=3 = +2 over budget.
    expect(screen.getByText(/\+2 over budget/)).toBeTruthy();
    const markers = container.querySelectorAll(
      'a[data-source-fields="proposalsToday,idleBehavior"]',
    );
    expect(markers.length).toBeGreaterThanOrEqual(1);
  });

  it("Test 4 — over-budget both reason renders TWO markers, one per source-field group", () => {
    const snapshot = makeSnapshot([
      makeRow({
        spentTokensToday: 55_000,
        proposalsToday: 5,
        overBudget: true,
        overBudgetReason: 'both',
        overBudgetEventCountToday: 2,
      }),
    ]);
    const { container } = render(<DispositionOverlay snapshot={snapshot} />);

    const tokensMarker = container.querySelectorAll(
      'a[data-source-fields="spentTokensToday,idleBehavior"]',
    );
    const proposalsMarker = container.querySelectorAll(
      'a[data-source-fields="proposalsToday,idleBehavior"]',
    );
    expect(tokensMarker.length).toBeGreaterThanOrEqual(1);
    expect(proposalsMarker.length).toBeGreaterThanOrEqual(1);
  });

  it('Test 5 — base-building-only mode keeps numeric data; dramatic class is NOT applied', () => {
    const snapshot = makeSnapshot([
      makeRow({
        spentTokensToday: 55_000,
        overBudget: true,
        overBudgetReason: 'tokens_exceeded',
        overBudgetEventCountToday: 1,
      }),
    ]);
    const { container } = render(
      <DispositionOverlay snapshot={snapshot} pressureDramatization={false} />,
    );

    // Numeric delta still legible — at least one element carries the
    // delta text. (Multiple ancestors may match the regex; we just
    // assert presence, not uniqueness.)
    expect(screen.getAllByText(/\+5,000 over budget/).length).toBeGreaterThanOrEqual(1);
    // The marker exists but uses the subdued class. We can't assert
    // exact class name (CSS-module hash), so we assert that NO element
    // carries a class with substring "pressureDramatic" — the dramatic
    // pathway must not have rendered.
    const allElements = container.querySelectorAll('*');
    let dramaticPresent = false;
    allElements.forEach((el) => {
      const cls = el.getAttribute('class') ?? '';
      if (cls.includes('pressureDramatic')) dramaticPresent = true;
    });
    expect(dramaticPresent).toBe(false);
    // And the source-fields attribute is still present (data binding
    // survives the visual swap).
    const markers = container.querySelectorAll(
      '[data-source-fields="spentTokensToday,idleBehavior"]',
    );
    expect(markers.length).toBeGreaterThanOrEqual(1);
  });

  it('Test 6 — empty state returns null (no rows rendered)', () => {
    const snapshot = makeSnapshot([]);
    const { container } = render(<DispositionOverlay snapshot={snapshot} />);
    expect(container.firstChild).toBeNull();
  });

  it('Test 7 — reload stability: re-render with same snapshot produces equal selector tree (no innerHTML; OpenCode LOW #8)', () => {
    const snapshot = makeSnapshot([
      makeRow(),
      makeRow({
        agentRef: 'kagent-system/curator-02',
        agentName: 'curator-02',
        configMapName: 'curator-02-disposition',
      }),
    ]);

    function snapshotShape(container: HTMLElement): unknown {
      // Capture the structure that proves source-binding + content
      // stability. Excludes className strings (which contain
      // CSS-module hashes that change per build).
      return Array.from(container.querySelectorAll('[data-agent-ref]')).map((row) => ({
        agentRef: row.getAttribute('data-agent-ref'),
        text: row.textContent,
        sourceFields: Array.from(
          row.querySelectorAll('[data-source-field],[data-source-fields]'),
        ).map((el) => ({
          tag: el.tagName.toLowerCase(),
          singleField: el.getAttribute('data-source-field'),
          multiFields: el.getAttribute('data-source-fields'),
          text: el.textContent,
        })),
      }));
    }

    const { container, rerender } = render(<DispositionOverlay snapshot={snapshot} />);
    const first = snapshotShape(container);
    rerender(<DispositionOverlay snapshot={snapshot} />);
    const second = snapshotShape(container);
    expect(second).toEqual(first);
    // Freeze the className-free selector tree so future drift is caught.
    expect(second).toMatchSnapshot();
  });

  it('Test 8 — source-field assertion fires for synthesized orphan in dev', () => {
    const orphan = {
      agentRef: 'kagent-system/orphan',
      namespace: 'kagent-system',
      agentName: 'orphan',
      configMapName: 'orphan-disposition',
      // idleBehavior intentionally MISSING — multi-field assertion for
      // "tokens remaining" must throw because the computed value's
      // input is absent.
      spentTokensToday: 0,
      postsToday: 0,
      proposalsToday: 0,
      overBudget: false,
      overBudgetEventCountToday: 0,
      dailyBoundaryUtc: '2026-05-09T00:00:00.000Z',
    } as unknown as DispositionOverlayRow;
    const snapshot = { dispositions: new Map([['kagent-system/orphan', orphan]]) };

    let caught: Error | null = null;
    try {
      render(<DispositionOverlay snapshot={snapshot} />);
    } catch (e) {
      caught = e as Error;
    }
    expect(caught).toBeInstanceOf(Error);
    // The error message lists ALL sourceFields the assertion checked
    // — both names appear (the missing one + the present one).
    expect(caught?.message).toMatch(/source-binding violation/);
    expect(caught?.message).toMatch(/sourceFields=spentTokensToday,idleBehavior/);
  });

  it('Test 9 — postsToday is NOT surfaced (reserved per REQUIREMENTS.md §4)', () => {
    const snapshot = makeSnapshot([makeRow()]);
    render(<DispositionOverlay snapshot={snapshot} />);
    // No "Posts:" label, no "0 posts", no "post" anywhere.
    expect(screen.queryByText(/posts/i)).toBeNull();
  });

  it('Test 10 — over-budget marker has detail link target /agents/:ns/:name', () => {
    const snapshot = makeSnapshot([
      makeRow({
        spentTokensToday: 60_000,
        overBudget: true,
        overBudgetReason: 'tokens_exceeded',
        overBudgetEventCountToday: 1,
      }),
    ]);
    const { container } = render(<DispositionOverlay snapshot={snapshot} />);
    const anchor = container.querySelector(
      'a[data-source-fields="spentTokensToday,idleBehavior"]',
    );
    expect(anchor).not.toBeNull();
    expect(anchor?.getAttribute('href')).toBe('/agents/kagent-system/researcher-01');
  });

  it('Test 11 — overBudgetEventCountToday rendered when overBudget=true (Codex HIGH #4 / ROADMAP S.C.4)', () => {
    // count=1 → singular "1 event today"
    let snapshot = makeSnapshot([
      makeRow({
        overBudget: true,
        overBudgetReason: 'tokens_exceeded',
        spentTokensToday: 60_000,
        overBudgetEventCountToday: 1,
      }),
    ]);
    let r = render(<DispositionOverlay snapshot={snapshot} />);
    // The eventCount block is the unique element carrying the
    // singular `data-source-field` attribute "overBudgetEventCountToday";
    // its textContent is the canonical literal we render.
    let block = r.container.querySelector(
      '[data-source-field="overBudgetEventCountToday"]',
    );
    expect(block).not.toBeNull();
    expect(block?.textContent).toBe('1 event today');
    r.unmount();

    // count=2 → plural "2 events today"
    snapshot = makeSnapshot([
      makeRow({
        agentRef: 'kagent-system/r2',
        agentName: 'r2',
        overBudget: true,
        overBudgetReason: 'both',
        spentTokensToday: 60_000,
        proposalsToday: 5,
        overBudgetEventCountToday: 2,
      }),
    ]);
    r = render(<DispositionOverlay snapshot={snapshot} />);
    block = r.container.querySelector(
      '[data-source-field="overBudgetEventCountToday"]',
    );
    expect(block).not.toBeNull();
    expect(block?.textContent).toBe('2 events today');
  });

  it('Test 12 — overBudgetEventCountToday is NOT rendered when overBudget=false', () => {
    const snapshot = makeSnapshot([
      makeRow({
        overBudget: false,
        overBudgetEventCountToday: 0,
      }),
    ]);
    const { container } = render(<DispositionOverlay snapshot={snapshot} />);
    const block = container.querySelector(
      '[data-source-field="overBudgetEventCountToday"]',
    );
    expect(block).toBeNull();
  });
});
