/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

import { describe, expect, it, vi } from 'vitest';

import { deliverOutboundTurns } from './outbound.js';
import type {
  AdapterLogger,
  AgentTask,
  ChannelOutboxStore,
  ChannelSession,
  ChannelSessionStatusPatch,
  ChannelTaskRef,
  TelegramAdapterConfig,
  TelegramClient,
} from './types.js';

const config: TelegramAdapterConfig = {
  channelName: 'telegram-work',
  namespace: 'kagent-system',
  accountId: 'work',
  botToken: '123456:token',
  telegramApiBaseUrl: 'https://api.telegram.org',
  gatewayUrl: 'http://operator:8089',
  gatewayToken: 'token',
  gatewayTimeoutMs: 10000,
  outboundPollMs: 5000,
  outboundBaseBackoffSeconds: 60,
  outboundMaxFailures: 2,
  pollTimeoutSeconds: 25,
  pollIntervalMs: 1000,
};

const taskRef = { namespace: 'kagent-system', name: 'kat-turn-1', uid: 'task-uid-1' };

describe('deliverOutboundTurns', () => {
  it('sends a completed task result once and records the delivered task ref', async () => {
    const store = makeStore({
      sessions: [makeSession()],
      tasks: [
        makeTask({ status: { phase: 'Completed', result: { content: 'Daily check done' } } }),
      ],
    });
    const client = makeClient();

    const result = await deliverOutboundTurns({
      config,
      store,
      client,
      logger: quietLogger,
      clock,
    });

    expect(result).toEqual({ delivered: 1, failed: 0, skipped: 0 });
    expect(client.sendMessage).toHaveBeenCalledWith({
      chatId: '3175140114',
      text: 'Daily check done',
    });
    expect(store.patchSessionStatus).toHaveBeenCalledWith('kagent-system', 'kcs-work-dm', {
      phase: 'Active',
      lastOutboundAt: '2026-06-12T12:00:00.000Z',
      lastOutboundTaskRef: taskRef,
      consecutiveFailures: 0,
      backoffUntil: null,
      lastFailureReason: null,
    });
  });

  it('does not resend a task already recorded as delivered', async () => {
    const store = makeStore({
      sessions: [
        makeSession({
          status: { phase: 'Active', lastTaskRef: taskRef, lastOutboundTaskRef: taskRef },
        }),
      ],
      tasks: [makeTask({ status: { phase: 'Completed', result: { content: 'Already sent' } } })],
    });
    const client = makeClient();

    const result = await deliverOutboundTurns({
      config,
      store,
      client,
      logger: quietLogger,
      clock,
    });

    expect(result).toEqual({ delivered: 0, failed: 0, skipped: 1 });
    expect(client.sendMessage).not.toHaveBeenCalled();
    expect(store.patchSessionStatus).not.toHaveBeenCalled();
  });

  it('sends a bounded failure reply for failed tasks and records the task ref', async () => {
    const store = makeStore({
      sessions: [makeSession()],
      tasks: [
        makeTask({ status: { phase: 'Failed', error: 'stack trace with internal details' } }),
      ],
    });
    const client = makeClient();

    const result = await deliverOutboundTurns({
      config,
      store,
      client,
      logger: quietLogger,
      clock,
    });

    expect(result).toEqual({ delivered: 1, failed: 0, skipped: 0 });
    expect(client.sendMessage).toHaveBeenCalledWith({
      chatId: '3175140114',
      text: "I couldn't complete that request. The task failed before returning an answer.",
    });
    expect(store.patchSessionStatus).toHaveBeenCalledWith(
      'kagent-system',
      'kcs-work-dm',
      expect.objectContaining({ lastOutboundTaskRef: taskRef }),
    );
  });

  it('backs off the session when Telegram send fails', async () => {
    const store = makeStore({
      sessions: [makeSession()],
      tasks: [
        makeTask({ status: { phase: 'Completed', result: { content: 'Daily check done' } } }),
      ],
    });
    const client = makeClient();
    client.sendMessage.mockRejectedValueOnce(new Error('network unavailable'));

    const result = await deliverOutboundTurns({
      config,
      store,
      client,
      logger: quietLogger,
      clock,
    });

    expect(result).toEqual({ delivered: 0, failed: 1, skipped: 0 });
    expect(store.patchSessionStatus).toHaveBeenCalledWith('kagent-system', 'kcs-work-dm', {
      phase: 'Backoff',
      consecutiveFailures: 1,
      backoffUntil: '2026-06-12T12:01:00.000Z',
      lastFailureReason: 'outbound_send_failed',
    });
  });

  it('does not back off the session when only the delivery record patch fails', async () => {
    const store = makeStore({
      sessions: [makeSession()],
      tasks: [
        makeTask({ status: { phase: 'Completed', result: { content: 'Daily check done' } } }),
      ],
    });
    store.patchSessionStatus.mockRejectedValueOnce(new Error('api unavailable'));
    const client = makeClient();

    const result = await deliverOutboundTurns({
      config,
      store,
      client,
      logger: quietLogger,
      clock,
    });

    expect(result).toEqual({ delivered: 0, failed: 1, skipped: 0 });
    expect(client.sendMessage).toHaveBeenCalledTimes(1);
    expect(store.patchSessionStatus).toHaveBeenCalledTimes(1);
    expect(store.patchSessionStatus).toHaveBeenCalledWith(
      'kagent-system',
      'kcs-work-dm',
      expect.objectContaining({ lastOutboundTaskRef: taskRef }),
    );
  });

  it('marks the session failed after the configured outbound failure limit', async () => {
    const store = makeStore({
      sessions: [
        makeSession({
          status: { phase: 'Active', lastTaskRef: taskRef, consecutiveFailures: 1 },
        }),
      ],
      tasks: [
        makeTask({ status: { phase: 'Completed', result: { content: 'Daily check done' } } }),
      ],
    });
    const client = makeClient();
    client.sendMessage.mockRejectedValueOnce(new Error('network unavailable'));

    await deliverOutboundTurns({ config, store, client, logger: quietLogger, clock });

    expect(store.patchSessionStatus).toHaveBeenCalledWith('kagent-system', 'kcs-work-dm', {
      phase: 'Failed',
      consecutiveFailures: 2,
      backoffUntil: null,
      lastFailureReason: 'outbound_send_failed',
    });
  });
});

