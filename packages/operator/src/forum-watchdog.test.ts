/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * Tests for the forum watchdog — detects unanswered forum questions
 * past a threshold and writes a `00-forum-timeout.json` artifact.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
});
