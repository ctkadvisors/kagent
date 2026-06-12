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
  WhatsAppAdapterConfig,
  WhatsAppSocketLike,
} from './types.js';

export interface OutboundDeliveryStats {
  readonly delivered: number;
  readonly failed: number;
  readonly skipped: number;
}

const FAILURE_REPLY =
  "I couldn't complete that request. The task failed before returning an answer.";
const MAX_REPLY_CHARS = 4000;

export async function deliverOutboundTurns(input: {
  readonly config: WhatsAppAdapterConfig;
  readonly store: ChannelOutboxStore;
  readonly socket: WhatsAppSocketLike;
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
  if (input.socket.sendMessage === undefined) {
    return { delivered: 0, failed: 0, skipped: sessions.length };
  }

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
      await input.socket.sendMessage(session.spec.peer.id, { text: reply });
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
      input.logger.warn('[channel-whatsapp] outbound reply failed', {
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
      input.logger.info('[channel-whatsapp] outbound reply delivered', {
        session: sessionName,
        task: taskRef.name,
      });
    } catch (err) {
      failed += 1;
      input.logger.error('[channel-whatsapp] failed to record outbound delivery', {
        session: sessionName,
        task: taskRef.name,
        err,
      });
    }
  }

  return { delivered, failed, skipped };
}

function sessionMatchesConfig(session: ChannelSession, config: WhatsAppAdapterConfig): boolean {
  return (
    session.spec.channelRef.name === config.channelName &&
    session.spec.provider === 'whatsapp' &&
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
  readonly config: WhatsAppAdapterConfig;
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
