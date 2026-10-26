/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/** Bind current real work to the existing fleet idle slot. No extra task or grant. */
import type { RenderedAgentTask } from '@kagent/triggers';

const CONSUMERS = new Set([
  'fleet-auditor',
  'fleet-brainstormer',
  'fleet-disposer',
  'fleet-remeasurer',
  'fleet-verifier',
]);
const MAX_REPORT_BYTES = 2 * 1024 * 1024;
const MAX_WORK_BYTES = 64 * 1024;
interface FleetWork extends Record<string, unknown> {
  readonly schema: 'fleet-capability-work/v1';
  readonly id: string;
  readonly stage: 'build' | 'use';
  readonly target_agent: string;
  readonly goal: string;
  readonly instructions: string;
}
export interface FleetWorkOptions {
  readonly url?: string;
  readonly fetch?: typeof globalThis.fetch;
}
function parseWork(value: unknown): FleetWork {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new Error('fleet work context unavailable');
  const work = value as Record<string, unknown>;
  if (
    work.schema !== 'fleet-capability-work/v1' ||
    typeof work.id !== 'string' ||
    !/^[a-f0-9]{32}$/u.test(work.id) ||
    typeof work.goal !== 'string' ||
    work.goal.length === 0 ||
    work.goal.length > 2400 ||
    typeof work.instructions !== 'string' ||
    work.instructions.length > 8192 ||
    !Array.isArray(work.sources) ||
    work.sources.length > 12 ||
    !Array.isArray(work.previous_outcomes) ||
    work.previous_outcomes.length > 8 ||
    !Array.isArray(work.capabilities) ||
    work.capabilities.length > 20 ||
    !(
      (work.stage === 'build' && work.target_agent === 'fleet-inventor') ||
      (work.stage === 'use' &&
        typeof work.target_agent === 'string' &&
        CONSUMERS.has(work.target_agent))
    ) ||
    Buffer.byteLength(JSON.stringify(work)) > MAX_WORK_BYTES
  )
    throw new Error('invalid fleet work context');
  return work as FleetWork;
}

export async function enrichFleetWork(
  manifest: RenderedAgentTask,
  options: FleetWorkOptions = {},
): Promise<RenderedAgentTask> {
  if (
    !options.url ||
    manifest.metadata.namespace !== 'kagent-system' ||
    manifest.metadata.labels['kagent.knuteson.io/trigger-kind'] !== 'schedule' ||
    manifest.metadata.labels['kagent.knuteson.io/trigger-name'] !== 'fleet-nightly-invention' ||
    manifest.spec.targetAgent !== 'fleet-inventor'
  )
    return manifest;
  const response = await (options.fetch ?? globalThis.fetch)(options.url, {
    signal: AbortSignal.timeout(5000),
    headers: { Accept: 'application/json' },
  });
  if (!response.ok) throw new Error(`fleet work unavailable: HTTP ${String(response.status)}`);
  const text = await response.text();
  if (Buffer.byteLength(text) > MAX_REPORT_BYTES)
    throw new Error('fleet work report exceeds bound');
  const report = JSON.parse(text) as Record<string, unknown>;
  const work = parseWork(report.capability_work);
  const original =
    typeof manifest.spec.payload === 'object' &&
    manifest.spec.payload !== null &&
    !Array.isArray(manifest.spec.payload)
      ? (manifest.spec.payload as Record<string, unknown>)
      : {};
  const message = `${work.goal}\n\n${work.instructions}\n\nCURRENT WORK AND ORIGINAL REFERENCES:\n${JSON.stringify(work)}`;
  return {
    ...manifest,
    metadata: {
      ...manifest.metadata,
      labels: {
        ...manifest.metadata.labels,
        'fleet.knuteson.io/work-id': work.id,
        'fleet.knuteson.io/work-stage': work.stage,
      },
    },
    spec: {
      ...manifest.spec,
      targetAgent: work.target_agent,
      // The agent pod gives this field precedence over payload. Both must carry
      // the selected work, including when the schedule had a static message.
      originalUserMessage: message,
      payload: {
        ...original,
        text: message,
        capability_work: work,
      },
    },
  };
}
