/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

import { normalizeTelegramUpdate } from './normalize.js';
import { withPreviousTurn } from './brain.js';
import { fetchFleetNow, recordRule, renderRuleRecord, ruleIn, withFleetNow } from './fleet.js';
import { deliverOutboundTurns } from './outbound.js';
import { adapterCondition } from './status.js';
import { ChannelGatewayHttpError } from './gateway.js';
import type {
  AdapterLogger,
  AgentTask,
  ChannelGateway,
  ChannelInboundEnvelope,
  ChannelOutboxStore,
  ChannelStatusPatcher,
  TelegramAdapterConfig,
  TelegramClient,
  TelegramUpdate,
} from './types.js';

export interface StartTelegramAdapterDeps {
  readonly client: TelegramClient;
  readonly gateway: ChannelGateway;
  readonly status: ChannelStatusPatcher;
  readonly outbox?: ChannelOutboxStore;
  readonly logger?: AdapterLogger;
  readonly clock?: () => Date;
  readonly sleep?: (ms: number) => Promise<void>;
}

export interface RunningTelegramAdapter {
  close(): void;
}

export interface TelegramUpdateProcessingResult {
  readonly nextOffset: number | undefined;
  readonly accepted: number;
  readonly ignored: number;
  readonly failed: number;
}

const consoleLogger: AdapterLogger = {
  info(message, extra): void {
    console.log(message, extra ?? '');
  },
  warn(message, extra): void {
    console.warn(message, extra ?? '');
  },
  error(message, extra): void {
    console.error(message, extra ?? '');
  },
};

export async function startTelegramAdapter(
  config: TelegramAdapterConfig,
  deps: StartTelegramAdapterDeps,
): Promise<RunningTelegramAdapter> {
  const logger = deps.logger ?? consoleLogger;
  const clock = deps.clock ?? (() => new Date());
  const sleep = deps.sleep ?? timeoutSleep;
  let stopped = false;
  let offset: number | undefined;

  const deliverOutbound = async (): Promise<void> => {
    if (deps.outbox === undefined) return;
    await deliverOutboundTurns({
      config,
      store: deps.outbox,
      client: deps.client,
      logger,
      clock,
      gateway: deps.gateway,
    });
  };

  await deps.status.patch({
    phase: 'Ready',
    pairing: { state: 'paired', message: 'Telegram bot token configured' },
    lastHeartbeatAt: clock().toISOString(),
  });

  void pollLoop().catch((err: unknown) => {
    logger.error('[channel-telegram] polling loop stopped unexpectedly', err);
  });

  const outboundPoller =
    deps.outbox === undefined
      ? undefined
      : setInterval(() => {
          void deliverOutbound().catch((err: unknown) => {
            logger.error('[channel-telegram] failed to deliver outbound replies', err);
          });
        }, config.outboundPollMs);

  async function pollLoop(): Promise<void> {
    while (!stopped) {
      try {
        const result = await processTelegramUpdates({
          config,
          client: deps.client,
          gateway: deps.gateway,
          logger,
          ...(deps.outbox !== undefined && { outbox: deps.outbox }),
          ...(offset !== undefined && { offset }),
        });
        offset = result.nextOffset;
        await deps.status.patch({
          phase: 'Ready',
          pairing: { state: 'paired' },
          lastHeartbeatAt: clock().toISOString(),
        });
      } catch (err) {
        logger.error('[channel-telegram] failed to poll Telegram updates', err);
        await deps.status.patch({
          phase: 'Ready',
          pairing: { state: 'paired' },
          conditions: [
            adapterCondition({
              type: 'TelegramPolling',
              status: 'False',
              reason: 'PollFailed',
              message: String(err instanceof Error ? err.message : err),
              now: clock(),
            }),
          ],
          lastHeartbeatAt: clock().toISOString(),
        });
      }
      if (!stopped) await sleep(config.pollIntervalMs);
    }
  }

  return {
    close(): void {
      stopped = true;
      if (outboundPoller !== undefined) clearInterval(outboundPoller);
    },
  };
}

