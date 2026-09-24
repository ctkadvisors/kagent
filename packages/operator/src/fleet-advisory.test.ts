/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

import { describe, expect, it } from 'vitest';
import {
  buildAdvisoryTask,
  dispatchAdvisoryQuestion,
  kubernetesAdvisoryTaskStore,
  readAdvisoryResult,
  type AdvisoryQuestion,
} from './fleet-advisory.js';

const question: AdvisoryQuestion = {
  id: 'forum-97',
  repository: 'ctkadvisors/new_localai',
  source: { kind: 'forum', ref: 'post-97' },
  question: 'Why did the worker fail to run the replay?',
  report: 'The last replay returned a timeout.',
  evidence: [{ id: 'observation-18', summary: 'Timeout observed at 13:00Z.' }],
};

describe('fleet advisory AgentTask adapter', () => {
  it('dispatches one bounded, provenance-linked task with a stable digest', () => {
    const task = buildAdvisoryTask(question);
    expect(task.metadata.namespace).toBe('kagent-system');
    expect(task.spec.targetAgent).toBe('fleet-question-researcher');
    expect(task.spec.runConfig).toEqual({ maxIterations: 16, timeoutSeconds: 900 });
    expect(task.spec.idempotencyKey).toMatch(/^[a-f0-9]{64}$/u);
    expect(task.metadata.annotations?.['fleet.knuteson.io/question-digest']).toBe(
      task.spec.idempotencyKey,
    );
    expect(task.spec.payload).toMatchObject({
      contract: 'fleet-advisory-question/v1',
      repository: 'ctkadvisors/new_localai',
      source: { kind: 'forum', ref: 'post-97' },
    });
    expect(buildAdvisoryTask(question).metadata.name).toBe(task.metadata.name);
  });

  it.each(['ctkadvisors/harknote', 'ctkadvisors/ai-interviewer', 'other/new_localai'])(
    'rejects forbidden repository %s',
    (repository) => {
      expect(() => buildAdvisoryTask({ ...question, repository })).toThrow(/repository/u);
    },
  );

  it('rejects oversized or malformed source material before creating a task', () => {
    expect(() => buildAdvisoryTask({ ...question, report: 'x'.repeat(8193) })).toThrow(/report/u);
    expect(() => buildAdvisoryTask({ ...question, evidence: [] })).toThrow(/evidence/u);
    expect(() =>
      buildAdvisoryTask({ ...question, evidence: [{ id: 'x', summary: 'x'.repeat(2049) }] }),
    ).toThrow(/summary/u);
  });

  it('reuses only the same task after an uncertain create response', async () => {
    const task = buildAdvisoryTask(question);
    const existing = { ...task, metadata: { ...task.metadata, uid: 'task-uid-1' } };
    const store = {
      create: () => Promise.reject(new Error('409 conflict')),
      get: () => Promise.resolve(existing),
    };
    await expect(dispatchAdvisoryQuestion(store, question)).resolves.toMatchObject({
      uid: 'task-uid-1',
      digest: task.spec.idempotencyKey,
    });
    await expect(
      dispatchAdvisoryQuestion(
        {
          ...store,
          get: () => Promise.resolve({ ...existing, spec: { ...existing.spec, payload: {} } }),
        },
        question,
      ),
    ).rejects.toThrow(/conflict/u);
  });

  it('reads only a matching terminal task and returns unverified hypotheses', () => {
    const task = buildAdvisoryTask(question);
    const completed = {
      ...task,
      metadata: { ...task.metadata, uid: 'task-uid-1' },
      status: {
        phase: 'Completed' as const,
        result: {
          content: JSON.stringify({
            hypotheses: [
              {
                predicate: 'The replay timeout follows a worker deadline.',
                scope: 'fleet worker',
                prediction: 'A longer bounded deadline will complete the same replay.',
                evidenceIds: ['observation-18'],
              },
            ],
            plan: ['Inspect the deadline configuration.'],
          }),
        },
      },
    };
    const receipt = {
      namespace: 'kagent-system',
      name: task.metadata.name!,
      uid: 'task-uid-1',
      digest: task.spec.idempotencyKey!,
      evidenceIds: ['observation-18'],
    };
    expect(readAdvisoryResult(completed, receipt)).toMatchObject({
      state: 'completed',
      hypotheses: [{ status: 'unverified', evidenceIds: ['observation-18'] }],
    });
    expect(
      readAdvisoryResult(
        { ...completed, metadata: { ...completed.metadata, uid: 'other' } },
        receipt,
      ),
    ).toEqual({ state: 'stale' });
    expect(
      readAdvisoryResult({ ...completed, spec: { ...completed.spec, payload: {} } }, receipt),
    ).toEqual({ state: 'stale' });
    expect(readAdvisoryResult({ ...completed, status: { phase: 'Pending' } }, receipt)).toEqual({
      state: 'pending',
    });
  });

  it('rejects result authority fields and invented evidence', () => {
    const task = buildAdvisoryTask(question);
    const receipt = {
      namespace: 'kagent-system',
      name: task.metadata.name!,
      uid: 'task-uid-1',
      digest: task.spec.idempotencyKey!,
      evidenceIds: ['observation-18'],
    };
    const base = { ...task, metadata: { ...task.metadata, uid: 'task-uid-1' } };
    for (const output of [
      { hypotheses: [], plan: [], releaseApproved: true },
      {
        hypotheses: [{ predicate: 'p', scope: 's', prediction: 'x', evidenceIds: ['invented'] }],
        plan: [],
      },
    ]) {
      expect(
        readAdvisoryResult(
          { ...base, status: { phase: 'Completed', result: { content: JSON.stringify(output) } } },
          receipt,
        ),
      ).toEqual({ state: 'invalid' });
    }
  });

  it('uses only the namespaced AgentTask Kubernetes resource', async () => {
    const task = buildAdvisoryTask(question);
    const calls: unknown[] = [];
    const store = kubernetesAdvisoryTaskStore({
      createNamespacedCustomObject: (args) => {
        calls.push(args);
        return Promise.resolve({ ...task, metadata: { ...task.metadata, uid: 'task-uid-1' } });
      },
      getNamespacedCustomObject: (args) => {
        calls.push(args);
        return Promise.resolve(undefined);
      },
    });
    await store.create(task);
    await store.get('kagent-system', task.metadata.name!);
    expect(calls).toEqual([
      {
        group: 'kagent.knuteson.io',
        version: 'v1alpha1',
        namespace: 'kagent-system',
        plural: 'agenttasks',
        body: task,
      },
      {
        group: 'kagent.knuteson.io',
        version: 'v1alpha1',
        namespace: 'kagent-system',
        plural: 'agenttasks',
        name: task.metadata.name,
      },
    ]);
    await expect(store.get('default', task.metadata.name!)).rejects.toThrow(/namespace/u);
    await expect(store.create({ ...task, spec: { ...task.spec, payload: {} } })).rejects.toThrow(
      /advisory/u,
    );
  });
});
