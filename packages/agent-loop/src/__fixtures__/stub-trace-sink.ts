/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * Recording `TraceSink` for `AgentExecutor` unit tests. Per RESEARCH §8 Q6:
 * shipped as a fixture (not exported from the barrel).
 *
 * Consumed only by `*.test.ts` siblings — never re-exported from the
 * package barrel (Phase 2 D-21).
 */

import type { TraceEntry, TraceSink } from '../trace.js';

export interface RecordingSink extends TraceSink {
  /** All entries received via emit(), in order. */
  readonly entries: readonly TraceEntry[];
  /** Number of times flush() was called. */
  readonly flushCount: number;
}

/** Build a recording `TraceSink` that captures every emit() and flush(). */
export function makeRecordingSink(): RecordingSink {
  const entries: TraceEntry[] = [];
  let flushCount = 0;
  return {
    entries,
    get flushCount() {
      return flushCount;
    },
    emit(entry) {
      entries.push(entry);
    },
    flush(): Promise<void> {
      flushCount++;
      return Promise.resolve();
    },
  };
}
