/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

import type { MockInstance } from 'vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { buildHandler } from './main.js';
import { StubDispatcher } from './dispatcher.js';
import { API_GROUP_VERSION, type AgentTask } from './crds/index.js';

describe('buildHandler (Phase 2 C3 stub)', () => {
  let logSpy: MockInstance<typeof console.log>;
  let errSpy: MockInstance<typeof console.error>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    logSpy.mockRestore();
    errSpy.mockRestore();
  });

  const sampleTask: AgentTask = {
    apiVersion: API_GROUP_VERSION,
    kind: 'AgentTask',
    metadata: { name: 't1', namespace: 'default', uid: 'u-1' },
    spec: { targetAgent: 'researcher', payload: { topic: 'k3s' } },
  };

  it('onAdd logs the task ns/name', async () => {
    const h = buildHandler(new StubDispatcher());
    await h.onAdd(sampleTask);
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('add AgentTask default/t1'));
  });

  it('onUpdate includes the phase in the log', async () => {
    const h = buildHandler(new StubDispatcher());
    await h.onUpdate({ ...sampleTask, status: { phase: 'Dispatched' } });
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('phase=Dispatched'));
  });

  it('onDelete logs', async () => {
    const h = buildHandler(new StubDispatcher());
    await h.onDelete(sampleTask);
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('delete AgentTask default/t1'));
  });

  it('onError surfaces the underlying error to console.error', () => {
    const h = buildHandler(new StubDispatcher());
    const boom = new Error('watch broke');
    h.onError?.(boom);
    expect(errSpy).toHaveBeenCalledWith('[kagent-operator] watch error:', boom);
  });
});
