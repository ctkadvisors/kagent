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

import { MAX_PAYLOAD_BYTES, validateCreateTaskBody } from './validators.js';

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
