/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

import { describe, expect, it } from 'vitest';

import { detectRefusal } from './refusal.js';

describe('detectRefusal', () => {
  it('returns null when sub-agent invoked at least one tool', () => {
    expect(detectRefusal('input is incomplete', 1)).toBeNull();
  });

  it('returns null on empty content', () => {
    expect(detectRefusal('', 0)).toBeNull();
  });

  it('returns null on long content (>= 200 chars)', () => {
    const long = 'a'.repeat(201);
    expect(detectRefusal(long, 0)).toBeNull();
  });

  it('matches "input is incomplete" verbatim', () => {
    expect(detectRefusal('Your input is incomplete. Please clarify.', 0)).toBe(
      'input is incomplete',
    );
  });

  it('matches "input is not sufficient" (Llama-Scout failure mode)', () => {
    expect(detectRefusal('Your input is not sufficient. Please provide more details.', 0)).toBe(
      'input is not sufficient',
    );
  });

  it('matches case-insensitively', () => {
    expect(detectRefusal('I CANNOT COMPLETE THIS request', 0)).toBe('cannot complete this');
  });

  it('matches both straight and curly apostrophes', () => {
    expect(detectRefusal("I don't have enough context", 0)).toBe("i don't have enough");
    expect(detectRefusal('I don’t have enough context', 0)).toBe('i don’t have enough');
  });

  it('returns null when no phrase matches', () => {
    expect(detectRefusal('The capital of France is Paris.', 0)).toBeNull();
  });
});
