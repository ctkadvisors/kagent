/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

import type {
  AdapterLogger,
  BrainOutboxEntry,
  AgentTask,
  ChannelGateway,
  ChannelOutboxStore,
  ChannelSession,
  ChannelTaskRef,
  TelegramAdapterConfig,
  TelegramClient,
} from './types.js';
import { brainEpisodeUuid, channelTurnEpisode, writeBrainEpisode } from './brain.js';

const CHANNEL_MESSAGE_ANNOTATION = 'kagent.knuteson.io/channel-message';
const CHANNEL_MESSAGE_ID_ANNOTATION = 'kagent.knuteson.io/channel-message-id';
/** A retried turn's messageId ends with this; the controller names tasks by messageId, so it is a new task. */
const RETRY_SUFFIX = '-retry';

export interface OutboundDeliveryStats {
  readonly delivered: number;
  readonly failed: number;
  readonly skipped: number;
  /** Failed turns re-submitted to the gateway once instead of answered. */
  readonly retried?: number;
}

const FAILURE_REPLY =
  "I couldn't complete that request. The task failed before returning an answer.";
const MAX_REPLY_CHARS = 4000;
const MAX_ERROR_CHARS = 200;

export async function deliverOutboundTurns(input: {
  readonly config: TelegramAdapterConfig;
  readonly store: ChannelOutboxStore;
  readonly client: TelegramClient;
  readonly logger: AdapterLogger;
  readonly clock?: () => Date;
  /** When set, a failed turn is re-submitted once before its failure is reported. */
  readonly gateway?: ChannelGateway;
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
  let retried = 0;

  const memoryDeadline = Date.now() + input.config.gatewayTimeoutMs;
  for (const session of sessions) {
    if (!sessionMatchesConfig(session, input.config)) {
      skipped += 1;
      continue;
    }
    let brainOutbox = [...(session.status?.brainOutbox ?? [])];
    brainOutbox = await flushBrainOutbox(input, session, brainOutbox, now, memoryDeadline);
    if (shouldSkipSession(session, now)) {
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
    if (task !== undefined && input.gateway !== undefined && retryable(task)) {
      // 2026-09-08 03:03Z: Chris's order died with "LLM backend returned HTTP
      // 429" and he got an apology. One retry, then the truth, never silence.
      try {
        await input.gateway.postInbound(retryEnvelope(input.config, session, task));
        await input.store.patchSessionStatus(sessionNamespace, sessionName, {
          lastOutboundTaskRef: taskRef,
        });
        retried += 1;
        input.logger.warn('[channel-telegram] task failed; re-submitted the turn once', {
          session: sessionName,
          task: taskRef.name,
          error: task.status?.error,
        });
        continue;
      } catch (err) {
        input.logger.error('[channel-telegram] retry submission failed; reporting the failure', {
          task: taskRef.name,
          err,
        });
      }
    }
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

    const episode =
      task === undefined ? undefined : retainedTurn(input, taskRef, task, reply, nowIso);
    if (episode !== undefined) brainOutbox.push(episode);
    try {
      await input.store.patchSessionStatus(sessionNamespace, sessionName, {
        phase: 'Active',
        lastOutboundAt: nowIso,
        lastOutboundTaskRef: taskRef,
        consecutiveFailures: 0,
        backoffUntil: null,
        lastFailureReason: null,
        ...(input.config.brain !== undefined && { brainOutbox }),
      });
      delivered += 1;
      input.logger.info('[channel-telegram] outbound reply delivered', {
        session: sessionName,
        task: taskRef.name,
      });
      await flushBrainOutbox(input, session, brainOutbox, now, memoryDeadline);
    } catch (err) {
      failed += 1;
      input.logger.error('[channel-telegram] failed to record outbound delivery', {
        session: sessionName,
        task: taskRef.name,
        err,
      });
    }
  }

  return { delivered, failed, skipped, ...(retried > 0 && { retried }) };
}

/** A failed turn that has not been retried yet and still carries its text. */
function retryable(task: AgentTask): boolean {
  if (task.status?.phase !== 'Failed') return false;
  const ann = task.metadata.annotations ?? {};
  const messageId = ann[CHANNEL_MESSAGE_ID_ANNOTATION];
  return (
    typeof messageId === 'string' &&
    !messageId.endsWith(RETRY_SUFFIX) &&
    typeof ann[CHANNEL_MESSAGE_ANNOTATION] === 'string'
  );
}

function retryEnvelope(config: TelegramAdapterConfig, session: ChannelSession, task: AgentTask) {
  const ann = task.metadata.annotations ?? {};
  return {
    channelName: config.channelName,
    provider: 'telegram' as const,
    accountId: config.accountId,
    peer: session.spec.peer,
    ...(session.spec.threadId !== undefined && { threadId: session.spec.threadId }),
    messageId: `${ann[CHANNEL_MESSAGE_ID_ANNOTATION] ?? ''}${RETRY_SUFFIX}`,
    text: ann[CHANNEL_MESSAGE_ANNOTATION] ?? '',
  };
}

/** Seal both delivered halves once; retries never regenerate text or time. */
function retainedTurn(
  input: { readonly config: TelegramAdapterConfig },
  taskRef: ChannelTaskRef,
  task: AgentTask,
  reply: string,
  deliveredAt: string,
): BrainOutboxEntry | undefined {
  const brain = input.config.brain;
  const message = task.metadata.annotations?.[CHANNEL_MESSAGE_ANNOTATION];
  if (brain === undefined || message === undefined) return undefined;
  const failed = task.status?.phase === 'Failed';
  const episode = channelTurnEpisode({
    operatorName: brain.operatorName,
    agentName: typeof task.spec.targetAgent === 'string' ? task.spec.targetAgent : 'agent',
    message,
    reply: failed ? undefined : reply,
    error: failed ? reply : undefined,
    at: task.metadata.creationTimestamp ?? deliveredAt,
  });
  return {
    taskRef,
    episode: {
      ...episode,
      uuid: brainEpisodeUuid(JSON.stringify([taskRef.namespace, taskRef.name, taskRef.uid ?? ''])),
    },
    attempts: 0,
  };
}

async function flushBrainOutbox(
  input: {
    readonly config: TelegramAdapterConfig;
    readonly store: ChannelOutboxStore;
    readonly logger: AdapterLogger;
  },
  session: ChannelSession,
  entries: readonly BrainOutboxEntry[],
  now: Date,
  deadline: number,
): Promise<BrainOutboxEntry[]> {
  const pending = [...entries];
  const brain = input.config.brain;
  const name = session.metadata.name;
  if (brain === undefined || name === undefined) return pending;
  const namespace = session.metadata.namespace ?? input.config.namespace;
  while (pending.length > 0 && Date.now() < deadline) {
    const entry = pending[0];
    if (
      entry === undefined ||
      (entry.nextAttemptAt !== undefined && Date.parse(entry.nextAttemptAt) > now.getTime())
    )
      break;
    try {
      await writeBrainEpisode(brain, entry.episode, undefined, Math.max(1, deadline - Date.now()));
      await input.store.patchSessionStatus(namespace, name, {
        brainOutbox: pending.slice(1),
        lastRememberedTaskRef: entry.taskRef,
      });
      pending.shift();
    } catch (err) {
      // The sealed episode remains durable even if acknowledgement or its local
      // status patch is lost. Retrying the same UUID is safe; chat is already sent.
      pending[0] = {
        ...entry,
        attempts: entry.attempts + 1,
        nextAttemptAt: new Date(now.getTime() + input.config.outboundPollMs).toISOString(),
        lastError: (err instanceof Error ? err.message : String(err)).slice(0, MAX_ERROR_CHARS),
      };
      try {
        await input.store.patchSessionStatus(namespace, name, { brainOutbox: pending });
      } catch (statusError) {
        input.logger.error('[channel-telegram] failed to retain brain retry status', {
          session: name,
          err: statusError,
        });
      }
      input.logger.warn(
        '[channel-telegram] brain intake pending; memory will retry independently',
        { session: name, task: entry.taskRef.name, err },
      );
      break;
    }
  }
  return pending;
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
  if (task.status?.phase === 'Failed') return failureReply(task);
  if (task.status?.phase !== 'Completed') return undefined;

  const result = task.status.result;
  const content = typeof result === 'string' ? result : readResultContent(result);
  if (content === undefined) return 'The task completed without a text answer.';
  const trimmed = withoutClosingOffer(content.trim());
  if (trimmed.length === 0) return 'The task completed without a text answer.';
  return truncateReply(trimmed);
}

const CLOSING_OFFER =
  /\n*(?:(?:want|would you like) me to|shall i|should i|do you want me to|let me know if you(?:'d| would) like)\b[^\n]*\?\s*$/iu;

/**
 * A reply that ends by offering to do something the concierge could have
 * done in the turn ("Want me to dig into why?") loses that last sentence.
 * The self-check catches it on tool-less turns; on turns that used a tool the
 * offer still came through (2026-09-10). Only a trailing question of that
 * shape is removed; a reply that is nothing but the offer stays.
 */
export function withoutClosingOffer(text: string): string {
  const cut = text.replace(CLOSING_OFFER, '').trimEnd();
  return cut.length > 0 ? cut : text;
}

/** What failed, in the backend's own words (first line, bounded), and what was asked, so nothing is lost. */
function failureReply(task: AgentTask): string {
  const error = (task.status?.error ?? '').split('\n')[0]?.trim() ?? '';
  const asked = task.metadata.annotations?.[CHANNEL_MESSAGE_ANNOTATION];
  const head =
    error.length > 0
      ? `I couldn't complete that: ${error.length > MAX_ERROR_CHARS ? `${error.slice(0, MAX_ERROR_CHARS - 3)}...` : error}.`
      : FAILURE_REPLY;
  const retriedNote = task.metadata.annotations?.[CHANNEL_MESSAGE_ID_ANNOTATION]?.endsWith(
    RETRY_SUFFIX,
  )
    ? ' I tried twice.'
    : '';
  return asked === undefined
    ? `${head}${retriedNote}`
    : `${head}${retriedNote} You asked: "${asked.length > 300 ? `${asked.slice(0, 297)}...` : asked}" — send it again when you want me to retry.`;
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
