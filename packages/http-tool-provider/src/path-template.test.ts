/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * Pure-fn unit tests for substitutePath helper (D-07 path templating).
 *
 * 7 tests cover the RESEARCH §Path templating edge-case matrix:
 * happy path, multiple placeholders, encodeURIComponent for special
 * chars, numeric arg flattening (NOT empty string), boolean arg
 * flattening (NOT empty string), missing-key throw with key in message,
 * and the no-placeholder no-op identity case.
 */

import { describe, it, expect } from 'vitest';
import { substitutePath } from './path-template.js';
import { HttpToolProviderConfigError } from '@kagent/agent-loop';

describe('substitutePath', () => {
  it('Test 1 — happy path: single placeholder substituted', () => {
    expect(substitutePath('/users/{id}', { id: 42 })).toBe('/users/42');
  });

  it('Test 2 — multiple placeholders: all substituted', () => {
    expect(substitutePath('/repos/{owner}/{repo}', { owner: 'octocat', repo: 'hello' })).toBe(
      '/repos/octocat/hello',
    );
  });

  it('Test 3 — special chars: encodeURIComponent applied (path-traversal guard)', () => {
    expect(substitutePath('/q/{name}', { name: 'a/b c' })).toBe('/q/a%2Fb%20c');
    expect(substitutePath('/q/{name}', { name: '?&=#' })).toBe('/q/%3F%26%3D%23');
  });

  it('Test 4 — numeric arg: 0 → "0" (NOT empty string)', () => {
    expect(substitutePath('/n/{x}', { x: 0 })).toBe('/n/0');
  });

  it('Test 5 — boolean arg: false → "false" (NOT empty string)', () => {
    expect(substitutePath('/b/{x}', { x: false })).toBe('/b/false');
  });

  it('Test 6 — missing key throws HttpToolProviderConfigError with key name in message', () => {
    expect(() => substitutePath('/x/{missing}', {})).toThrow(HttpToolProviderConfigError);
    try {
      substitutePath('/x/{missing}', {});
      expect.fail('expected HttpToolProviderConfigError to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(HttpToolProviderConfigError);
      expect((err as Error).message).toContain('missing');
    }
  });

  it('Test 7 — no placeholders: returns input verbatim', () => {
    expect(substitutePath('/static', {})).toBe('/static');
  });
});
