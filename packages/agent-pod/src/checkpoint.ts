/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * Task checkpoints: a run that stops at its time limit, its iteration
 * cap or a killed pod can be continued by a later task instead of
 * starting over.
 *
 * What is saved is the conversation as it stood before each model call:
 * exactly the messages the loop was about to send. That state is always
 * a valid place to resume (every tool call in it has its result), it is
 * already compacted to fit the window, and capturing it needs nothing
 * from the loop: `checkpointingClient` wraps the `LLMClient` the runner
 * hands the executor. At most one model call and its tool calls are
 * repeated after a resume.
 *
 * The file is `<artifacts>/<task-uid>/.kagent/checkpoint.json`, a path
 * no tool can read or write (`RESERVED_DIR` in artifacts.ts). Its ref
 * rides in `AgentTask.status.artifacts`, so the operator knows its
 * sha256; a continuation loads a checkpoint only when the bytes match
 * the digest the operator passed it.
 *
 * What a resume does not carry: the code-interpreter sandbox (a new
 * task gets a new, empty workspace), and the loop's iteration and token
 * counters (the continuation has its own budget).
 */

import { createHash } from 'node:crypto';
import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeSync,
} from 'node:fs';
import { dirname, resolve } from 'node:path';

import type { ChatMessage, LLMClient } from '@kagent/agent-loop';

import { buildPvcUri, RESERVED_DIR, type ArtifactRef } from './artifacts.js';

export const CHECKPOINT_SCHEMA = 'kagent-checkpoint/v1';
export const CHECKPOINT_NAME = `${RESERVED_DIR}/checkpoint.json`;
export const CHECKPOINT_MEDIA_TYPE = 'application/x-kagent-checkpoint+json';
/** A conversation that fits a model window is far below this; a larger file is not loaded. */
export const CHECKPOINT_MAX_BYTES = 16 * 1024 * 1024;

export interface Checkpoint {
  readonly schema: typeof CHECKPOINT_SCHEMA;
  readonly taskUid: string;
  readonly taskName: string;
  readonly savedAt: string;
  /** Model calls the run had started when this was saved (1 = the first). */
  readonly llmCalls: number;
  readonly messages: readonly ChatMessage[];
}

export interface CheckpointStore {
  readonly artifactsDir: string;
  readonly pvcName: string;
}

export function checkpointPath(artifactsDir: string, taskUid: string): string {
  return resolve(artifactsDir, taskUid, CHECKPOINT_NAME);
}

/** Write the checkpoint atomically and return the ref for `status.artifacts`. */
export function saveCheckpoint(store: CheckpointStore, checkpoint: Checkpoint): ArtifactRef {
  const bytes = Buffer.from(JSON.stringify(checkpoint), 'utf8');
  const target = checkpointPath(store.artifactsDir, checkpoint.taskUid);
  mkdirSync(dirname(target), { recursive: true });
  const tmp = `${target}.tmp`;
  const fd = openSync(tmp, 'w');
  try {
    writeSync(fd, bytes, 0, bytes.byteLength, 0);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, target);
  const hex = createHash('sha256').update(bytes).digest('hex');
  return {
    uri: buildPvcUri(store.pvcName, checkpoint.taskUid, CHECKPOINT_NAME),
    name: CHECKPOINT_NAME,
    mediaType: CHECKPOINT_MEDIA_TYPE,
    sizeBytes: bytes.byteLength,
    checksum: `sha256:${hex}`,
    contentHash: hex,
    producedAt: checkpoint.savedAt,
  };
}

export type LoadedCheckpoint =
  | { readonly checkpoint: Checkpoint }
  | { readonly unavailable: string };

/**
 * Load the checkpoint of `taskUid`, only if its bytes hash to
 * `expectedChecksum` (`sha256:<hex>`, from the operator). Every other
 * outcome is `unavailable` with the reason; the caller starts fresh.
 */
