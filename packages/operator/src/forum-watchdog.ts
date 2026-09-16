/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * Forum watchdog — detects forum questions that have gone unanswered
 * long enough to be treated as *human latency* rather than letting the
 * owning run time out or halt on an ambiguous internal failure.
 *
 * Fleet agents post questions to `/workspace/p/forum/<runId>.json`.
 * Each question file carries a `timestamp` (RFC 3339) recording when it
 * was posted. When a human does not answer within the configured
 * threshold, the owning run cannot make progress and its failure would
 * otherwise be read as an agent error. This module scans the forum
 * directory for questions older than the threshold, writes a
 * `00-forum-timeout.json` artifact next to each stale question so there
 * is a durable record of the block, and returns the list so the caller
 * can flip the owning run's status to `halted-forum-wait` +
 * `human-latency` on its next reconcile.
 *
 * Wired into the operator's periodic sweep loop (see `main.ts`) so it
 * ticks on the same cadence as the rest of the substrate.
 */

import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

/** Shape of the minimal `timestamp` field the watchdog reads. */
export interface ForumQuestion {
  readonly questionFile?: string;
  readonly timestamp?: string;
  [key: string]: unknown;
}

/**
 * One question file the watchdog processed. `timedOut` is true when the
 * question's `timestamp` is older than the threshold relative to `now`.
 */
export interface ForumQuestionResult {
  readonly file: string;
  readonly timestamp?: string | undefined;
  readonly timedOut: boolean;
}

/**
 * Result of a single watchdog pass.
 */
export interface ForumTimeoutCheck {
  /** Files whose question is older than the threshold. */
  readonly timedOut: string[];
  /** Artifact paths written for each timed-out file. */
  readonly artifacts: string[];
}

/** Artifact file name written beside each stale question. */
export const FORUM_TIMEOUT_ARTIFACT = '00-forum-timeout.json';

/**
 * The `00-forum-timeout.json` artifact written beside a stale question.
 * Captures the block so the owning run can be archived under a
 * `human-latency` tag instead of a `system-failure` one.
 */
export interface ForumArtifact {
  readonly questionFile: string;
  readonly timestamp: string;
  readonly thresholdMs: number;
  readonly detectedAt: string;
}

/** Lower bound on a configured threshold. Exported so callers/tests can
 * refuse a smaller threshold rather than silently mis-sizing it. */
export const MIN_THRESHOLD_MS = 60 * 1000; // 1 minute

function parseTimestamp(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

/**
 * Read + validate the question files in a forum directory.
 * Tolerant of a missing directory (returns `[]`) and of individual
 * files that lack a usable `timestamp` (skipped, not failed) — a
 * malformed question is the human's problem to fix, not a watchdog
 * error.
 */
function readForumQuestions(forumDir: string): ForumQuestionResult[] {
  if (!existsSync(forumDir)) return [];
  const results: ForumQuestionResult[] = [];
  let entries: string[];
  try {
    entries = readdirSync(forumDir);
  } catch {
    return [];
  }
  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue;
    const file = resolve(forumDir, entry);
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8')) as ForumQuestion;
      results.push({ file, timestamp: parsed?.timestamp, timedOut: false });
    } catch {
      // Unparseable file — skip rather than abort the sweep.
    }
  }
  return results;
}

/**
 * Scan the forum directory for questions older than the threshold and,
 * for each, write a `00-forum-timeout.json` artifact capturing the
 * block so the owning run can be archived under a `human-latency` tag
 * instead of a `system-failure` one.
 *
 * @param forumDir path to the forum questions directory
 * @param thresholdMs questions older than this are considered timed out
 * @param now epoch milliseconds; injectable so tests are deterministic
 */
export function checkForumTimeouts(
  forumDir: string,
  thresholdMs: number,
  now: number = Date.now(),
): ForumTimeoutCheck {
  if (thresholdMs < MIN_THRESHOLD_MS) {
    throw new Error(
      `forum-watchdog: refusing to check with thresholdMs=${String(thresholdMs)} ` +
        `(minimum ${String(MIN_THRESHOLD_MS)}ms)`,
    );
  }
  const questions = readForumQuestions(forumDir);
  const timedOut: string[] = [];
  const artifacts: string[] = [];
  const detectedAt = new Date(now).toISOString();
  for (const q of questions) {
    const qMs = parseTimestamp(q.timestamp);
    if (qMs === null) continue;
    if (now - qMs < thresholdMs) continue;
    timedOut.push(q.file);
    const artifact: ForumArtifact = {
      questionFile: q.file,
      timestamp: q.timestamp ?? '',
      thresholdMs,
      detectedAt,
    };
    const artifactPath = `${q.file.replace(/\.json$/, '')}-${FORUM_TIMEOUT_ARTIFACT}`;
    writeFileSync(artifactPath, JSON.stringify(artifact, null, 2));
    artifacts.push(artifactPath);
  }
  return { timedOut, artifacts };
}
