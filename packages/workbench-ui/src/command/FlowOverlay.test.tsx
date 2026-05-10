/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * Phase 3 / FLOW-01 — FlowOverlay component tests.
 *
 * 5 tests:
 *   1. Renders all 8 flow sections (by kind) — always visible, even when empty
 *   2. Renders gauges with data-source-field or data-source-fields
 *   3. Reload stability — re-render with same snapshot → equal selectors
 *   4. pressureDramatization=true applies dramatic class
 *   5. pressureDramatization=false keeps data but does NOT apply dramatic class
 *
 * Plus explicit empty-state coverage (Pitfall 7 deviation from PressureOverlay):
 *   FlowOverlay NEVER returns null — when a flow has no gauges, a
 *   placeholder row is rendered carrying the FlowType's source field(s).
 *
 * Reload-stability test uses STABLE SELECTORS (data-source-field(s)
 * attributes + textContent + href) instead of raw HTML-string snapshots —
 * CSS-module class names carry per-build hash suffixes and would cause
 * spurious failures (mirrors PressureOverlay.test.tsx).
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
import { FLOW_TYPES } from './flows.js';
import { FlowOverlay } from './FlowOverlay.js';

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

describe('FlowOverlay (FLOW-01)', () => {
  beforeEach(() => {
    vi.stubEnv('NODE_ENV', 'development');
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('Test 1 — always renders all 8 flow sections, including empty-state placeholders', () => {
    // Empty snapshot — all flows should render their empty-state placeholder rows.
    const snapshot = makeSnapshot();
    const { container } = render(<FlowOverlay snapshot={snapshot} />);

    // Should have exactly 8 sections (one per FLOW_TYPES entry)
    const sections = container.querySelectorAll('section');
    expect(sections.length).toBe(FLOW_TYPES.length);
    expect(sections.length).toBe(8);

    // Each section's header should match the flow kind
    const sectionHeaders = Array.from(container.querySelectorAll('h3')).map(
      (h) => h.textContent,
    );
    for (const ft of FLOW_TYPES) {
      expect(sectionHeaders).toContain(ft.kind);
    }

    // All 8 empty-state placeholder rows should carry data-source-field(s)
    // so the orphan assertion has a backing field (Pitfall 7 compliance).
    for (const ft of FLOW_TYPES) {
      const hasSourceAttr = ft.sourceField !== undefined || ft.sourceFields !== undefined;
      expect(hasSourceAttr).toBe(true);
    }

    // The "no source data" text should appear for all 8 flows when empty
    const text = container.textContent ?? '';
    expect(text).toMatch(/no modelPower source data/);
    expect(text).toMatch(/no tokenFlow source data/);
    expect(text).toMatch(/no buildPower source data/);
    expect(text).toMatch(/no podCapacity source data/);
    expect(text).toMatch(/no artifactBandwidth source data/);
    expect(text).toMatch(/no authority source data/);
    expect(text).toMatch(/no trust source data/);
    expect(text).toMatch(/no attention source data/);
  });

  it('Test 2 — renders gauges with data-source-field(s) attribute and detailLink href', () => {
    const snapshot = makeSnapshot({
      gatewayCapacity: [
        {
          model: 'workers-ai/@cf/meta/llama-4-scout',
          endpoint: 'https://gateway.ai.cloudflare.com/v1/test',
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
    const { container } = render(<FlowOverlay snapshot={snapshot} />);

    // modelPower gauge should have data-source-fields="inFlight,currentCap"
    const modelPowerAnchor = container.querySelector(
      'a[data-source-fields="inFlight,currentCap"]',
    );
    expect(modelPowerAnchor).not.toBeNull();
    expect(modelPowerAnchor?.getAttribute('href')).toBe('#/gateway');

    // The gauge text should include the model name
    expect(modelPowerAnchor?.textContent ?? '').toMatch(/llama-4-scout/);

    // Empty-state placeholder for a flow with no data should carry data-source-fields
    // (e.g. tokenFlow has no dispatched tasks with model → empty state)
    const tokenFlowSection = Array.from(container.querySelectorAll('section')).find(
      (s) => s.querySelector('h3')?.textContent === 'tokenFlow',
    );
    expect(tokenFlowSection).not.toBeNull();
    const tokenFlowEmpty = tokenFlowSection?.querySelector(
      '[data-source-fields="model,phase"]',
    );
    expect(tokenFlowEmpty).not.toBeNull();
  });

  it('Test 3 — reload stability: re-render with same snapshot produces equal selector tree', () => {
    const snapshot = makeSnapshot({
      gatewayCapacity: [
        {
          model: 'llama-4',
          endpoint: 'https://ep1',
          backendKind: 'cf',
          inFlight: 3,
          currentCap: 10,
          seed: 0,
          max: 10,
          minSafe: 0,
          recentP50Ms: null,
        },
      ],
    });
    const { container, rerender } = render(<FlowOverlay snapshot={snapshot} />);
    const first = snapshotShape(container);
    rerender(<FlowOverlay snapshot={snapshot} />);
    const second = snapshotShape(container);
    expect(second).toEqual(first);
    expect(second).toMatchSnapshot();
  });

  it('Test 4 — pressureDramatization=true applies dramatic class', () => {
    const snapshot = makeSnapshot({
      gatewayCapacity: [
        {
          model: 'llama-4',
          endpoint: 'https://ep2',
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
    const { container } = render(<FlowOverlay snapshot={snapshot} pressureDramatization={true} />);
    let dramaticPresent = false;
    container.querySelectorAll('*').forEach((el) => {
      const cls = el.getAttribute('class') ?? '';
      if (cls.includes('flowGauge') && !cls.includes('Subdued')) dramaticPresent = true;
    });
    expect(dramaticPresent).toBe(true);
  });

  it('Test 5 — pressureDramatization=false keeps data but does NOT apply dramatic class', () => {
    const snapshot = makeSnapshot({
      gatewayCapacity: [
        {
          model: 'llama-4-subdued-test',
          endpoint: 'https://ep3',
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
      <FlowOverlay snapshot={snapshot} pressureDramatization={false} />,
    );
    let dramaticPresent = false;
    let subduedPresent = false;
    container.querySelectorAll('*').forEach((el) => {
      const cls = el.getAttribute('class') ?? '';
      if (cls.includes('flowGauge') && !cls.includes('Subdued')) dramaticPresent = true;
      if (cls.includes('flowGaugeSubdued')) subduedPresent = true;
    });
    expect(dramaticPresent).toBe(false);
    expect(subduedPresent).toBe(true);
    // Data still legible — gauge text appears (model name from modelPower gauge)
    expect(container.textContent ?? '').toMatch(/llama-4-subdued-test/);
  });
});
