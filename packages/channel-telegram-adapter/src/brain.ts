/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * Graphiti brain writes for channel turns, plus the previous-turn bridge.
 *
 * One episode per exchange (message + reply), written at delivery time
 * through the graphiti MCP endpoint (streamable HTTP: initialize ->
 * notifications/initialized -> tools/call add_memory). Same dance as
 * brain-scribe and improve-daily's publish step. Never throws to the
 * caller's hot path; failures are the caller's to log.
 *
 * The bridge: graphiti ingestion runs through the local model and takes
 * minutes, so the turn from thirty seconds ago is not in the graph when
 * the next one arrives. The inbound path prepends the previous exchange
 * to the message text under fixed markers; the brain writer strips it
 * again so the episode carries only what the human actually typed.
 */

export const PREVIOUS_TURN_MARKER = '[previous turn]';
export const CURRENT_MESSAGE_MARKER = '[current message]';
/**
 * Telegram caps a single reply at 4000 chars. The bridged previous reply
 * must leave room for the new message, so keep the cap below that.
 */
const MAX_BRIDGE_REPLY_CHARS = 1500;
const MAX_EPISODE_CHARS = 6000;

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
}

/** Prepend the previous exchange to a new message. */
export function withPreviousTurn(input: {
  readonly text: string;
  readonly previousMessage: string;
  readonly previousReply: string;
  readonly operatorName: string;
}): string {
  const reply = truncate(input.previousReply, MAX_BRIDGE_REPLY_CHARS);
  return [
    PREVIOUS_TURN_MARKER,
    `${input.operatorName}: ${stripPreviousTurn(input.previousMessage)}`,
    `You: ${reply}`,
    CURRENT_MESSAGE_MARKER,
    input.text,
  ].join('\n');
}

/** Inverse of withPreviousTurn: the text the human actually sent. */
export function stripPreviousTurn(text: string): string {
  const idx = text.indexOf(`\n${CURRENT_MESSAGE_MARKER}\n`);
  if (idx === -1 || !text.startsWith(PREVIOUS_TURN_MARKER)) return text;
  return text.slice(idx + CURRENT_MESSAGE_MARKER.length + 2);
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
    body: truncate(`${input.operatorName} (telegram): ${message}\n${outcome}`, MAX_EPISODE_CHARS),
    referenceTime: input.at,
  };
}

export async function writeBrainEpisode(
  config: BrainConfig,
  episode: BrainEpisode,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
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
  const session = init.headers.get('mcp-session-id') ?? undefined;
  await init.text();
  await (await call({ jsonrpc: '2.0', method: 'notifications/initialized' }, session)).text();
  await (
    await call(
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
            reference_time: episode.referenceTime,
          },
        },
      },
      session,
    )
  ).text();
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}
