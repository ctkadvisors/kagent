/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * H16 regression tests for the POST /api/tasks payload size cap.
 *
 * The payload field is a structurally opaque JSON blob that flows
 * straight into AgentTask.spec.payload. Without a cap a single POST
 * could request a multi-megabyte CR write that subsequently fails
 * apiserver admission (or worse, succeeds and OOMs the agent-pod
 * loading the spec). The cap mirrors the LLM gateway's MAX_BODY_BYTES.
 */

import { describe, expect, it } from 'vitest';

import { MAX_PAYLOAD_BYTES, validateCreateTaskBody, validateReplayOf } from './validators.js';
import type { ValidationError } from './validators.js';

const baseBody = {
  targetAgent: 'researcher',
  originalUserMessage: 'hello',
};

describe('validateCreateTaskBody — payload size cap (H16)', () => {
  it('accepts an absent payload', () => {
    const r = validateCreateTaskBody({ ...baseBody });
    expect(r.valid).toBe(true);
  });

  it('accepts a small payload', () => {
    const r = validateCreateTaskBody({ ...baseBody, payload: { topic: 'kagent' } });
    expect(r.valid).toBe(true);
    expect(r.value?.payload).toEqual({ topic: 'kagent' });
  });

  it('accepts a payload at the 64 KiB boundary', () => {
    // Build a payload whose JSON serialisation is at most MAX_PAYLOAD_BYTES.
    // We pad a single string field to fit precisely.
    const wrapper = { data: '' };
    const overhead = Buffer.byteLength(JSON.stringify(wrapper), 'utf8');
    const fillLen = MAX_PAYLOAD_BYTES - overhead;
    wrapper.data = 'a'.repeat(fillLen);
    expect(Buffer.byteLength(JSON.stringify(wrapper), 'utf8')).toBe(MAX_PAYLOAD_BYTES);
    const r = validateCreateTaskBody({ ...baseBody, payload: wrapper });
    expect(r.valid).toBe(true);
  });

  it('rejects a payload larger than 64 KiB with payload-too-large code', () => {
    const wrapper = { data: 'a'.repeat(70_000) };
    const r = validateCreateTaskBody({ ...baseBody, payload: wrapper });
    expect(r.valid).toBe(false);
    const err = r.errors.find((e) => e.code === 'payload-too-large');
    expect(err).toBeDefined();
    if (err && err.code === 'payload-too-large') {
      expect(err.field).toBe('payload');
      expect(err.maxBytes).toBe(MAX_PAYLOAD_BYTES);
      expect(err.actualBytes).toBeGreaterThan(MAX_PAYLOAD_BYTES);
    }
  });

  it('rejects a circular payload as wrong-type rather than crashing', () => {
    const circ: { self?: unknown } = {};
    circ.self = circ;
    const r = validateCreateTaskBody({ ...baseBody, payload: circ });
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => e.code === 'wrong-type' && e.field === 'payload')).toBe(true);
  });
});

/**
 * Phase 5 / WB-03 — validateReplayOf unit tests.
 *
 * Each test uses a fresh `errors` accumulator to mirror real-world usage:
 * the caller initializes an empty array and passes it in; the helper
 * pushes per-field errors and returns the typed value or undefined.
 */
describe('validateReplayOf', () => {
  /** Helper: create a fresh accumulator for each test. */
  const fresh = (): ValidationError[] => [];

  /** Minimal valid input for happy-path tests. */
  const validInput = {
    taskRef: {
      namespace: 'default',
      name: 'task-abc',
    },
  };

  it('valid input returns ReplayOfReference with empty errors', () => {
    const errors = fresh();
    const result = validateReplayOf(validInput, errors);
    expect(errors).toHaveLength(0);
    expect(result).toBeDefined();
    expect(result?.taskRef.namespace).toBe('default');
    expect(result?.taskRef.name).toBe('task-abc');
    expect(result?.taskRef.uid).toBeUndefined();
    expect(result?.reason).toBeUndefined();
  });

  it('valid input with uid and reason returns full ReplayOfReference', () => {
    const errors = fresh();
    const result = validateReplayOf(
      {
        taskRef: {
          namespace: 'kagent-system',
          name: 'task-xyz',
          uid: '00000000-0000-4000-8000-000000000000',
        },
        reason: 'testing replay path',
      },
      errors,
    );
    expect(errors).toHaveLength(0);
    expect(result?.taskRef.uid).toBe('00000000-0000-4000-8000-000000000000');
    expect(result?.reason).toBe('testing replay path');
  });

  it('non-object root pushes wrong-type error', () => {
    const errors = fresh();
    const result = validateReplayOf('not-an-object', errors);
    expect(result).toBeUndefined();
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ code: 'wrong-type', field: 'replayOf' });
  });

  it('missing taskRef.namespace pushes missing error', () => {
    const errors = fresh();
    const result = validateReplayOf({ taskRef: { name: 'task-abc' } }, errors);
    expect(result).toBeUndefined();
    expect(
      errors.some((e) => e.code === 'missing' && e.field === 'replayOf.taskRef.namespace'),
    ).toBe(true);
  });

  it('non-RFC1123 namespace pushes invalid-name error', () => {
    const errors = fresh();
    const result = validateReplayOf(
      { taskRef: { namespace: 'UPPER_CASE', name: 'task-abc' } },
      errors,
    );
    expect(result).toBeUndefined();
    expect(
      errors.some((e) => e.code === 'invalid-name' && e.field === 'replayOf.taskRef.namespace'),
    ).toBe(true);
  });

  it('missing taskRef.name pushes missing error', () => {
    const errors = fresh();
    const result = validateReplayOf({ taskRef: { namespace: 'default' } }, errors);
    expect(result).toBeUndefined();
    expect(errors.some((e) => e.code === 'missing' && e.field === 'replayOf.taskRef.name')).toBe(
      true,
    );
  });

  it('non-UUID uid pushes invalid-name error', () => {
    const errors = fresh();
    const result = validateReplayOf(
      { taskRef: { namespace: 'default', name: 'task-abc', uid: 'not-a-uuid' } },
      errors,
    );
    expect(result).toBeUndefined();
    expect(
      errors.some((e) => e.code === 'invalid-name' && e.field === 'replayOf.taskRef.uid'),
    ).toBe(true);
  });

  it('reason exceeding 256 bytes pushes too-long error', () => {
    const errors = fresh();
    // 257 ASCII characters = 257 bytes UTF-8 > 256 byte cap.
    const longReason = 'a'.repeat(257);
    const result = validateReplayOf({ ...validInput, reason: longReason }, errors);
    expect(result).toBeUndefined();
    expect(errors.some((e) => e.code === 'too-long' && e.field === 'replayOf.reason')).toBe(true);
  });

  it('reason with newline character pushes invalid-name error', () => {
    const errors = fresh();
    const result = validateReplayOf({ ...validInput, reason: 'line1\nline2' }, errors);
    expect(result).toBeUndefined();
    expect(errors.some((e) => e.code === 'invalid-name' && e.field === 'replayOf.reason')).toBe(
      true,
    );
  });

  it('reason with carriage return pushes invalid-name error', () => {
    const errors = fresh();
    const result = validateReplayOf({ ...validInput, reason: 'line1\rline2' }, errors);
    expect(result).toBeUndefined();
    expect(errors.some((e) => e.code === 'invalid-name' && e.field === 'replayOf.reason')).toBe(
      true,
    );
  });
});
