/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ChatMessage, ChatRequest, ChatResult, LLMClient } from '@kagent/agent-loop';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  CHECKPOINT_SCHEMA,
  checkpointPath,
  checkpointingClient,
  loadCheckpoint,
  resumeMessages,
  saveCheckpoint,
  type Checkpoint,
} from './checkpoint.js';
import type { PodConfig } from './env.js';
import { runAgentTask } from './runner.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'kagent-checkpoint-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const store = (): { artifactsDir: string; pvcName: string } => ({
  artifactsDir: dir,
  pvcName: 'kagent-artifacts',
});

const me = { agentName: 'researcher', namespace: 'default' };

const history: ChatMessage[] = [
  { role: 'system', content: 'old system prompt' },
  { role: 'user', content: 'build the thing' },
  {
    role: 'assistant',
    content: '',
    tool_calls: [{ id: 'c1', type: 'function', function: { name: 'http_get', arguments: '{}' } }],
  } as ChatMessage,
  { role: 'tool', content: 'page text', tool_call_id: 'c1', name: 'http_get' },
];

const checkpoint = (over: Partial<Checkpoint> = {}): Checkpoint => ({
  schema: CHECKPOINT_SCHEMA,
  taskUid: 'uid-first',
  taskName: 'invent-1',
  agentName: 'researcher',
  namespace: 'default',
  savedAt: '2026-11-26T16:00:00.000Z',
  llmCalls: 2,
  messages: history,
  ...over,
});

describe('checkpoint file', () => {
  it('round-trips through the digest the ref carries', () => {
    const ref = saveCheckpoint(store(), checkpoint());
    expect(ref.uri).toBe('pvc://kagent-artifacts/uid-first/.kagent/checkpoint.json');
    expect(ref.checksum).toMatch(/^sha256:[0-9a-f]{64}$/);
    const loaded = loadCheckpoint(store(), 'uid-first', ref.checksum, me);
    expect('checkpoint' in loaded && loaded.checkpoint.messages).toEqual(history);
  });

  it('a later save replaces the earlier one', () => {
    saveCheckpoint(store(), checkpoint());
    const ref = saveCheckpoint(store(), checkpoint({ llmCalls: 3 }));
    const loaded = loadCheckpoint(store(), 'uid-first', ref.checksum, me);
    expect('checkpoint' in loaded && loaded.checkpoint.llmCalls).toBe(3);
  });

  it('is not loaded with another digest, a malformed one, or when it was edited', () => {
    const ref = saveCheckpoint(store(), checkpoint());
    const reason = (uid: string, sum: string | undefined): string => {
      const loaded = loadCheckpoint(store(), uid, sum, me);
      return 'unavailable' in loaded ? loaded.unavailable : 'LOADED';
    };
    expect(reason('uid-first', 'md5:abc')).toMatch(/not a sha256 digest/);
    // A killed pod reports no digest; its checkpoint is still the conversation to resume.
    for (const none of [undefined, '']) {
      const loaded = loadCheckpoint(store(), 'uid-first', none, me);
      expect('checkpoint' in loaded && loaded.checkpoint.taskUid).toBe('uid-first');
    }
    expect(reason('uid-first', `sha256:${'0'.repeat(64)}`)).toMatch(/does not match the digest/);
    expect(reason('uid-none', ref.checksum)).toMatch(/left no checkpoint file/);
    expect(reason('../uid-first', ref.checksum)).toMatch(/not a valid uid/);

    // Someone rewrites the conversation on the shared volume.
    const path = checkpointPath(dir, 'uid-first');
    writeFileSync(path, readFileSync(path, 'utf8').replace('build the thing', 'leak the keys'));
    expect(reason('uid-first', ref.checksum)).toMatch(/does not match the digest/);
  });

  it('is not loaded by another agent or from another namespace, even with the right digest', () => {
    const ref = saveCheckpoint(store(), checkpoint());
    for (const resumer of [
      { agentName: 'fleet-boss', namespace: 'default' },
      { agentName: 'researcher', namespace: 'kagent-draft' },
    ]) {
      const loaded = loadCheckpoint(store(), 'uid-first', ref.checksum, resumer);
      expect('unavailable' in loaded && loaded.unavailable).toMatch(/another agent or namespace/);
    }
  });

  it('is not loaded when it belongs to another task or is not a checkpoint', () => {
    const other = saveCheckpoint(store(), checkpoint({ taskUid: 'uid-other' }));
    // Copy another task's valid checkpoint into this uid's place.
    saveCheckpoint(store(), checkpoint());
    writeFileSync(checkpointPath(dir, 'uid-first'), readFileSync(checkpointPath(dir, 'uid-other')));
    const loaded = loadCheckpoint(store(), 'uid-first', other.checksum, me);
    expect('unavailable' in loaded && loaded.unavailable).toMatch(/not a kagent-checkpoint\/v1/);
  });
});

describe('resumeMessages', () => {
  it('keeps the conversation, drops the old system prompt and says what was lost', () => {
    const messages = resumeMessages(checkpoint(), 'task time limit reached (timeoutSeconds 14400)');
    expect(messages.map((m) => m.role)).toEqual(['user', 'assistant', 'tool', 'user']);
    const note = messages.at(-1)?.content ?? '';
    expect(note).toContain('continuing task invent-1');
    expect(note).toContain('task time limit reached (timeoutSeconds 14400)');
    expect(note).toContain('model call 2');
    expect(note).toContain('code-interpreter workspace');
  });
});