export function loadCheckpoint(
  store: CheckpointStore,
  taskUid: string,
  expectedChecksum: string | undefined,
): LoadedCheckpoint {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(taskUid) || taskUid.includes('..')) {
    return { unavailable: 'the task uid to continue is not a valid uid' };
  }
  if (expectedChecksum === undefined || !/^sha256:[0-9a-f]{64}$/.test(expectedChecksum)) {
    return { unavailable: 'no checkpoint digest was recorded for the earlier task' };
  }
  let bytes: Buffer;
  try {
    bytes = readFileSync(checkpointPath(store.artifactsDir, taskUid));
  } catch {
    return { unavailable: 'the earlier task left no checkpoint file' };
  }
  if (bytes.byteLength > CHECKPOINT_MAX_BYTES) {
    return { unavailable: 'the checkpoint file is larger than a conversation can be' };
  }
  if (`sha256:${createHash('sha256').update(bytes).digest('hex')}` !== expectedChecksum) {
    return { unavailable: 'the checkpoint file does not match the digest the operator recorded' };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString('utf8'));
  } catch {
    return { unavailable: 'the checkpoint file is not JSON' };
  }
  const c = parsed as Partial<Checkpoint> | null;
  if (
    c === null ||
    typeof c !== 'object' ||
    c.schema !== CHECKPOINT_SCHEMA ||
    c.taskUid !== taskUid ||
    !Array.isArray(c.messages) ||
    !c.messages.every(isChatMessage)
  ) {
    return { unavailable: 'the checkpoint file is not a kagent-checkpoint/v1 for that task' };
  }
  return { checkpoint: c as Checkpoint };
}

function isChatMessage(value: unknown): value is ChatMessage {
  if (value === null || typeof value !== 'object') return false;
  const m = value as Record<string, unknown>;
  return (
    typeof m.content === 'string' &&
    (m.role === 'system' || m.role === 'user' || m.role === 'assistant' || m.role === 'tool')
  );
}

/**
 * The conversation a continuation starts from. The saved system message
 * is dropped so the Agent's current prompt applies, and one user message
 * says what happened and what did not carry over.
 */
export function resumeMessages(checkpoint: Checkpoint, why: string): ChatMessage[] {
  const history = checkpoint.messages.filter((m) => m.role !== 'system');
  return [
    ...history,
    {
      role: 'user',
      content:
        `[resumed task] You are continuing task ${checkpoint.taskName}, which stopped before it finished ` +
        `(${why}). Everything above is its saved conversation up to model call ${String(checkpoint.llmCalls)}; ` +
        'that call and anything after it were lost and are yours to redo. ' +
        'This is a new task with its own time and turn budget. ' +
        'Tool sandboxes did not carry over: files in the code-interpreter workspace that were not committed, ' +
        'posted or written with write_artifact are gone, so recreate what you still need. ' +
        'Do not start the work over. Continue from where it stopped and finish it.',
    },
  ];
}

/**
 * Wrap an `LLMClient` so the messages of every `chat` request are saved
 * before the call is made. A failed save is logged and never fails the
 * run: a checkpoint is a recovery aid, not part of the work.
 */
export function checkpointingClient(
  llm: LLMClient,
  save: (messages: readonly ChatMessage[], llmCalls: number) => void,
): LLMClient {
  let calls = 0;
  const wrapped: LLMClient = {
    chat: (request, ctx) => {
      calls += 1;
      try {
        save(request.messages, calls);
      } catch (err) {
        console.warn(
          `[kagent-agent-pod] checkpoint: save failed at model call ${String(calls)}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      return llm.chat(request, ctx);
    },
    chatStream: (request, ctx) => llm.chatStream(request, ctx),
    countTokens: (input) => llm.countTokens(input),
  };
  if (llm.embed !== undefined) {
    const embed = llm.embed.bind(llm);
    wrapped.embed = (input) => embed(input);
  }
  return wrapped;
}