export async function processTelegramUpdates(input: {
  readonly config: TelegramAdapterConfig;
  readonly client: TelegramClient;
  readonly gateway: ChannelGateway;
  readonly logger: AdapterLogger;
  /** When set, the previous exchange of the same peer is bridged into the text. */
  readonly outbox?: ChannelOutboxStore;
  readonly offset?: number;
}): Promise<TelegramUpdateProcessingResult> {
  const updates = await input.client.getUpdates({
    ...(input.offset !== undefined && { offset: input.offset }),
    timeoutSeconds: input.config.pollTimeoutSeconds,
  });
  let nextOffset = input.offset;
  let accepted = 0;
  let ignored = 0;
  let failed = 0;

  for (const update of updates) {
    const updateId = validUpdateId(update);
    if (updateId === undefined) {
      ignored += 1;
      continue;
    }

    const normalized = normalizeTelegramUpdate(input.config, update);
    if (normalized === undefined) {
      ignored += 1;
      nextOffset = Math.max(nextOffset ?? 0, updateId + 1);
      continue;
    }
    const envelope = await bridgeFleetNow(
      input,
      await bridgePreviousTurn(input, normalized),
      normalized.text,
    );

    try {
      await input.gateway.postInbound(envelope);
      accepted += 1;
      nextOffset = Math.max(nextOffset ?? 0, updateId + 1);
      input.logger.info('[channel-telegram] inbound message accepted', {
        channelName: envelope.channelName,
        peer: envelope.peer,
        messageId: envelope.messageId,
      });
    } catch (err) {
      failed += 1;
      input.logger.error('[channel-telegram] inbound message rejected by channel gateway', err);
      // A definitive no (4xx) is about this message: skip it, or the same update
      // is retried forever and every later message waits behind it. Anything
      // else (gateway down, 5xx) keeps the offset so the message is retried.
      if (err instanceof ChannelGatewayHttpError && err.status < 500) {
        nextOffset = Math.max(nextOffset ?? 0, updateId + 1);
        continue;
      }
      break;
    }
  }

  return { nextOffset, accepted, ignored, failed };
}

/**
 * The bridge over graphiti's ingestion lag: prepend the peer's previous
 * exchange (from the session's last task) so a follow-up thirty seconds
 * later still reads as a conversation. Best effort — any failure means
 * the message goes through as-is.
 */
const EARLIER_TURNS = 5;

