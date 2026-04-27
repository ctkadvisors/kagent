/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

import { describe, expect, it } from 'vitest';

import { API_GROUP_VERSION, type Agent, type AgentTask } from './crds/index.js';
import { buildJobSpec, jobNameForTask } from './job-spec.js';

const sampleAgent: Agent = {
  apiVersion: API_GROUP_VERSION,
  kind: 'Agent',
  metadata: { name: 'researcher', namespace: 'default', uid: 'a-uid' },
  spec: {
    model: 'workers-ai/@cf/meta/llama-4-scout-17b-16e-instruct',
    systemPrompt: 'You are a research assistant.',
    tools: ['fetch_url', 'web_search'],
    sandboxProfile: 'default',
  },
};

const sampleTask: AgentTask = {
  apiVersion: API_GROUP_VERSION,
  kind: 'AgentTask',
  metadata: { name: 't1', namespace: 'default', uid: 'task-uid-12345' },
  spec: {
    targetAgent: 'researcher',
    payload: { topic: 'k3s' },
    originalUserMessage: 'what is k3s default runtime?',
  },
};

describe('jobNameForTask', () => {
  it('derives kat-<uid> deterministically', () => {
    expect(jobNameForTask(sampleTask)).toBe('kat-task-uid-12345');
  });

  it('throws when metadata.uid is missing', () => {
    const noUid: AgentTask = {
      ...sampleTask,
      metadata: { ...sampleTask.metadata, uid: undefined },
    };
    expect(() => jobNameForTask(noUid)).toThrow(/missing metadata.uid/);
  });

  it('throws when metadata.uid is empty string', () => {
    const empty: AgentTask = {
      ...sampleTask,
      metadata: { ...sampleTask.metadata, uid: '' },
    };
    expect(() => jobNameForTask(empty)).toThrow(/missing metadata.uid/);
  });

  it('truncates long UIDs to keep total name ≤ 63 chars', () => {
    const longUid = 'x'.repeat(100);
    const longTask: AgentTask = {
      ...sampleTask,
      metadata: { ...sampleTask.metadata, uid: longUid },
    };
    const name = jobNameForTask(longTask);
    expect(name.length).toBeLessThanOrEqual(63);
    expect(name).toMatch(/^kat-/);
  });
});

