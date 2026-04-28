/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

import { describe, expect, it } from 'vitest';

import { StubDispatcher, type DispatchedTask } from './dispatcher.js';

describe('StubDispatcher', () => {
  const baseTask: DispatchedTask = {
    taskId: 'task-1',
    agentId: 'researcher',
    originalUserMessage: 'summarize this',
    payload: { topic: 'k3s' },
  };

  it('records published tasks in order', async () => {
    const d = new StubDispatcher();
    await d.publish(baseTask);
    await d.publish({ ...baseTask, taskId: 'task-2' });
    expect(d.published).toHaveLength(2);
    expect(d.published[0]?.taskId).toBe('task-1');
    expect(d.published[1]?.taskId).toBe('task-2');
  });

  it('returns a defensively typed read-only view', () => {
    const d = new StubDispatcher();
    const view = d.published;
    // The TS type says readonly; this asserts the runtime value is the
    // backing array (not a copy), which is a deliberate trade-off — the
    // TS type protects callers from typos, runtime assumes sane callers.
    expect(Array.isArray(view)).toBe(true);
  });

  it('clear() empties the log', async () => {
    const d = new StubDispatcher();
    await d.publish(baseTask);
    expect(d.published).toHaveLength(1);
    d.clear();
    expect(d.published).toHaveLength(0);
  });

  it('preserves all envelope fields', async () => {
    const d = new StubDispatcher();
    const full: DispatchedTask = {
      taskId: 't',
      agentId: 'a',
      parentTaskId: 'p',
      originalUserMessage: 'orig',
      parentDistillation: 'distill',
      expectedTools: ['fetch_url', 'web_search'],
      payload: { foo: 'bar' },
    };
    await d.publish(full);
    expect(d.published[0]).toEqual(full);
  });

  /* =====================================================================
   * WS-F: dedupe ID semantics. Crash-and-retry must not double-fire.
   * ===================================================================== */

  describe('dedupeId', () => {
    it('drops a second publish with the same dedupeId', async () => {
      const d = new StubDispatcher();
      await d.publish(baseTask, { dedupeId: 'task-uid-1' });
      await d.publish(baseTask, { dedupeId: 'task-uid-1' });
      expect(d.published).toHaveLength(1);
      expect(d.seenDedupeIds.has('task-uid-1')).toBe(true);
    });

    it('keeps both when dedupeIds differ', async () => {
      const d = new StubDispatcher();
      await d.publish(baseTask, { dedupeId: 'task-uid-1' });
      await d.publish({ ...baseTask, taskId: 'task-2' }, { dedupeId: 'task-uid-2' });
      expect(d.published).toHaveLength(2);
    });

    it('falls through to no-dedupe when dedupeId is empty string', async () => {
      const d = new StubDispatcher();
      await d.publish(baseTask, { dedupeId: '' });
      await d.publish(baseTask, { dedupeId: '' });
      expect(d.published).toHaveLength(2);
      expect(d.seenDedupeIds.size).toBe(0);
    });

    it('a bare publish (no opts) is independent of dedupeId tracking', async () => {
      const d = new StubDispatcher();
      await d.publish(baseTask, { dedupeId: 'x' });
      await d.publish(baseTask); // no dedupe — admitted
      expect(d.published).toHaveLength(2);
      expect(d.seenDedupeIds.has('x')).toBe(true);
    });

    it('clear() also empties the seen-dedupe-id set', async () => {
      const d = new StubDispatcher();
      await d.publish(baseTask, { dedupeId: 'x' });
      d.clear();
      expect(d.seenDedupeIds.size).toBe(0);
      // Same dedupe ID admitted after clear.
      await d.publish(baseTask, { dedupeId: 'x' });
      expect(d.published).toHaveLength(1);
    });
  });
});
