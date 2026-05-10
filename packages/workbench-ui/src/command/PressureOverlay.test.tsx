/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * Phase 2 / CC-04 — PressureOverlay component tests.
 *
 * 4 tests:
 *   1. Renders each marker with data-source-field or data-source-fields
 *   2. Reload stability — re-render with same snapshot → equal selectors
 *   3. pressureDramatization=true applies dramatic class
 *   4. pressureDramatization=false keeps data but does NOT apply dramatic class
 *
 * Reload-stability test deliberately uses STABLE SELECTORS (data-source-
 * field(s) attributes + textContent + href) instead of raw HTML-string
 * snapshots — CSS-module class names carry per-build hash suffixes and
 * would cause spurious failures (mirrors DispositionOverlay.test.tsx
 * Test 7's pattern).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';
import type { DispositionOverlayRow } from '@kagent/dto/disposition';

import type {
  AgentSummaryRow,
  GatewayCapacityRow,
  GatewayUsageRow,
  TaskSummary,
} from '../types.js';
import type { CommandSnapshot } from './state.js';
import { PressureOverlay } from './PressureOverlay.js';

function makeSnapshot(overrides: Partial<CommandSnapshot> = {}): CommandSnapshot {
  return {
    agents: new Map<string, AgentSummaryRow>(),
    tasks: new Map<string, TaskSummary>(),
    gatewayCapacity: [] as readonly GatewayCapacityRow[],
    gatewayUsage: [] as readonly GatewayUsageRow[],
    dispositions: new Map<string, DispositionOverlayRow>(),
    events: [],
    lastEventAt: Date.now(),
    error: null,
    ...overrides,
  };
}

function snapshotShape(container: HTMLElement): unknown {
  // Stable selectors — never raw HTML strings (CSS-module hashes break them).
  return Array.from(container.querySelectorAll('a')).map((a) => ({
    tag: a.tagName.toLowerCase(),
    href: a.getAttribute('href'),
    singleField: a.getAttribute('data-source-field'),
    multiFields: a.getAttribute('data-source-fields'),
    text: a.textContent,
  }));
}

describe('PressureOverlay (CC-04)', () => {
  beforeEach(() => {
    vi.stubEnv('NODE_ENV', 'development');
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('Test 1 — renders markers with data-source-field(s) attribute and detailLink href', () => {
    const snapshot = makeSnapshot({
      gatewayCapacity: [
        {
          model: 'm',
          endpoint: 'e',
          backendKind: 'cf',
          inFlight: 8,
          currentCap: 10,
          seed: 0,
          max: 10,
          minSafe: 0,
          recentP50Ms: null,
        },
      ],
    });
    const { container } = render(<PressureOverlay snapshot={snapshot} />);
    const gwAnchor = container.querySelector('a[data-source-fields="inFlight,currentCap"]');
    expect(gwAnchor).not.toBeNull();
    expect(gwAnchor?.getAttribute('href')).toBe('#/gateway');
  });

  it('Test 2 — reload stability: re-render with same snapshot produces equal selector tree', () => {
    const snapshot = makeSnapshot({
      gatewayCapacity: [
        {
          model: 'm',
          endpoint: 'e',
          backendKind: 'cf',
          inFlight: 8,
          currentCap: 10,
          seed: 0,
          max: 10,
          minSafe: 0,
          recentP50Ms: null,
        },
      ],
      tasks: new Map<string, TaskSummary>([
        [
          'kagent-system/t1',
          {
            name: 't1',
            namespace: 'kagent-system',
            uid: 'u1',
            phase: 'Completed',
            targetAgent: 'r',
            artifactCount: 0,
          },
        ],
      ]),
    });
    const { container, rerender } = render(<PressureOverlay snapshot={snapshot} />);
    const first = snapshotShape(container);
    rerender(<PressureOverlay snapshot={snapshot} />);
    const second = snapshotShape(container);
    expect(second).toEqual(first);
    expect(second).toMatchSnapshot();
  });

  it('Test 3 — pressureDramatization=true applies dramatic class', () => {
    const snapshot = makeSnapshot({
      gatewayCapacity: [
        {
          model: 'm',
          endpoint: 'e',
          backendKind: 'cf',
          inFlight: 8,
          currentCap: 10,
          seed: 0,
          max: 10,
          minSafe: 0,
          recentP50Ms: null,
        },
      ],
    });
    const { container } = render(
      <PressureOverlay snapshot={snapshot} pressureDramatization={true} />,
    );
    let dramaticPresent = false;
    container.querySelectorAll('*').forEach((el) => {
      const cls = el.getAttribute('class') ?? '';
      if (cls.includes('pressureMarker') && !cls.includes('Subdued')) dramaticPresent = true;
    });
    expect(dramaticPresent).toBe(true);
  });

  it('Test 4 — pressureDramatization=false keeps data but does NOT apply dramatic class', () => {
    const snapshot = makeSnapshot({
      gatewayCapacity: [
        {
          model: 'm-x',
          endpoint: 'e',
          backendKind: 'cf',
          inFlight: 8,
          currentCap: 10,
          seed: 0,
          max: 10,
          minSafe: 0,
          recentP50Ms: null,
        },
      ],
    });
    const { container } = render(
      <PressureOverlay snapshot={snapshot} pressureDramatization={false} />,
    );
    let dramaticPresent = false;
    let subduedPresent = false;
    container.querySelectorAll('*').forEach((el) => {
      const cls = el.getAttribute('class') ?? '';
      if (cls.includes('pressureMarker') && !cls.includes('Subdued')) dramaticPresent = true;
      if (cls.includes('pressureMarkerSubdued')) subduedPresent = true;
    });
    expect(dramaticPresent).toBe(false);
    expect(subduedPresent).toBe(true);
    // Data still legible — marker text appears (model name from gateway saturation marker).
    expect(container.textContent ?? '').toMatch(/m-x/);
  });
});
