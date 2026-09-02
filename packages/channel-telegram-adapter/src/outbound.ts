/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

import type {
  AdapterLogger,
  AgentTask,
  ChannelOutboxStore,
  ChannelSession,
  ChannelTaskRef,
  TelegramAdapterConfig,
  TelegramClient,
} from './types.js';
import { channelTurnEpisode, writeBrainEpisode } from './brain.js';

const CHANNEL_MESSAGE_ANNOTATION = 'kagent.knuteson.io/channel-message';

export interface OutboundDeliveryStats {
  readonly delivered: number;
  readonly failed: number;
  readonly skipped: number;
}

const FAILURE_REPLY =
  "I couldn't complete that request. The task failed before returning an answer.";
const MAX_REPLY_CHARS = 4000;

export async function deliverOutboundTurns(input: {
  readonly config: TelegramAdapterConfig;
  readonly store: ChannelOutboxStore;
  readonly client: TelegramClient;
  readonly logger: AdapterLogger;
  readonly clock?: () => Date;
}): Promise<OutboundDeliveryStats> {
  const now = (input.clock ?? (() => new Date()))();
  const nowIso = now.toISOString();
  const sessions = await input.store.listChannelSessions({
    namespace: input.config.namespace,
    channelName: input.config.channelName,
    accountId: input.config.accountId,
  });

  let delivered = 0;
  let failed = 0;
  let skipped = 0;

  for (const session of sessions) {
    if (!sessionMatchesConfig(session, input.config) || shouldSkipSession(session, now)) {
      skipped += 1;
      continue;
    }

    const sessionName = session.metadata.name;
    const sessionNamespace = session.metadata.namespace ?? input.config.namespace;
    const taskRef = session.status?.lastTaskRef;
    if (sessionName === undefined || taskRef === undefined) {
      skipped += 1;
      continue;
    }
    if (sameTaskRef(session.status?.lastOutboundTaskRef, taskRef)) {
      skipped += 1;
      continue;
    }

    const task = await input.store.getAgentTask(taskRef);
    const reply = task === undefined ? undefined : replyTextForTask(task);
    if (reply === undefined) {
      skipped += 1;
      continue;
    }

    try {
      await input.client.sendMessage({ chatId: session.spec.peer.id, text: reply });
    } catch (err) {
      failed += 1;
      await patchSendFailure({
        config: input.config,
        store: input.store,
        session,
        sessionName,
        sessionNamespace,
        now,
      });
      input.logger.warn('[channel-telegram] outbound reply failed', {
        session: sessionName,
        task: taskRef.name,
        err,
      });
      continue;
    }

    try {
      await input.store.patchSessionStatus(sessionNamespace, sessionName, {
        phase: 'Active',
        lastOutboundAt: nowIso,
        lastOutboundTaskRef: taskRef,
        consecutiveFailures: 0,
        backoffUntil: null,
        lastFailureReason: null,
      });
      delivered += 1;
      input.logger.info('[channel-telegram] outbound reply delivered', {
        session: sessionName,
        task: taskRef.name,
      });
      if (task !== undefined) await rememberTurn(input, task, reply);
    } catch (err) {
      failed += 1;
      input.logger.error('[channel-telegram] failed to record outbound delivery', {
        session: sessionName,
        task: taskRef.name,
        err,
      });
    }
  }

  return { delivered, failed, skipped };
}

/**
 * One brain episode per exchange. The brain is the conversation memory;
 * this is the write side, done here because delivery is the first moment
 * both halves of the exchange exist. Never blocks or fails delivery.
 */
async function rememberTurn(
  input: { readonly config: TelegramAdapterConfig; readonly logger: AdapterLogger },
  task: AgentTask,
  reply: string,
): Promise<void> {
  const brain = input.config.brain;
  if (brain === undefined) return;
  const message = task.metadata.annotations?.[CHANNEL_MESSAGE_ANNOTATION];
  if (message === undefined) return;
  const failed = task.status?.phase === 'Failed';
  const episode = channelTurnEpisode({
    operatorName: brain.operatorName,
    agentName: typeof task.spec.targetAgent === 'string' ? task.spec.targetAgent : 'agent',
    message,
    reply: failed ? undefined : reply,
    error: failed ? (task.status?.error ?? 'task failed') : undefined,
    at: task.metadata.creationTimestamp ?? new Date().toISOString(),
  });
  try {
    await writeBrainEpisode(brain, episode);
  } catch (err) {
    input.logger.warn('[channel-telegram] brain episode write failed', {
      task: task.metadata.name,
      err,
    });
  }
}

function sessionMatchesConfig(session: ChannelSession, config: TelegramAdapterConfig): boolean {
  return (
    session.spec.channelRef.name === config.channelName &&
    session.spec.provider === 'telegram' &&
    session.spec.accountId === config.accountId
  );
}

function shouldSkipSession(session: ChannelSession, now: Date): boolean {
  if (session.spec.paused === true) return true;
  const phase = session.status?.phase;
  if (phase === 'Paused' || phase === 'Failed') return true;
  if (phase !== 'Backoff') return false;
  const backoffUntil = session.status?.backoffUntil;
  if (backoffUntil === undefined) return true;
  const backoffMs = Date.parse(backoffUntil);
  return Number.isNaN(backoffMs) || backoffMs > now.getTime();
}

function replyTextForTask(task: AgentTask): string | undefined {
  if (task.status?.phase === 'Failed') return FAILURE_REPLY;
  if (task.status?.phase !== 'Completed') return undefined;

  const result = task.status.result;
  const content = typeof result === 'string' ? result : readResultContent(result);
  if (content === undefined) return 'The task completed without a text answer.';
  const trimmed = content.trim();
  if (trimmed.length === 0) return 'The task completed without a text answer.';
  return truncateReply(trimmed);
}

function readResultContent(result: unknown): string | undefined {
  if (typeof result !== 'object' || result === null) return undefined;
  const content = (result as { readonly content?: unknown }).content;
  return typeof content === 'string' ? content : undefined;
}

function truncateReply(value: string): string {
  if (value.length <= MAX_REPLY_CHARS) return value;
  return `${value.slice(0, MAX_REPLY_CHARS - 3)}...`;
}

async function patchSendFailure(input: {
  readonly config: TelegramAdapterConfig;
  readonly store: ChannelOutboxStore;
  readonly session: ChannelSession;
  readonly sessionName: string;
  readonly sessionNamespace: string;
  readonly now: Date;
}): Promise<void> {
  const nextFailures = (input.session.status?.consecutiveFailures ?? 0) + 1;
  if (nextFailures >= input.config.outboundMaxFailures) {
    await input.store.patchSessionStatus(input.sessionNamespace, input.sessionName, {
      phase: 'Failed',
      consecutiveFailures: nextFailures,
      backoffUntil: null,
      lastFailureReason: 'outbound_send_failed',
    });
    return;
  }

  const backoffMs =
    input.config.outboundBaseBackoffSeconds * 1000 * 2 ** Math.max(0, nextFailures - 1);
  await input.store.patchSessionStatus(input.sessionNamespace, input.sessionName, {
    phase: 'Backoff',
    consecutiveFailures: nextFailures,
    backoffUntil: new Date(input.now.getTime() + backoffMs).toISOString(),
    lastFailureReason: 'outbound_send_failed',
  });
}

function sameTaskRef(a: ChannelTaskRef | undefined, b: ChannelTaskRef): boolean {
  if (a === undefined) return false;
  if (a.namespace !== b.namespace || a.name !== b.name) return false;
  return a.uid === undefined || b.uid === undefined || a.uid === b.uid;
}
