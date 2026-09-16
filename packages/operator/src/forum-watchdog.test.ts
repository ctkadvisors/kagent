/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * Tests for the forum watchdog — detects unanswered forum questions
 * past a threshold and writes a `00-forum-timeout.json` artifact.
 */

import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { ForumArtifact } from './forum-watchdog.js';
import {
  FORUM_TIMEOUT_ARTIFACT,
  checkForumTimeouts,
  MIN_THRESHOLD_MS,
  type ForumQuestion,
} from './forum-watchdog.js';

function forumDirWith(questionMsAgo: number, name = 'run-1.json'): string {
  const dir = mkdtempSync(join(tmpdir(), 'kagent-forum-watchdog-'));
  const q: ForumQuestion = {
    questionFile: name,
    timestamp: new Date(Date.now() - questionMsAgo).toISOString(),
  };
  writeFileSync(resolve(dir, name), JSON.stringify(q));
  return dir;
}

const FOUR_HOURS = 4 * 60 * 60 * 1000;
const FIVE_HOURS = 5 * 60 * 60 * 1000;

afterEach(() => {
  // Tests create their own temp dirs; nothing global to reset.
});

describe('checkForumTimeouts', () => {
  it('flags a question 5h old when the threshold is 4h, and writes the artifact', () => {
    const dir = forumDirWith(FIVE_HOURS);
    try {
      const res = checkForumTimeouts(dir, FOUR_HOURS, Date.now());
      expect(res.timedOut).toHaveLength(1);
      expect(res.timedOut[0]).toEqual(resolve(dir, 'run-1.json'));
      expect(res.artifacts).toHaveLength(1);
      const artifactPath = res.artifacts[0];
      expect(artifactPath.endsWith(`-${FORUM_TIMEOUT_ARTIFACT}`)).toBe(true);
      expect(existsSync(artifactPath)).toBe(true);
      const artifact = JSON.parse(readFileSync(artifactPath, 'utf8')) as ForumArtifact;
      expect(artifact.questionFile).toEqual(resolve(dir, 'run-1.json'));
      expect(typeof artifact.timestamp).toBe('string');
      expect(artifact.thresholdMs).toBe(FOUR_HOURS);
      expect(typeof artifact.detectedAt).toBe('string');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does not flag a question 3h old under a 4h threshold', () => {
    const dir = forumDirWith(3 * 60 * 60 * 1000);
    try {
      const res = checkForumTimeouts(dir, FOUR_HOURS, Date.now());
      expect(res.timedOut).toHaveLength(0);
      expect(res.artifacts).toHaveLength(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('ignores files with no parseable timestamp', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kagent-forum-watchdog-'));
    try {
      writeFileSync(resolve(dir, 'no-ts.json'), JSON.stringify({ questionFile: 'no-ts.json' }));
      const res = checkForumTimeouts(dir, FOUR_HOURS, Date.now());
      expect(res.timedOut).toHaveLength(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('ignores non-.json files', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kagent-forum-watchdog-'));
    try {
      writeFileSync(resolve(dir, 'note.txt'), 'not a question');
      const res = checkForumTimeouts(dir, FOUR_HOURS, Date.now());
      expect(res.timedOut).toHaveLength(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns an empty result when the forum directory does not exist', () => {
    const res = checkForumTimeouts('/workspace/p/forum/definitely-missing', FOUR_HOURS, Date.now());
    expect(res.timedOut).toHaveLength(0);
    expect(res.artifacts).toHaveLength(0);
  });

  it('refuses a threshold below the minimum', () => {
    expect(() => checkForumTimeouts('/tmp', MIN_THRESHOLD_MS - 1, Date.now())).toThrow();
  });

  /* =====================================================================
   * Regression guard — the watchdog must NOT re-read its own timeout
   * artifacts. A `00-forum-timeout.json` written beside a stale question
   * is metadata for the next reconcile, NOT a fresh question: re-reading
   * it would flag the artifact, write a SECOND artifact beside it, and
   * chain like `run-1-00-forum-timeout-00-forum-timeout.json` on every
   * subsequent sweep. The sweep is idempotent: repeated passes never
   * grow the timed-out set or the artifact count.
   * ===================================================================== */

  it('does NOT re-read its own 00-forum-timeout.json artifact (no chained artifacts) across repeated sweeps', () => {
    const dir = forumDirWith(FIVE_HOURS);
    try {
      const first = checkForumTimeouts(dir, FOUR_HOURS, Date.now());
      expect(first.timedOut).toHaveLength(1);
      expect(first.timedOut[0]).toEqual(resolve(dir, 'run-1.json'));
      expect(first.artifacts).toHaveLength(1);
      expect(first.artifacts[0]).toEqual(resolve(dir, 'run-1-00-forum-timeout.json'));
      expect(existsSync(resolve(dir, 'run-1-00-forum-timeout.json'))).toBe(true);

      // Second + third sweep: the artifact is ignored, so nothing new is
      // flagged or written — the sweep is idempotent.
      const second = checkForumTimeouts(dir, FOUR_HOURS, Date.now());
      expect(second.timedOut).toHaveLength(1);
      expect(second.timedOut[0]).toEqual(resolve(dir, 'run-1.json'));
      expect(second.artifacts).toHaveLength(1);
      expect(second.artifacts[0]).toEqual(resolve(dir, 'run-1-00-forum-timeout.json'));

      const third = checkForumTimeouts(dir, FOUR_HOURS, Date.now());
      expect(third.timedOut).toHaveLength(1);
      expect(third.artifacts).toHaveLength(1);

      // Exactly two JSON files in the directory: the original question
      // and its ONE artifact — never a chained artifact.
      const jsonFiles = readdirSync(dir).filter((f) => f.endsWith('.json')).sort();
      expect(jsonFiles).toEqual(['run-1-00-forum-timeout.json', 'run-1.json'].sort());
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
