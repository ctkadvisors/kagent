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

export interface FleetSnapshot {
  readonly summary?: string;
  readonly memoryBySource?: Readonly<Record<string, number>>;
  readonly rules: readonly string[];
  readonly computedAt?: string;
}

/** Pull the compact facts out of the launcher's /missions payload. */
export function fleetSnapshot(payload: unknown): FleetSnapshot | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined;
  const fleet = (payload as { fleet?: Record<string, unknown> }).fleet;
  if (typeof fleet !== 'object' || fleet === null) return undefined;
  const health = fleet.health as
    | { summary?: unknown; memory?: { by_source?: unknown }; computed_at?: unknown }
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
  return {
    ...(typeof health?.summary === 'string' && { summary: health.summary }),
    ...(typeof bySource === 'object' &&
      bySource !== null && { memoryBySource: bySource as Record<string, number> }),
    ...(typeof health?.computed_at === 'string' && { computedAt: health.computed_at }),
    rules,
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
): Promise<string | undefined> {
  const res = await fetchImpl(`${fleetUrl.replace(/\/+$/u, '')}/missions`, {
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) return undefined;
  const snap = fleetSnapshot(await res.json());
  if (snap === undefined || (snap.summary === undefined && snap.rules.length === 0))
    return undefined;
  return renderFleetNow(snap);
}
