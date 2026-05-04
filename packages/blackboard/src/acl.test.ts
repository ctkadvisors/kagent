/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

import { describe, expect, it } from 'vitest';

import {
  checkAppendAllowed,
  checkListAllowed,
  checkReadAllowed,
  checkWriteAllowed,
  denyReasonToMessage,
} from './acl.js';

describe('checkReadAllowed', () => {
  it('rejects when claim is undefined', () => {
    expect(checkReadAllowed(undefined, 'foo')).toBe('no_blackboard_claim');
  });

  it('rejects when read patterns empty', () => {
    expect(checkReadAllowed({}, 'foo')).toBe('read_not_admitted');
    expect(checkReadAllowed({ read: [] }, 'foo')).toBe('read_not_admitted');
  });

  it('admits exact-match key', () => {
    expect(checkReadAllowed({ read: ['foo'] }, 'foo')).toBeNull();
  });

  it('admits glob-match key', () => {
    expect(checkReadAllowed({ read: ['findings.*'] }, 'findings.42')).toBeNull();
    expect(checkReadAllowed({ read: ['findings.*'] }, 'other.42')).toBe('read_not_admitted');
  });

  it('admits when full wildcard granted', () => {
    expect(checkReadAllowed({ read: ['*'] }, 'anything')).toBeNull();
  });
});

describe('checkWriteAllowed', () => {
  it('rejects when claim absent', () => {
    expect(checkWriteAllowed(undefined, 'foo')).toBe('no_blackboard_claim');
  });

  it('rejects when key not in write list', () => {
    expect(checkWriteAllowed({ write: ['mine.*'] }, 'theirs')).toBe('write_not_admitted');
  });

  it('admits matching key', () => {
    expect(checkWriteAllowed({ write: ['mine.*'] }, 'mine.42')).toBeNull();
  });
});

describe('checkListAllowed', () => {
  it('rejects when claim absent', () => {
    expect(checkListAllowed(undefined)).toBe('no_blackboard_claim');
  });

  it('rejects when read empty / unset', () => {
    expect(checkListAllowed({})).toBe('list_not_admitted');
    expect(checkListAllowed({ read: [] })).toBe('list_not_admitted');
  });

  it('admits when any read pattern present', () => {
    expect(checkListAllowed({ read: ['*'] })).toBeNull();
    expect(checkListAllowed({ read: ['foo'] })).toBeNull();
  });
});

describe('checkAppendAllowed', () => {
  it('requires both read and write admission', () => {
    expect(checkAppendAllowed(undefined, 'foo')).toBe('no_blackboard_claim');
    expect(checkAppendAllowed({ write: ['foo'] }, 'foo')).toBe('read_not_admitted');
    expect(checkAppendAllowed({ read: ['foo'] }, 'foo')).toBe('write_not_admitted');
    expect(checkAppendAllowed({ read: ['foo'], write: ['foo'] }, 'foo')).toBeNull();
  });

  it('rejects on read mismatch even when write admits', () => {
    expect(checkAppendAllowed({ read: ['only-read'], write: ['*'] }, 'foo')).toBe(
      'read_not_admitted',
    );
  });
});

describe('denyReasonToMessage', () => {
  it('returns a stable, distinct string per reason', () => {
    const seen = new Set<string>();
    for (const r of [
      'no_blackboard_claim',
      'read_not_admitted',
      'write_not_admitted',
      'list_not_admitted',
    ] as const) {
      const msg = denyReasonToMessage(r);
      expect(msg.length).toBeGreaterThan(0);
      seen.add(msg);
    }
    expect(seen.size).toBe(4);
  });
});
