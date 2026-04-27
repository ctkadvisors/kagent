/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * Neutral test fixtures for `AgentRegistry` unit tests.
 *
 * SC3-safe by construction: no identifier on the forbidden list from
 * VALIDATION.md SC3b appears here as a type-literal value or as prose.
 * The enumeration of forbidden words lives in VALIDATION.md; this file
 * intentionally does not restate it to avoid tripping the grep gate.
 *
 * Consumed only by `*.test.ts` siblings — never re-exported from the
 * package barrel (see D-21).
 */

import type { AgentDefinition } from '../types.js';

/** Neutral agent-type union — SC3-safe, test-only. */
export type MyType = 'chat' | 'research';

/** Neutral phase union — SC3-safe, test-only. */
export type MyPhase = 'intake' | 'triage' | 'resolution';

export const chatAgent: AgentDefinition<MyType, MyPhase> = {
  type: 'chat',
  name: 'Chat Agent',
  description: 'Conversational support across intake and triage.',
  version: '1.0.0',
  tags: ['conversational'],
  primaryPhases: ['intake', 'triage'],
  secondaryPhases: ['resolution'],
  baseConfidence: 0.82,
  skills: [
    {
      id: 'active_listening',
      name: 'Active Listening',
      description: 'Parse and summarize user utterances.',
      phases: ['intake'],
    },
    {
      id: 'issue_triage',
      name: 'Issue Triage',
      description: 'Sort incoming issues by severity.',
      phases: ['triage'],
    },
  ],
};

export const researchAgent: AgentDefinition<MyType, MyPhase> = {
  type: 'research',
  name: 'Research Agent',
  description: 'Deep-dive research during triage and resolution.',
  version: '1.0.0',
  primaryPhases: ['resolution'],
  secondaryPhases: ['triage'],
  baseConfidence: 0.78,
  skills: [
    {
      id: 'corpus_search',
      name: 'Corpus Search',
      description: 'Query the knowledge base.',
      phases: ['resolution'],
    },
    {
      id: 'synthesis',
      name: 'Synthesis',
      description: 'Combine findings.',
      phases: ['resolution'],
    },
  ],
};