describe('buildJobSpec', () => {
  it('produces a Job with the expected name + namespace', () => {
    const job = buildJobSpec(sampleAgent, sampleTask);
    expect(job.metadata?.name).toBe('kat-task-uid-12345');
    expect(job.metadata?.namespace).toBe('default');
    expect(job.apiVersion).toBe('batch/v1');
    expect(job.kind).toBe('Job');
  });

  it('sets ownerReferences pointing at the AgentTask', () => {
    const job = buildJobSpec(sampleAgent, sampleTask);
    const owner = job.metadata?.ownerReferences?.[0];
    expect(owner?.apiVersion).toBe(API_GROUP_VERSION);
    expect(owner?.kind).toBe('AgentTask');
    expect(owner?.name).toBe('t1');
    expect(owner?.uid).toBe('task-uid-12345');
    expect(owner?.controller).toBe(true);
    expect(owner?.blockOwnerDeletion).toBe(true);
  });

  it('sets all KAGENT_* env vars on the container', () => {
    const job = buildJobSpec(sampleAgent, sampleTask);
    const env = job.spec?.template?.spec?.containers?.[0]?.env ?? [];
    const byName = new Map(env.map((e) => [e.name, e.value]));
    expect(byName.get('KAGENT_TASK_ID')).toBe('task-uid-12345');
    expect(byName.get('KAGENT_TASK_NAME')).toBe('t1');
    expect(byName.get('KAGENT_TASK_NAMESPACE')).toBe('default');
    expect(byName.get('KAGENT_AGENT_NAME')).toBe('researcher');
    expect(JSON.parse(byName.get('KAGENT_AGENT_SPEC') ?? '{}')).toMatchObject({
      model: sampleAgent.spec.model,
    });
    expect(JSON.parse(byName.get('KAGENT_TASK_SPEC') ?? '{}')).toMatchObject({
      targetAgent: 'researcher',
    });
  });

  it('appends extraEnv after the KAGENT_* defaults', () => {
    const job = buildJobSpec(sampleAgent, sampleTask, {
      extraEnv: [
        { name: 'KAGENT_LITELLM_BASE_URL', value: 'http://192.168.68.60:1234/v1' },
        {
          name: 'OTEL_EXPORTER_OTLP_TRACES_ENDPOINT',
          value: 'http://langfuse:3000/api/public/otel/v1/traces',
        },
      ],
    });
    const env = job.spec?.template?.spec?.containers?.[0]?.env ?? [];
    const byName = new Map(env.map((e) => [e.name, e.value]));
    expect(byName.get('KAGENT_LITELLM_BASE_URL')).toBe('http://192.168.68.60:1234/v1');
    expect(byName.get('OTEL_EXPORTER_OTLP_TRACES_ENDPOINT')).toBe(
      'http://langfuse:3000/api/public/otel/v1/traces',
    );
    // KAGENT_* defaults are still present.
    expect(byName.get('KAGENT_TASK_ID')).toBe('task-uid-12345');
  });

  it('uses placeholder image by default', () => {
    const job = buildJobSpec(sampleAgent, sampleTask);
    const image = job.spec?.template?.spec?.containers?.[0]?.image;
    expect(image).toMatch(/^ghcr\.io\/ctkadvisors\/kagent-agent-pod:/);
  });

  it('honors image override from BuildJobSpecOptions', () => {
    const job = buildJobSpec(sampleAgent, sampleTask, { image: 'custom:tag' });
    expect(job.spec?.template?.spec?.containers?.[0]?.image).toBe('custom:tag');
  });

  it('omits runtimeClassName by default; applies kata when supplied', () => {
    const without = buildJobSpec(sampleAgent, sampleTask);
    expect(without.spec?.template?.spec?.runtimeClassName).toBeUndefined();
    const kata = buildJobSpec(sampleAgent, sampleTask, { runtimeClassName: 'kata' });
    expect(kata.spec?.template?.spec?.runtimeClassName).toBe('kata');
  });

  it('omits imagePullSecrets / serviceAccountName by default', () => {
    const job = buildJobSpec(sampleAgent, sampleTask);
    expect(job.spec?.template?.spec?.imagePullSecrets).toBeUndefined();
    expect(job.spec?.template?.spec?.serviceAccountName).toBeUndefined();
  });

  it('applies imagePullSecrets + serviceAccountName when supplied', () => {
    const job = buildJobSpec(sampleAgent, sampleTask, {
      imagePullSecret: 'ghcr-pull',
      serviceAccountName: 'kagent-agent-pod',
    });
    expect(job.spec?.template?.spec?.imagePullSecrets?.[0]?.name).toBe('ghcr-pull');
    expect(job.spec?.template?.spec?.serviceAccountName).toBe('kagent-agent-pod');
  });

  it('sets restartPolicy=Never and backoffLimit=0', () => {
    const job = buildJobSpec(sampleAgent, sampleTask);
    expect(job.spec?.template?.spec?.restartPolicy).toBe('Never');
    expect(job.spec?.backoffLimit).toBe(0);
  });

  it('labels the Pod with agent + task + managed-by', () => {
    const job = buildJobSpec(sampleAgent, sampleTask);
    const labels = job.spec?.template?.metadata?.labels ?? {};
    expect(labels['kagent.knuteson.io/agent']).toBe('researcher');
    expect(labels['kagent.knuteson.io/task']).toBe('t1');
    expect(labels['kagent.knuteson.io/managed-by']).toBe('kagent-operator');
  });

  it('omits activeDeadlineSeconds when AgentTask.spec.timeoutSeconds is unset', () => {
    const job = buildJobSpec(sampleAgent, sampleTask);
    expect(job.spec?.activeDeadlineSeconds).toBeUndefined();
  });

  it('sets Job.spec.activeDeadlineSeconds from AgentTask.spec.timeoutSeconds', () => {
    const t = { ...sampleTask, spec: { ...sampleTask.spec, timeoutSeconds: 60 } };
    const job = buildJobSpec(sampleAgent, t);
    expect(job.spec?.activeDeadlineSeconds).toBe(60);
  });

  it('omits activeDeadlineSeconds when timeoutSeconds is 0 or negative (defensive)', () => {
    const zero = { ...sampleTask, spec: { ...sampleTask.spec, timeoutSeconds: 0 } };
    expect(buildJobSpec(sampleAgent, zero).spec?.activeDeadlineSeconds).toBeUndefined();
    const neg = { ...sampleTask, spec: { ...sampleTask.spec, timeoutSeconds: -5 } };
    expect(buildJobSpec(sampleAgent, neg).spec?.activeDeadlineSeconds).toBeUndefined();
  });
});
