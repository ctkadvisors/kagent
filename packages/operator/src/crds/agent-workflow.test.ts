/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

import { describe, expect, it } from 'vitest';

import { API_GROUP_VERSION } from './types.js';
import {
  deploymentNameForAgentWorkflow,
  isAgentWorkflow,
  isAgentWorkflowFailed,
  isAgentWorkflowReady,
  isEventTrigger,
  isScheduleTrigger,
  isWebhookTrigger,
  serviceNameForAgentWorkflow,
  type AgentWorkflow,
  type AgentWorkflowSpec,
  type AgentWorkflowTrigger,
} from './agent-workflow.js';

const baseSpec: AgentWorkflowSpec = {
  image: 'ghcr.io/example/research-pipeline:v1',
  handler: 'researchOrchestrator',
};

const baseWorkflow: AgentWorkflow = {
  apiVersion: API_GROUP_VERSION,
  kind: 'AgentWorkflow',
  metadata: { name: 'daily-research', namespace: 'default' },
  spec: baseSpec,
};

describe('isAgentWorkflow', () => {
  it('accepts a minimal valid AgentWorkflow', () => {
    expect(isAgentWorkflow(baseWorkflow)).toBe(true);
  });

  it('rejects null/undefined/non-objects', () => {
    expect(isAgentWorkflow(null)).toBe(false);
    expect(isAgentWorkflow(undefined)).toBe(false);
    expect(isAgentWorkflow('string')).toBe(false);
    expect(isAgentWorkflow(42)).toBe(false);
  });

  it('rejects wrong apiVersion', () => {
    expect(isAgentWorkflow({ ...baseWorkflow, apiVersion: 'kagent.knuteson.io/v2alpha1' })).toBe(
      false,
    );
  });

  it('rejects wrong kind', () => {
    expect(isAgentWorkflow({ ...baseWorkflow, kind: 'Agent' })).toBe(false);
  });

  it('rejects missing image', () => {
    expect(
      isAgentWorkflow({
        ...baseWorkflow,
        spec: { ...baseSpec, image: '' },
      }),
    ).toBe(false);
  });

  it('rejects missing handler', () => {
    expect(
      isAgentWorkflow({
        ...baseWorkflow,
        spec: { ...baseSpec, handler: '' },
      }),
    ).toBe(false);
  });

  it('rejects null spec', () => {
    expect(
      isAgentWorkflow({
        ...baseWorkflow,
        spec: null as unknown as AgentWorkflowSpec,
      }),
    ).toBe(false);
  });
});

describe('trigger predicates', () => {
  const scheduleTrigger: AgentWorkflowTrigger = {
    kind: 'schedule',
    schedule: '0 6 * * *',
  };
  const webhookTrigger: AgentWorkflowTrigger = {
    kind: 'webhook',
    webhook: { path: '/trigger/research', hmacSecretRef: { name: 's', key: 'k' } },
  };
  const eventTrigger: AgentWorkflowTrigger = {
    kind: 'event',
    event: { topic: 'research.findings', schema: { type: 'object' } },
  };

  it('isScheduleTrigger narrows correctly', () => {
    expect(isScheduleTrigger(scheduleTrigger)).toBe(true);
    expect(isScheduleTrigger(webhookTrigger)).toBe(false);
    expect(isScheduleTrigger(eventTrigger)).toBe(false);
  });

  it('isWebhookTrigger narrows correctly', () => {
    expect(isWebhookTrigger(scheduleTrigger)).toBe(false);
    expect(isWebhookTrigger(webhookTrigger)).toBe(true);
    expect(isWebhookTrigger(eventTrigger)).toBe(false);
  });

  it('isEventTrigger narrows correctly', () => {
    expect(isEventTrigger(scheduleTrigger)).toBe(false);
    expect(isEventTrigger(webhookTrigger)).toBe(false);
    expect(isEventTrigger(eventTrigger)).toBe(true);
  });
});

describe('readiness predicates', () => {
  it('isAgentWorkflowReady is false when status absent', () => {
    expect(isAgentWorkflowReady(baseWorkflow)).toBe(false);
  });

  it('isAgentWorkflowReady is false when phase is Pending', () => {
    expect(
      isAgentWorkflowReady({
        ...baseWorkflow,
        status: { phase: 'Pending' },
      }),
    ).toBe(false);
  });

  it('isAgentWorkflowReady is true when phase is Ready', () => {
    expect(
      isAgentWorkflowReady({
        ...baseWorkflow,
        status: { phase: 'Ready' },
      }),
    ).toBe(true);
  });

  it('isAgentWorkflowFailed only matches Failed phase', () => {
    expect(isAgentWorkflowFailed(baseWorkflow)).toBe(false);
    expect(isAgentWorkflowFailed({ ...baseWorkflow, status: { phase: 'Pending' } })).toBe(false);
    expect(isAgentWorkflowFailed({ ...baseWorkflow, status: { phase: 'Ready' } })).toBe(false);
    expect(isAgentWorkflowFailed({ ...baseWorkflow, status: { phase: 'Failed' } })).toBe(true);
  });
});

describe('name helpers', () => {
  it('deploymentNameForAgentWorkflow prefixes with kawf-', () => {
    expect(deploymentNameForAgentWorkflow(baseWorkflow)).toBe('kawf-daily-research');
  });

  it('serviceNameForAgentWorkflow matches deploymentName', () => {
    expect(serviceNameForAgentWorkflow(baseWorkflow)).toBe('kawf-daily-research');
  });

  it('throws when name is missing', () => {
    const wf = { ...baseWorkflow, metadata: {} };
    expect(() => deploymentNameForAgentWorkflow(wf)).toThrow(/metadata.name/);
  });
});