function makeSession(overrides: Partial<ChannelSession> = {}): ChannelSession {
  return {
    apiVersion: 'kagent.knuteson.io/v1alpha1',
    kind: 'ChannelSession',
    metadata: { name: 'kcs-work-dm', namespace: 'kagent-system' },
    spec: {
      channelRef: { name: 'telegram-work' },
      provider: 'telegram',
      accountId: 'work',
      peer: { kind: 'dm', id: '3175140114' },
      sessionKey: 'session-key',
      target: { agentRef: { name: 'operator-investigator' } },
    },
    status: { phase: 'Active', lastTaskRef: taskRef },
    ...overrides,
  };
}

function makeTask(overrides: Partial<AgentTask> = {}): AgentTask {
  return {
    apiVersion: 'kagent.knuteson.io/v1alpha1',
    kind: 'AgentTask',
    metadata: { name: taskRef.name, namespace: taskRef.namespace, uid: taskRef.uid },
    spec: { payload: {}, targetAgent: 'operator-investigator' },
    ...overrides,
  };
}

function makeStore(input: {
  readonly sessions: readonly ChannelSession[];
  readonly tasks: readonly AgentTask[];
}): ChannelOutboxStore & {
  readonly patchSessionStatus: ReturnType<typeof vi.fn>;
} {
  const tasks = new Map(
    input.tasks.map((task) => [`${task.metadata.namespace}/${task.metadata.name}`, task]),
  );
  return {
    listChannelSessions: vi.fn().mockResolvedValue(input.sessions),
    getAgentTask: vi.fn((ref: ChannelTaskRef) =>
      Promise.resolve(tasks.get(`${ref.namespace}/${ref.name}`)),
    ),
    patchSessionStatus: vi.fn(
      (_namespace: string, _name: string, _status: ChannelSessionStatusPatch) => Promise.resolve(),
    ),
  };
}

function makeClient(): TelegramClient & {
  readonly sendMessage: ReturnType<typeof vi.fn>;
} {
  return {
    sendMessage: vi.fn().mockResolvedValue(undefined),
    getUpdates: vi.fn().mockResolvedValue([]),
  };
}

function clock(): Date {
  return new Date('2026-06-12T12:00:00.000Z');
}

const quietLogger: AdapterLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};
