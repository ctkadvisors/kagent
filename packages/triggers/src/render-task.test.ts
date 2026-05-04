/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

import { describe, expect, it } from 'vitest';

import {
  PLACEHOLDER_CAPABILITY_VALUE,
  renderAgentTaskFromTemplate,
  type AgentTaskTemplateSpec,
  type RenderInput,
} from './render-task.js';

const baseTemplate: AgentTaskTemplateSpec = {
  targetAgent: 'researcher',
  payload: { prompt: 'summarize the day' },
};

const baseInput: RenderInput = {
  triggerName: 'daily-research',
  triggerKind: 'schedule',
  namespace: 'kagent-system',
  taskTemplate: baseTemplate,
  now: new Date(Date.UTC(2026, 4, 3, 6, 0, 0, 0)),
};

describe('renderAgentTaskFromTemplate', () => {
  it('renders apiVersion + kind from substrate constants', () => {
    const out = renderAgentTaskFromTemplate(baseInput);
    expect(out.apiVersion).toBe('kagent.knuteson.io/v1alpha1');
    expect(out.kind).toBe('AgentTask');
  });

  it('encodes the unix-seconds tick into metadata.name', () => {
    const out = renderAgentTaskFromTemplate(baseInput);
    // 2026-05-03T06:00:00Z → unix-seconds floor of base.now.getTime()/1000.
    const expected = `daily-research-${String(Math.floor(baseInput.now.getTime() / 1000))}`;
    expect(out.metadata.name).toBe(expected);
  });

  it('truncates an overlong rendered name to 63 chars', () => {
    const longName = 'x'.repeat(80);
    const out = renderAgentTaskFromTemplate({ ...baseInput, triggerName: longName });
    expect(out.metadata.name.length).toBe(63);
    expect(out.metadata.name.startsWith('xxxxxxxxxxxxxxxxxxxx')).toBe(true);
  });

  it('stamps the trigger labels + triggered-at annotation + placeholder-cap annotation', () => {
    const out = renderAgentTaskFromTemplate(baseInput);
    expect(out.metadata.labels['kagent.knuteson.io/trigger-kind']).toBe('schedule');
    expect(out.metadata.labels['kagent.knuteson.io/trigger-name']).toBe('daily-research');
    expect(out.metadata.labels['kagent.knuteson.io/managed-by']).toBe('kagent-triggers');
    expect(out.metadata.annotations['kagent.knuteson.io/triggered-at']).toBe(
      '2026-05-03T06:00:00.000Z',
    );
    expect(out.metadata.annotations['kagent.knuteson.io/placeholder-cap']).toBe(
      PLACEHOLDER_CAPABILITY_VALUE,
    );
  });

  it('passes the template spec through verbatim', () => {
    const out = renderAgentTaskFromTemplate(baseInput);
    expect(out.spec.targetAgent).toBe('researcher');
    expect(out.spec.payload).toEqual({ prompt: 'summarize the day' });
  });

  it('lets payloadOverride win over the template payload', () => {
    const override = { prompt: 'webhook-supplied prompt' };
    const out = renderAgentTaskFromTemplate({ ...baseInput, payloadOverride: override });
    expect(out.spec.payload).toEqual(override);
  });

  it('rejects a template missing both targetAgent and targetCapability', () => {
    const orphanTemplate: AgentTaskTemplateSpec = { payload: { foo: 'bar' } };
    expect(() =>
      renderAgentTaskFromTemplate({
        ...baseInput,
        taskTemplate: orphanTemplate,
      }),
    ).toThrow(/targetAgent OR targetCapability/);
  });

  it('rejects an empty triggerName', () => {
    expect(() => renderAgentTaskFromTemplate({ ...baseInput, triggerName: '' })).toThrow(
      /triggerName is required/,
    );
  });

  it('rejects an empty namespace', () => {
    expect(() => renderAgentTaskFromTemplate({ ...baseInput, namespace: '' })).toThrow(
      /namespace is required/,
    );
  });

  it('accepts a webhook-kind trigger', () => {
    const out = renderAgentTaskFromTemplate({ ...baseInput, triggerKind: 'webhook' });
    expect(out.metadata.labels['kagent.knuteson.io/trigger-kind']).toBe('webhook');
  });
});
