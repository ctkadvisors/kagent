/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

import { describe, expect, it } from 'vitest';

import { buildCloudEvent, makeCloudEvent } from './make-event.js';

describe('makeCloudEvent', () => {
  it('stamps CE v1.0 conformant fields', () => {
    const event = makeCloudEvent(
      {
        type: 'research.findings',
        source: 'kagent.knuteson.io/agent-pod/researcher/abc123',
        subject: 'AgentTask/default/researcher-1',
        data: { foo: 'bar' },
      },
      {
        id: () => 'fixed-uuid-0',
        now: () => new Date('2026-05-04T12:00:00.000Z'),
      },
    );
    expect(event).toEqual({
      specversion: '1.0',
      id: 'fixed-uuid-0',
      type: 'research.findings',
      source: 'kagent.knuteson.io/agent-pod/researcher/abc123',
      subject: 'AgentTask/default/researcher-1',
      time: '2026-05-04T12:00:00.000Z',
      datacontenttype: 'application/json',
      data: { foo: 'bar' },
    });
  });

  it('OMITS subject field when undefined (does not emit empty string)', () => {
    const event = makeCloudEvent(
      {
        type: 'research.findings',
        source: 'kagent.knuteson.io/agent-pod/x/y',
        data: { foo: 'bar' },
      },
      {
        id: () => 'fixed-uuid-1',
        now: () => 0,
      },
    );
    expect('subject' in event).toBe(false);
  });

  it('rejects empty type / source', () => {
    expect(() => makeCloudEvent({ type: '', source: 'src', data: null })).toThrow(
      /non-empty string/,
    );
    expect(() => makeCloudEvent({ type: 'ok', source: '', data: null })).toThrow(
      /non-empty string/,
    );
  });

  it('produces RFC 3339 time from numeric epoch ms', () => {
    const event = makeCloudEvent(
      { type: 'a.b', source: 'src', data: 1 },
      { id: () => 'i', now: () => 0 },
    );
    expect(event.time).toBe('1970-01-01T00:00:00.000Z');
  });

  it('buildCloudEvent is an alias for makeCloudEvent', () => {
    const a = buildCloudEvent(
      { type: 'a.b', source: 'src', data: 1 },
      { id: () => 'x', now: () => 0 },
    );
    const b = makeCloudEvent(
      { type: 'a.b', source: 'src', data: 1 },
      { id: () => 'x', now: () => 0 },
    );
    expect(a).toEqual(b);
  });
});
