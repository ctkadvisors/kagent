/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * A2A envelope contract — verifies the operator-side guarantees
 * docs/HARNESS-LESSONS.md §6 ("the substrate is opinionated about
 * what carries between agents") against the lived behavior of
 * reconcile + Dispatcher. The substrate guarantees:
 *
 *   1. originalUserMessage is present in every dispatch (mandatory at
 *      the protocol level so sub-agents can't operate on context-
 *      stripped task strings).
 *   2. parentTaskId is preserved across delegation chains.
 *   3. parentDistillation + expectedTools, when supplied, ride the
 *      same envelope (recommended for sub-agents).
 *   4. taskId on the wire matches AgentTask.metadata.uid.
 *
 * These properties are tested at the reconcile-loop layer with
 * mocked K8s clients + StubDispatcher acting as the wire-tap.
 */

import { describe, expect, it, vi } from 'vitest';

import { API_GROUP_VERSION, type Agent, type AgentTask } from './crds/index.js';
import { StubDispatcher } from './dispatcher.js';
import { reconcileAgentTask, type ReconcileDeps } from './reconcile.js';

const validAgent: Agent = {
  apiVersion: API_GROUP_VERSION,
  kind: 'Agent',
  metadata: { name: 'researcher', namespace: 'default', uid: 'a-uid' },
  spec: { model: 'workers-ai/@cf/meta/llama-4-scout-17b-16e-instruct' },
};

function makeDeps(dispatcher: StubDispatcher): ReconcileDeps {
  return {
    customApi: {
      getNamespacedCustomObject: vi.fn().mockResolvedValue(validAgent),
      patchNamespacedCustomObjectStatus: vi.fn().mockResolvedValue({}),
    } as unknown as ReconcileDeps['customApi'],
    batchApi: {
      createNamespacedJob: vi.fn().mockResolvedValue({}),
    } as unknown as ReconcileDeps['batchApi'],
    dispatcher,
  };
}

function makeTask(overrides: Partial<AgentTask['spec']> = {}): AgentTask {
  return {
    apiVersion: API_GROUP_VERSION,
    kind: 'AgentTask',
    metadata: { name: 't1', namespace: 'default', uid: 'task-uid-42' },
    spec: {
      targetAgent: 'researcher',
      payload: { x: 1 },
      originalUserMessage: 'fetch the docs and summarize',
      ...overrides,
    },
  };
}

describe('A2A envelope contract', () => {
  it('always carries originalUserMessage on the wire', async () => {
    const dispatcher = new StubDispatcher();
    await reconcileAgentTask(makeTask(), makeDeps(dispatcher));
    expect(dispatcher.published[0]?.originalUserMessage).toBe('fetch the docs and summarize');
  });

  it('preserves parentTaskId across delegation chains', async () => {
    const dispatcher = new StubDispatcher();
    await reconcileAgentTask(makeTask({ parentTask: 'parent-uid-9' }), makeDeps(dispatcher));
    expect(dispatcher.published[0]?.parentTaskId).toBe('parent-uid-9');
  });

  it('threads parentDistillation when supplied', async () => {
    const dispatcher = new StubDispatcher();
    await reconcileAgentTask(
      makeTask({ parentDistillation: 'distilled prompt' }),
      makeDeps(dispatcher),
    );
    expect(dispatcher.published[0]?.parentDistillation).toBe('distilled prompt');
  });

  it('threads expectedTools (F2 detector input)', async () => {
    const dispatcher = new StubDispatcher();
    await reconcileAgentTask(
      makeTask({ expectedTools: ['fetch_url', 'web_search'] }),
      makeDeps(dispatcher),
    );
    expect(dispatcher.published[0]?.expectedTools).toEqual(['fetch_url', 'web_search']);
  });

  it('taskId on the wire matches AgentTask.metadata.uid (NOT name)', async () => {
    const dispatcher = new StubDispatcher();
    await reconcileAgentTask(makeTask(), makeDeps(dispatcher));
    expect(dispatcher.published[0]?.taskId).toBe('task-uid-42');
    // metadata.name is 't1' — must NOT be the wire identifier (would
    // break uniqueness if two namespaces had AgentTasks with the same
    // name).
    expect(dispatcher.published[0]?.taskId).not.toBe('t1');
  });

  it('agentId on the wire matches the resolved Agent.metadata.name', async () => {
    const dispatcher = new StubDispatcher();
    await reconcileAgentTask(makeTask(), makeDeps(dispatcher));
    expect(dispatcher.published[0]?.agentId).toBe('researcher');
  });

  it('omits parentDistillation field entirely when unset (not undefined)', async () => {
    const dispatcher = new StubDispatcher();
    await reconcileAgentTask(makeTask(), makeDeps(dispatcher));
    expect('parentDistillation' in (dispatcher.published[0] ?? {})).toBe(false);
  });

  it('omits expectedTools field entirely when unset', async () => {
    const dispatcher = new StubDispatcher();
    await reconcileAgentTask(makeTask(), makeDeps(dispatcher));
    expect('expectedTools' in (dispatcher.published[0] ?? {})).toBe(false);
  });

  it('omits parentTaskId entirely on root tasks (no delegation)', async () => {
    const dispatcher = new StubDispatcher();
    await reconcileAgentTask(makeTask(), makeDeps(dispatcher));
    expect('parentTaskId' in (dispatcher.published[0] ?? {})).toBe(false);
  });

  it('payload rides verbatim (substrate is opaque to its content)', async () => {
    const dispatcher = new StubDispatcher();
    const complex = { topic: 'k3s', meta: { deadline: '2026-04-30', priority: 1 } };
    await reconcileAgentTask(makeTask({ payload: complex }), makeDeps(dispatcher));
    expect(dispatcher.published[0]?.payload).toEqual(complex);
  });
});