async function bridgePreviousTurn(
  input: {
    readonly config: TelegramAdapterConfig;
    readonly logger: AdapterLogger;
    readonly outbox?: ChannelOutboxStore;
  },
  envelope: ChannelInboundEnvelope,
): Promise<ChannelInboundEnvelope> {
  if (input.outbox === undefined) return envelope;
  try {
    const sessions = await input.outbox.listChannelSessions({
      namespace: input.config.namespace,
      channelName: envelope.channelName,
      accountId: envelope.accountId,
    });
    const session = sessions.find(
      (s) =>
        s.spec.peer.kind === envelope.peer.kind &&
        s.spec.peer.id === envelope.peer.id &&
        (s.spec.threadId === undefined ||
          envelope.threadId === undefined ||
          s.spec.threadId === envelope.threadId),
    );
    const ref = session?.status?.lastTaskRef;
    if (ref === undefined) return envelope;
    const task = await input.outbox.getAgentTask(ref);
    const previousMessage = task?.metadata.annotations?.['kagent.knuteson.io/channel-message'];
    const previousReply = task === undefined ? undefined : replyTextOf(task);
    if (previousMessage === undefined || previousReply === undefined) return envelope;
    // The turns before that one: a discussion is not one exchange long.
    // Its own try: v0.2.58 lost the one-turn bridge for a whole afternoon
    // because listing tasks answered 403 (RBAC) and the throw took the last
    // turn down with it.
    let earlier: { message: string; reply: string }[] = [];
    if (input.outbox.listSessionTasks !== undefined && session?.metadata.name !== undefined) {
      try {
        const recent = await input.outbox.listSessionTasks({
          namespace: input.config.namespace,
          sessionName: session.metadata.name,
          limit: EARLIER_TURNS + 1,
        });
        earlier = recent
          .filter((t) => t.metadata.name !== ref.name)
          .flatMap((t) => {
            const message = t.metadata.annotations?.['kagent.knuteson.io/channel-message'];
            const reply = replyTextOf(t);
            return message === undefined || reply === undefined ? [] : [{ message, reply }];
          })
          .slice(-EARLIER_TURNS);
      } catch (err) {
        input.logger.warn('[channel-telegram] earlier-turns lookup skipped', err);
      }
    }
    return {
      ...envelope,
      text: withPreviousTurn({
        text: envelope.text,
        previousMessage,
        previousReply,
        operatorName: input.config.brain?.operatorName ?? 'the operator',
        ...(earlier.length > 0 && { earlier }),
      }),
    };
  } catch (err) {
    input.logger.warn('[channel-telegram] previous-turn bridge skipped', err);
    return envelope;
  }
}

/**
 * [fleet now]: the launcher's computed state, memory counts and rules, in
 * front of every message. Best effort; a silent launcher changes nothing.
 */
async function bridgeFleetNow(
  input: { readonly config: TelegramAdapterConfig; readonly logger: AdapterLogger },
  envelope: ChannelInboundEnvelope,
  rawText: string,
): Promise<ChannelInboundEnvelope> {
  const url = input.config.fleetUrl;
  if (url === undefined) return envelope;
  try {
    // A "rule:" message is recorded before the model sees it; the block says so.
    const rule = ruleIn(rawText);
    const ruleLine =
      rule === undefined ? undefined : renderRuleRecord(rule, await recordRule(url, rule));
    const fetched = await fetchFleetNow(url, fetch, 5000, rawText);
    // A launcher that times out, answers non-2xx, or returns an unparseable
    // body did not answer its own /missions call: surface it instead of
    // appending a stale block or hanging silently. An absent launcher adds
    // nothing. This adapter only fetches; it neither halts the run nor owns a
    // question_timeout status, so the line says only that the launcher fetch
    // failed, with no claim about who resolves it.
    const block = fetched.kind === 'rendered' ? fetched.block : undefined;
    const staleLine =
      fetched.kind === 'stale'
        ? `🛟 [fleet now] launcher fetch failed (${fetched.reason})`
        : undefined;
    const appended = ruleLine === undefined ? undefined : `[rule] ${ruleLine}`;
    const blockText = [block, staleLine, appended].filter((x) => x !== undefined).join('\n');
    // Preserve the old early return: when nothing was fetched and there is no
    // rule line, leave the message exactly as it arrived. (An empty block must
    // not gain a leading newline or a stray [current message] marker.)
    if (blockText === '') return envelope;
    return { ...envelope, text: withFleetNow(envelope.text, blockText) };
  } catch (err) {
    input.logger.warn('[channel-telegram] fleet-now bridge skipped', err);
    return envelope;
  }
}

function replyTextOf(task: AgentTask): string | undefined {
  if (task.status?.phase !== 'Completed') return undefined;
  const result = task.status.result;
  if (typeof result === 'string') return result;
  const content = (result as { readonly content?: unknown } | null)?.content;
  return typeof content === 'string' && content.trim().length > 0 ? content.trim() : undefined;
}

function validUpdateId(update: TelegramUpdate): number | undefined {
  return typeof update.update_id === 'number' && Number.isSafeInteger(update.update_id)
    ? update.update_id
    : undefined;
}

function timeoutSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
