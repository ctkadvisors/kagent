/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

import { describe, expect, it } from 'vitest';

import type { ReviewReason } from '@kagent/dto/review-queue';
import { ALL_EVENT_TYPES, TASK_REPLAY_CREATED } from './event-types.js';
import type {
  AuditEventData,
  ReviewAcceptedData,
  ReviewRejectedData,
  TaskReplayCreatedData,
} from './types.js';

describe('ReviewReason ↔ Review*Data.reason structural pin (CR-03)', () => {
  it('ReviewAcceptedData.reason is assignable from ReviewReason (and back)', () => {
    // Direction 1: any ReviewReason is a valid ReviewAcceptedData.reason.
    const _a: ReviewAcceptedData['reason'] = '' as unknown as ReviewReason;
    // Direction 2: any ReviewAcceptedData.reason is a valid ReviewReason.
    const _b: ReviewReason = '' as unknown as ReviewAcceptedData['reason'];
    // Suppress unused-variable lints — the assignments above are the assertion.
    void _a;
    void _b;
  });

  it('ReviewRejectedData.reason is assignable from ReviewReason (and back)', () => {
    const _a: ReviewRejectedData['reason'] = '' as unknown as ReviewReason;
    const _b: ReviewReason = '' as unknown as ReviewRejectedData['reason'];
    void _a;
    void _b;
  });
});

describe('ALL_EVENT_TYPES catalog (Phase 5 / WB-03)', () => {
  it('catalog contains 54 entries after adding task.replay.created', () => {
    expect(ALL_EVENT_TYPES).toHaveLength(54);
  });

  it('catalog contains TASK_REPLAY_CREATED', () => {
    expect(ALL_EVENT_TYPES).toContain(TASK_REPLAY_CREATED);
  });
});

describe('TaskReplayCreatedData type cross-check (WB-03)', () => {
  it('TaskReplayCreatedData is a valid AuditEventData member (compile-time pin)', () => {
    // Type-only assignment — if AuditEventData union is missing the member, tsc errors here.
    const _typeCrossCheck: AuditEventData = {
      type: 'task.replay.created',
      data: {
        newTaskRef: {
          namespace: 'default',
          name: 'task-new',
          uid: '00000000-0000-0000-0000-000000000000',
        },
        originalTaskRef: {
          namespace: 'default',
          name: 'task-orig',
          uid: '00000000-0000-0000-0000-000000000001',
        },
      } satisfies TaskReplayCreatedData,
    };
    void _typeCrossCheck;
  });
});
