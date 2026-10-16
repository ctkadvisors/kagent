/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

import { describe, expect, it } from 'vitest';

import { OPERATOR_INPUT_ANNOTATION, buildOperatorInputPoller } from './operator-input.js';

describe('buildOperatorInputPoller', () => {
  it('delivers each appended operator row exactly once', async () => {
    let annotations: Record<string, string> = {};
    const poll = buildOperatorInputPoller(() => Promise.resolve({ metadata: { annotations } }));
    expect(await poll()).toEqual([]);
    annotations = { [OPERATOR_INPUT_ANNOTATION]: JSON.stringify([{ id: 'a', text: 'first' }]) };
    expect(await poll()).toEqual(['first']);
    expect(await poll()).toEqual([]);
    annotations = {
      [OPERATOR_INPUT_ANNOTATION]: JSON.stringify([
        { id: 'a', text: 'first' },
        { id: 'b', text: 'second' },
        { id: 'c', text: 'third' },
      ]),
    };
    expect(await poll()).toEqual(['second', 'third']);
  });

  it('rejects an unreadable annotation so the loop logs and skips it', async () => {
    const poll = buildOperatorInputPoller(() =>
      Promise.resolve({ metadata: { annotations: { [OPERATOR_INPUT_ANNOTATION]: '{not json' } } }),
    );
    await expect(poll()).rejects.toThrow();
  });
});
