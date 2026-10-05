/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * Graphiti brain writes for channel turns, plus the previous-turn bridge.
 *
 * One sealed episode per delivered exchange, retained in the ChannelSession
 * outbox until Graphiti acknowledges durable intake. MCP errors and timeouts
 * throw to the outbox, which retries the same UUID independently of chat.
 * Intake acceptance is distinct from completed extraction into the graph.
 *
 * The bridge: graphiti ingestion runs through the local model and takes
 * minutes, so the turn from thirty seconds ago is not in the graph when
 * the next one arrives. The inbound path prepends the previous exchange
 * to the message text under fixed markers; the brain writer strips it
 * again so the episode carries only what the human actually typed.
 */

import { createHash } from 'node:crypto';

// "[previous turn]" read as "not this thread": with three exchanges in front
// of it the concierge said it had no earlier messages (2026-09-10 15:37Z).
export const PREVIOUS_TURN_MARKER = '[earlier in this conversation]';
export const CURRENT_MESSAGE_MARKER = '[current message]';
/**
 * Telegram caps a single reply at 4000 chars. The bridged previous reply
 * must leave room for the new message, so keep the cap below that.
 */
const MAX_BRIDGE_REPLY_CHARS = 1500;
const MAX_EARLIER_REPLY_CHARS = 500;
// The human's side of a bridged turn is bounded too: a bridge that can only
// grow is how one message wedged the channel for four days (see stripPreviousTurn).
const MAX_BRIDGE_MESSAGE_CHARS = 1500;

export interface BrainConfig {
  readonly mcpUrl: string;
  readonly token: string;
  /** How the human is named in episodes ("Chris", "the operator"). */
  readonly operatorName: string;
}

export interface BrainEpisode {
  readonly name: string;
  readonly body: string;
  /** ISO-8601 time the exchange actually happened (bi-temporal). */
  readonly referenceTime: string;
  /** Stable identity retained by the channel outbox for every intake retry. */
  readonly uuid?: string;
}

/** Prepend the previous exchange to a new message. */
export function withPreviousTurn(input: {
  readonly text: string;
  readonly previousMessage: string;
  readonly previousReply: string;
  readonly operatorName: string;
  /** Older exchanges of the same session, oldest first; one turn was not a conversation (2026-09-10). */
  readonly earlier?: readonly { readonly message: string; readonly reply: string }[];
}): string {
  const reply = truncate(input.previousReply, MAX_BRIDGE_REPLY_CHARS);
  const earlier = (input.earlier ?? []).flatMap((t) => [
    `${input.operatorName}: ${truncate(stripPreviousTurn(t.message), MAX_BRIDGE_MESSAGE_CHARS)}`,
    `You: ${truncate(t.reply, MAX_EARLIER_REPLY_CHARS)}`,
  ]);
  return [
    PREVIOUS_TURN_MARKER,
    ...earlier,
    `${input.operatorName}: ${truncate(stripPreviousTurn(input.previousMessage), MAX_BRIDGE_MESSAGE_CHARS)}`,
    `You: ${reply}`,
    CURRENT_MESSAGE_MARKER,
    input.text,
  ].join('\n');
}

/** Inverse of withPreviousTurn: the text the human actually sent. */
export function stripPreviousTurn(text: string): string {
  // The LAST marker, whatever the text opens with. The old version took the
  // first marker and only when the text began with the current opening
  // marker: the 2026-09-10 rename of that marker made one stored message
  // fail the check, every later turn nested the one before it (4 KB -> 213 KB
  // in six turns), and from 2026-09-11 20:29Z the gateway answered 400 to
  // every message for four days.
  const marker = `\n${CURRENT_MESSAGE_MARKER}\n`;
  const idx = text.lastIndexOf(marker);
  return idx === -1 ? text : text.slice(idx + marker.length);
}

export function channelTurnEpisode(input: {
  readonly operatorName: string;
  readonly agentName: string;
  readonly message: string;
  readonly reply: string | undefined;
  readonly error: string | undefined;
  readonly at: string;
}): BrainEpisode {
  const message = stripPreviousTurn(input.message);
  const outcome =
    input.reply !== undefined
      ? `${input.agentName} replied: ${input.reply}`
      : `${input.agentName} failed to answer: ${input.error ?? 'unknown error'}`;
  return {
    name: `telegram: ${truncate(message, 60)} (${input.at.slice(0, 10)})`,
    body: `${input.operatorName} (telegram): ${message}\n${outcome}`,
    referenceTime: input.at,
  };
}

