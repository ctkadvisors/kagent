/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

import { describe, it } from 'vitest';

import type { ReviewReason } from '@kagent/dto/review-queue';
import type { ReviewAcceptedData, ReviewRejectedData } from './types.js';

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