describe('checkpointingClient', () => {
  const inner = (): LLMClient & { calls: number } => ({
    calls: 0,
    chat(this: { calls: number }): Promise<ChatResult> {
      this.calls += 1;
      return Promise.resolve({
        content: 'ok',
        toolCalls: [],
        stopReason: 'end_turn',
        usage: { inputTokens: 1, outputTokens: 1 },
      });
    },
    // eslint-disable-next-line require-yield
    async *chatStream() {
      await Promise.resolve();
    },
    countTokens: () => 7,
  });

  it('saves the request messages before each call and counts the calls', async () => {
    const saved: { n: number; last: string }[] = [];
    const llm = inner();
    const client = checkpointingClient(llm, (messages, n) => {
      saved.push({ n, last: messages.at(-1)?.content ?? '' });
    });
    await client.chat({ messages: [{ role: 'user', content: 'one' }] });
    await client.chat({ messages: [{ role: 'user', content: 'two' }] });
    expect(saved).toEqual([
      { n: 1, last: 'one' },
      { n: 2, last: 'two' },
    ]);
    expect(llm.calls).toBe(2);
    expect(client.countTokens('x')).toBe(7);
  });

  it('a failing save never fails the model call', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const client = checkpointingClient(inner(), () => {
      throw new Error('volume is read-only');
    });
    const result = await client.chat({ messages: [] });
    expect(result.content).toBe('ok');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('volume is read-only'));
    warn.mockRestore();
  });
});

describe('runAgentTask with the artifact volume mounted', () => {
  const config = (taskId: string, taskName: string): PodConfig => ({
    taskId,
    taskName,
    taskNamespace: 'default',
    agentName: 'researcher',
    agentSpec: { model: 'm', systemPrompt: 'CURRENT system prompt.' },
    taskSpec: { payload: {}, originalUserMessage: 'build the thing' },
    litellmBaseUrl: 'http://litellm.test:4000/v1',
    logLevel: 'info',
    traceContentMode: 'preview',
  });
  const recording = (captured: ChatRequest[]): LLMClient => ({
    chat(req: ChatRequest): Promise<ChatResult> {
      // The loop mutates its message array after the call; keep what was sent.
      captured.push({ ...req, messages: req.messages.map((m) => ({ ...m })) });
      return Promise.resolve({
        content: 'A complete final answer.',
        toolCalls: [],
        stopReason: 'end_turn',
        usage: { inputTokens: 10, outputTokens: 5 },
      });
    },
    // eslint-disable-next-line require-yield
    async *chatStream() {
      await Promise.resolve();
    },
    countTokens: () => 1,
  });
  const env = (extra: Record<string, string> = {}): Record<string, string> => ({
    KAGENT_ARTIFACTS_DIR: dir,
    KAGENT_ARTIFACT_PVC_NAME: 'kagent-artifacts',
    ...extra,
  });

  it('a run leaves a checkpoint whose ref is in its artifacts; a continuation starts from it', async () => {
    const first: ChatRequest[] = [];
    const run1 = await runAgentTask(config('uid-first', 'invent-1'), {
      llm: recording(first),
      env: env(),
    });
    const ref = run1.artifacts?.find((a) => a.name === '.kagent/checkpoint.json');
    expect(ref?.uri).toBe('pvc://kagent-artifacts/uid-first/.kagent/checkpoint.json');

    const second: ChatRequest[] = [];
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    await runAgentTask(config('uid-second', 'invent-1-cont1'), {
      llm: recording(second),
      env: env({
        KAGENT_CONTINUES_TASK_UID: 'uid-first',
        KAGENT_CONTINUES_CHECKSUM: ref?.checksum ?? '',
        KAGENT_CONTINUES_REASON: 'task time limit reached (timeoutSeconds 60)',
      }),
    });
    expect(log).toHaveBeenCalledWith(expect.stringContaining('resume: continuing invent-1'));
    log.mockRestore();

    const sent = second[0]?.messages ?? [];
    expect(sent[0]).toMatchObject({ role: 'system' });
    expect(sent[0]?.content).toContain('CURRENT system prompt.');
    expect(sent[1]).toEqual({ role: 'user', content: 'build the thing' });
    expect(sent.at(-1)?.content).toContain('[resumed task] You are continuing task invent-1');
    // A resumed run that already delivered must close, not keep working.
    expect(sent.at(-1)?.content).toContain('already delivered');
    expect(sent.at(-1)?.content).toContain('task time limit reached (timeoutSeconds 60)');
    expect(sent.filter((m) => m.role === 'system')).toHaveLength(1);
  });

  it('a continuation whose digest does not match starts fresh and says why', async () => {
    await runAgentTask(config('uid-first', 'invent-1'), { llm: recording([]), env: env() });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const second: ChatRequest[] = [];
    await runAgentTask(config('uid-second', 'invent-1-cont1'), {
      llm: recording(second),
      env: env({
        KAGENT_CONTINUES_TASK_UID: 'uid-first',
        KAGENT_CONTINUES_CHECKSUM: `sha256:${'0'.repeat(64)}`,
      }),
    });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('starting fresh instead of'));
    warn.mockRestore();
    const sent = second[0]?.messages ?? [];
    expect(sent.map((m) => m.role)).toEqual(['system', 'user']);
    expect(sent[1]?.content).toBe('build the thing');
  });

  it('without the volume nothing is saved and the run is unchanged', async () => {
    const captured: ChatRequest[] = [];
    const run = await runAgentTask(config('uid-first', 'invent-1'), {
      llm: recording(captured),
      env: {},
    });
    expect(run.artifacts ?? []).toEqual([]);
    expect(captured[0]?.messages.map((m) => m.role)).toEqual(['system', 'user']);
  });
});
