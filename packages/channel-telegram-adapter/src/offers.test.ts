/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

import { describe, expect, it } from 'vitest';

import { withoutClosingOffer } from './outbound.js';

describe('closing offers', () => {
  it('drops a trailing offer to do what could have been done now', () => {
    expect(
      withoutClosingOffer(
        'Nothing is running. Budget 2/3.\n\nWant me to dig into why that stage got killed?',
      ),
    ).toBe('Nothing is running. Budget 2/3.');
    expect(withoutClosingOffer('Recorded (forum post 505). Shall I also post it as an idea?')).toBe(
      'Recorded (forum post 505).',
    );
    expect(withoutClosingOffer('Two options. Let me know if you would like me to open one?')).toBe(
      'Two options.',
    );
  });

  it('keeps questions that ask Chris for a decision, and a reply that is only the offer', () => {
    expect(withoutClosingOffer('Which PR do you mean: #35 or #96?')).toBe(
      'Which PR do you mean: #35 or #96?',
    );
    expect(withoutClosingOffer('Want me to open a change on one of them?')).toBe(
      'Want me to open a change on one of them?',
    );
    expect(withoutClosingOffer('Should I use the staging repo or prod? Tell me which.')).toBe(
      'Should I use the staging repo or prod? Tell me which.',
    );
  });
});