/** RFC 4122 UUIDv5: the name is an immutable task identity or a sealed episode. */
export function brainEpisodeUuid(identity: string): string {
  const hash = createHash('sha1')
    .update(Buffer.from('6ba7b8109dad11d180b400c04fd430c8', 'hex'))
    .update(identity)
    .digest();
  hash[6] = ((hash[6] ?? 0) & 0x0f) | 0x50;
  hash[8] = ((hash[8] ?? 0) & 0x3f) | 0x80;
  const hex = hash.subarray(0, 16).toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function rpcReply(text: string, id: number): Record<string, unknown> {
  const values = text.trim().startsWith('{')
    ? [JSON.parse(text) as unknown]
    : text.split(/\r?\n\r?\n/).flatMap((frame) => {
        const data = frame
          .split(/\r?\n/)
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).trimStart())
          .join('\n');
        return data ? [JSON.parse(data) as unknown] : [];
      });
  const reply = values.find(
    (value) => typeof value === 'object' && value !== null && (value as { id?: unknown }).id === id,
  );
  if (typeof reply !== 'object' || reply === null)
    throw new Error('brain MCP response missing RPC acknowledgement');
  const result = reply as Record<string, unknown>;
  if (result['error'] !== undefined) throw new Error('brain MCP RPC error');
  return result;
}

function durableReceipt(reply: Record<string, unknown>, uuid: string): void {
  const result = reply['result'];
  if (typeof result !== 'object' || result === null)
    throw new Error('brain MCP missing tool result');
  const tool = result as Record<string, unknown>;
  if (tool['isError'] === true) throw new Error('brain MCP tool error');
  const candidates: unknown[] = [tool['structuredContent']];
  if (Array.isArray(tool['content'])) {
    for (const block of tool['content']) {
      if (
        typeof block === 'object' &&
        block !== null &&
        (block as { type?: unknown }).type === 'text'
      ) {
        try {
          candidates.push(JSON.parse(String((block as { text?: unknown }).text)) as unknown);
        } catch {
          /* Plain text is not a durable receipt. */
        }
      }
    }
  }
  const valid = candidates.some((value) => {
    if (typeof value !== 'object' || value === null) return false;
    const receipt = value as Record<string, unknown>;
    return (
      receipt['durable'] === true &&
      receipt['episode_uuid'] === uuid &&
      receipt['receipt_id'] === `graphiti:${uuid}` &&
      ['pending', 'processing', 'completed', 'retrying', 'schema_blocked', 'forgotten'].includes(
        String(receipt['status']),
      )
    );
  });
  if (!valid) throw new Error('brain MCP did not acknowledge durable intake for this episode');
}

export async function writeBrainEpisode(
  config: BrainConfig,
  episode: BrainEpisode,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = 10000,
): Promise<void> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('brain MCP invalid timeout');
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error('brain MCP intake timeout'));
    }, timeoutMs);
  });
  const operation = async (): Promise<void> => {
    const uuid =
      episode.uuid ??
      brainEpisodeUuid(JSON.stringify([episode.name, episode.body, episode.referenceTime]));
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: `Bearer ${config.token}`,
    };
    const call = async (body: unknown, session?: string): Promise<Response> => {
      const res = await fetchImpl(config.mcpUrl, {
        method: 'POST',
        headers: session === undefined ? headers : { ...headers, 'mcp-session-id': session },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(`brain MCP returned HTTP ${String(res.status)}`);
      return res;
    };
    const init = await call({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-03-26',
        capabilities: {},
        clientInfo: { name: 'channel-telegram-adapter', version: '1' },
      },
    });
    rpcReply(await init.text(), 1);
    const session = init.headers.get('mcp-session-id') ?? undefined;
    await (await call({ jsonrpc: '2.0', method: 'notifications/initialized' }, session)).text();
    const response = await call(
      {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: {
          name: 'add_memory',
          arguments: {
            name: episode.name,
            episode_body: episode.body,
            source: 'message',
            source_description: 'telegram channel turn',
            uuid,
            reference_time: episode.referenceTime,
            custom_extraction_instructions:
              "Facts come from what the human said, asked or instructed. The concierge's reply is a claim it made in conversation: record it as 'concierge said ...' and never as a fact about the fleet, its services, its memory or its state.",
          },
        },
      },
      session,
    );
    durableReceipt(rpcReply(await response.text(), 2), uuid);
  };
  try {
    await Promise.race([operation(), timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}
