/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * The [fleet now] bridge (2026-09-09). Asked "what did the fleet learn", the
 * concierge made no tool call and said it could not see the fleet's memory,
 * while http.mission_list in its own toolbox carried it. Asked for status the
 * night before, it invented "both services restarting". A model that must
 * choose to look sometimes does not. So every inbound turn carries the
 * fleet's computed state, its memory counts by author, and its rules, fetched
 * from the mission launcher's /missions by the adapter, where no choice is
 * involved. Best effort: a launcher that does not answer leaves the message
 * as it was.
 */

import { CURRENT_MESSAGE_MARKER, PREVIOUS_TURN_MARKER } from './brain.js';

export const FLEET_NOW_MARKER = '[fleet now]';
const MAX_RULES = 6;
const MAX_RULE_CHARS = 220;

export interface FleetRow {
  readonly source: string;
  readonly at: string;
  readonly text: string;
}

export interface FleetSnapshot {
  readonly summary?: string;
  readonly memoryBySource?: Readonly<Record<string, number>>;
  readonly rules: readonly string[];
  /** The rows the fleet wrote itself lately: the only ones there are. */
  readonly recent: readonly FleetRow[];
  readonly computedAt?: string;
}

/** Pull the compact facts out of the launcher's /missions payload. */
export function fleetSnapshot(payload: unknown): FleetSnapshot | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined;
  const fleet = (payload as { fleet?: Record<string, unknown> }).fleet;
  if (typeof fleet !== 'object' || fleet === null) return undefined;
  const health = fleet.health as
    | {
        summary?: unknown;
        memory?: { by_source?: unknown; recent?: unknown };
        computed_at?: unknown;
      }
    | undefined;
  const memoryText = typeof fleet.memory === 'string' ? fleet.memory : '';
  const rules = memoryText
    .split('\n')
    .filter((line) => line.startsWith('- [feedback'))
    .map((line) => line.replace(/^- \[feedback[^\]]*\]\s*/u, '').trim())
    .filter((line) => line.length > 0)
    .slice(0, MAX_RULES)
    .map((line) =>
      line.length > MAX_RULE_CHARS ? `${line.slice(0, MAX_RULE_CHARS - 3)}...` : line,
    );
  const bySource = health?.memory?.by_source;
  const recentRaw = health?.memory?.recent;
  const recent: FleetRow[] = Array.isArray(recentRaw)
    ? recentRaw
        .filter(
          (r): r is FleetRow =>
            typeof r === 'object' && r !== null && typeof (r as FleetRow).text === 'string',
        )
        .map((r) => ({ source: String(r.source), at: String(r.at), text: r.text }))
    : [];
  return {
    ...(typeof health?.summary === 'string' && { summary: health.summary }),
    ...(typeof bySource === 'object' &&
      bySource !== null && { memoryBySource: bySource as Record<string, number> }),
    ...(typeof health?.computed_at === 'string' && { computedAt: health.computed_at }),
    rules,
    recent,
  };
}

export function renderFleetNow(snap: FleetSnapshot): string {
  const lines: string[] = [FLEET_NOW_MARKER];
  if (snap.summary) lines.push(snap.summary);
  if (snap.memoryBySource) {
    const parts = Object.entries(snap.memoryBySource)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k} ${String(v)}`);
    lines.push(
      `memory rows by author: ${parts.join(', ')} (chris and claude are the mentors' seed; the rest the fleet wrote itself)`,
    );
  }
  if (snap.rules.length > 0) lines.push('rules:', ...snap.rules.map((r) => `- ${r}`));
  if (snap.recent.length > 0)
    lines.push(
      'written by the fleet itself lately (these are all of them; list only these, with their author):',
      ...snap.recent.map((r) => `- [${r.source} ${r.at}] ${r.text}`),
    );
  if (snap.computedAt) lines.push(`computed_at ${snap.computedAt}`);
  return lines.join('\n');
}

/**
 * Put the block in front of the human's message, inside the existing bridge
 * when there is one, so stripPreviousTurn still finds the raw text.
 */
export function withFleetNow(text: string, block: string): string {
  const marker = `\n${CURRENT_MESSAGE_MARKER}\n`;
  const idx = text.indexOf(marker);
  if (text.startsWith(PREVIOUS_TURN_MARKER) && idx !== -1) {
    return `${text.slice(0, idx)}\n${block}${text.slice(idx)}`;
  }
  return [block, CURRENT_MESSAGE_MARKER, text].join('\n');
}

export async function fetchFleetNow(
  fleetUrl: string,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = 5000,
  query?: string,
): Promise<string | undefined> {
  // ?q=<message>: the launcher recalls the lessons that overlap this message.
  const q =
    query === undefined || query.trim() === ''
      ? ''
      : `?q=${encodeURIComponent(query.slice(0, 500))}`;
  const res = await fetchImpl(`${fleetUrl.replace(/\/+$/u, '')}/missions${q}`, {
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) return undefined;
  const snap = fleetSnapshot(await res.json());
  if (snap === undefined || (snap.summary === undefined && snap.rules.length === 0))
    return undefined;
  return renderFleetNow(snap);
}

/**
 * A message that starts with "rule:" (or "remember:") is an instruction for
 * the whole fleet, and the fleet's memory is the ledger, not the model's
 * choice of tool: asked to keep one on 2026-09-09 the concierge wrote it to
 * the brain and said the fleet had it. The adapter records it first, and the
 * [fleet now] block tells the model what happened so the reply is true.
 */
const RULE_PREFIX = /^\s*(?:rule|remember)\s*:\s*(\S[\s\S]{6,})$/iu;

export function ruleIn(text: string): string | undefined {
  const m = RULE_PREFIX.exec(text);
  const captured = m?.[1];
  return captured === undefined ? undefined : captured.replace(/\s+/gu, ' ').trim();
}

export type RuleRecord =
  | { readonly ok: true; readonly post: number }
  | { readonly ok: false; readonly error: string };

export async function recordRule(
  fleetUrl: string,
  text: string,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = 5000,
): Promise<RuleRecord> {
  try {
    const res = await fetchImpl(`${fleetUrl.replace(/\/+$/u, '')}/remember`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text, ref: 'telegram' }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return { ok: false, error: `launcher answered HTTP ${res.status}` };
    const body = (await res.json()) as { post?: unknown };
    return { ok: true, post: typeof body.post === 'number' ? body.post : 0 };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** The line the model reads about a rule this message carried. */
export function renderRuleRecord(rule: string, r: RuleRecord): string {
  return r.ok
    ? `recorded just now, from this very message, as a rule in the fleet's memory (forum post ${r.post}): "${rule}". Confirm that in one line; there is nothing else to save.`
    : `could NOT record this message's rule in the fleet's memory (${r.error}). Say exactly that; do not claim it was saved anywhere.`;
}
