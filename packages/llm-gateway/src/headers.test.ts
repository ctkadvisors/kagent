/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

import type { IncomingMessage } from 'node:http';
import { describe, expect, it } from 'vitest';

import { parseKagentHeaders } from './headers.js';

function fakeReq(headers: Record<string, string | string[] | undefined>): IncomingMessage {
  return { headers } as unknown as IncomingMessage;
}

describe('parseKagentHeaders', () => {
  it('returns null fields when headers absent', () => {
    expect(parseKagentHeaders(fakeReq({}))).toEqual({ taskUid: null, agentName: null });
  });

  it('reads both headers when present', () => {
    const r = parseKagentHeaders(
      fakeReq({ 'x-kagent-task-uid': 'uid-1', 'x-kagent-agent': 'researcher' }),
    );
    expect(r).toEqual({ taskUid: 'uid-1', agentName: 'researcher' });
  });

  it('trims whitespace and treats empty string as null', () => {
    const r = parseKagentHeaders(
      fakeReq({ 'x-kagent-task-uid': '   ', 'x-kagent-agent': '  a  ' }),
    );
    expect(r).toEqual({ taskUid: null, agentName: 'a' });
  });

  it('handles array-shaped header (uses first element)', () => {
    const r = parseKagentHeaders(fakeReq({ 'x-kagent-task-uid': ['uid-1', 'uid-2'] }));
    expect(r.taskUid).toBe('uid-1');
  });
});
