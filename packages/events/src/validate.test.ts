/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

import { describe, expect, it } from 'vitest';

import {
  buildEventValidatorRegistry,
  isTopicAdmittedByPublishClaims,
  isTopicAdmittedBySubscribeClaims,
  publishesAreSubsetOfClaims,
  subscribesAreSubsetOfClaims,
  topicSubsetViolations,
} from './validate.js';

describe('isTopicAdmittedByPublishClaims', () => {
  it('admits topics matching a glob in the claims list', () => {
    expect(isTopicAdmittedByPublishClaims('research.findings', ['research.*'])).toBe(true);
    expect(isTopicAdmittedByPublishClaims('research.findings', ['*'])).toBe(true);
    expect(isTopicAdmittedByPublishClaims('research.findings', ['research.findings'])).toBe(true);
  });

  it('refuses topics outside the claims list', () => {
    expect(isTopicAdmittedByPublishClaims('research.findings', ['audit.*'])).toBe(false);
    expect(isTopicAdmittedByPublishClaims('research.findings', [])).toBe(false);
    expect(isTopicAdmittedByPublishClaims('research.findings', undefined)).toBe(false);
  });

  it('refuses malformed topics regardless of claims', () => {
    expect(isTopicAdmittedByPublishClaims('Research.findings', ['*'])).toBe(false);
    expect(isTopicAdmittedByPublishClaims('research.*', ['*'])).toBe(false);
    expect(isTopicAdmittedByPublishClaims('', ['*'])).toBe(false);
  });

  it('subscribe variant has same shape', () => {
    expect(isTopicAdmittedBySubscribeClaims('research.priorities', ['research.*'])).toBe(true);
    expect(isTopicAdmittedBySubscribeClaims('audit.task.completed', ['research.*'])).toBe(false);
  });
});

describe('publishesAreSubsetOfClaims', () => {
  it('returns no violations when every topic admitted', () => {
    const out = publishesAreSubsetOfClaims(
      ['research.findings', 'research.summaries'],
      ['research.*'],
    );
    expect(out).toEqual([]);
  });

  it('flags topics outside the claims list', () => {
    const out = publishesAreSubsetOfClaims(['research.findings', 'audit.foo'], ['research.*']);
    expect(out).toEqual([
      { category: 'publish', topic: 'audit.foo', reason: 'not_admitted_by_claims' },
    ]);
  });

  it('flags invalid topics distinctly', () => {
    const out = publishesAreSubsetOfClaims(['Research.findings', 'audit.*'], ['*']);
    expect(out).toEqual([
      { category: 'publish', topic: 'Research.findings', reason: 'invalid_topic' },
      { category: 'publish', topic: 'audit.*', reason: 'invalid_topic' },
    ]);
  });

  it('rejects everything when claims is empty / unset', () => {
    expect(publishesAreSubsetOfClaims(['a.b'], undefined)).toEqual([
      { category: 'publish', topic: 'a.b', reason: 'not_admitted_by_claims' },
    ]);
    expect(publishesAreSubsetOfClaims(['a.b'], [])).toEqual([
      { category: 'publish', topic: 'a.b', reason: 'not_admitted_by_claims' },
    ]);
  });

  it('subscribesAreSubsetOfClaims tags violations as subscribe', () => {
    const out = subscribesAreSubsetOfClaims(['research.findings'], ['audit.*']);
    expect(out[0]?.category).toBe('subscribe');
  });
});

describe('topicSubsetViolations', () => {
  it('combines publish + subscribe walks into one list', () => {
    const out = topicSubsetViolations({
      publishes: ['research.findings', 'audit.foo'],
      subscribes: ['research.priorities', 'tenant.b.*'],
      publishClaims: ['research.*'],
      subscribeClaims: ['research.*'],
    });
    expect(out).toEqual([
      { category: 'publish', topic: 'audit.foo', reason: 'not_admitted_by_claims' },
      { category: 'subscribe', topic: 'tenant.b.*', reason: 'invalid_topic' },
    ]);
  });

  it('returns [] when both lists are admitted', () => {
    const out = topicSubsetViolations({
      publishes: ['research.findings'],
      subscribes: ['research.priorities'],
      publishClaims: ['research.*'],
      subscribeClaims: ['research.*'],
    });
    expect(out).toEqual([]);
  });
});

describe('buildEventValidatorRegistry', () => {
  it('runs registered validator on matching topic', () => {
    const reg = buildEventValidatorRegistry();
    reg.set('research.findings', (data) => {
      const ok = typeof data === 'object' && data !== null && 'title' in data;
      return ok ? { ok: true } : { ok: false, error: 'missing title' };
    });
    expect(reg.has('research.findings')).toBe(true);
    expect(reg.validate('research.findings', { title: 'x' })).toEqual({ ok: true });
    expect(reg.validate('research.findings', { other: 'x' })).toEqual({
      ok: false,
      error: 'missing title',
    });
  });

  it('treats unregistered topics as unvalidated (ok: true)', () => {
    const reg = buildEventValidatorRegistry();
    expect(reg.validate('untouched.topic', { anything: true })).toEqual({ ok: true });
  });

  it('rejects registration with malformed topic', () => {
    const reg = buildEventValidatorRegistry();
    expect(() => {
      reg.set('Bad.Topic', () => ({ ok: true }));
    }).toThrow();
  });
});
