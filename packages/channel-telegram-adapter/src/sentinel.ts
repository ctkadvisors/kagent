/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * The loop watches its own inputs (new_localai spec 2026-09-16 observed outcomes, principle 6).
 * Two checks that matter on this door: a bridge marker nested more than once (the
 * 2026-09-11 growth that ended in four days of HTTP 400) and a bloated envelope.
 * Deterministic; the caller strips to the raw text and warns instead of posting it.
 */
export const MARKERS = [
  '[current message]',
  '[fleet now]',
  '[earlier in this conversation]',
] as const;
export const HARD_CAP = 65_536;

export interface Finding {
  readonly check: 'nested_markers' | 'size';
  readonly evidence: string;
}

export function checkInbound(text: string): Finding | undefined {
  for (const m of MARKERS) {
    const n = text.split(m).length - 1;
    if (n > 1) {
      return {
        check: 'nested_markers',
        evidence: `${m} x${String(n)} in ${String(text.length)} chars`,
      };
    }
  }
  if (text.length > HARD_CAP) {
    return {
      check: 'size',
      evidence: `${String(text.length)} chars, above the hard cap ${String(HARD_CAP)}`,
    };
  }
  return undefined;
}
