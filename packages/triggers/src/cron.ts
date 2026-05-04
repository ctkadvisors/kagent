/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * Tiny 5-field cron evaluator (minute, hour, day-of-month, month,
 * day-of-week) — purpose-built for the `KagentSchedule` controller's
 * tick loop. Avoids adding a runtime dep on `node-cron` (which pulls in
 * timezone tables + scheduling primitives we don't need).
 *
 * Supports:
 *   - `*` wildcard
 *   - single integers: `5`
 *   - comma lists: `0,15,30,45`
 *   - ranges: `9-17`
 *   - step values: `*\/5` and `0-30/2`
 *   - day-of-week names case-insensitive: `mon,tue,wed`
 *
 * Does NOT support: `?`, `L`, `W`, `#`, named months, predefined macros
 * (`@daily` etc.), seconds field, year field. All v0.1 schedules can be
 * expressed in standard 5-field cron without these extensions; if a
 * caller needs them we'll either add them or pull in `cron-parser`.
 *
 * Time semantics: a UTC Date's minute boundary IS a tick if
 * `cronMatches(expr, date)` returns `true`. The controller calls
 * `cronMatches` once per minute on a UTC Date pinned to the top of the
 * minute. `nextTickAfter` computes the next matching minute boundary
 * strictly after the given Date — used for `status.nextTickAt` only.
 */

const DOW_NAMES: Readonly<Record<string, number>> = {
  sun: 0,
  mon: 1,
  tue: 2,
  wed: 3,
  thu: 4,
  fri: 5,
  sat: 6,
};

interface FieldBounds {
  readonly min: number;
  readonly max: number;
}

const MINUTE: FieldBounds = { min: 0, max: 59 };
const HOUR: FieldBounds = { min: 0, max: 23 };
const DOM: FieldBounds = { min: 1, max: 31 };
const MONTH: FieldBounds = { min: 1, max: 12 };
const DOW: FieldBounds = { min: 0, max: 6 };

/**
 * Parsed cron schedule. Each set holds the matching values for that
 * field. `dowAny` / `domAny` mark whether the field was a wildcard so
 * the standard cron OR-semantic between dom and dow can be applied:
 *   if both restricted → match if EITHER matches
 *   if only one restricted → match the restricted one
 *   if neither restricted → unconditionally match
 */
export interface ParsedSchedule {
  readonly minute: ReadonlySet<number>;
  readonly hour: ReadonlySet<number>;
  readonly dom: ReadonlySet<number>;
  readonly month: ReadonlySet<number>;
  readonly dow: ReadonlySet<number>;
  readonly domAny: boolean;
  readonly dowAny: boolean;
}

export class CronParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CronParseError';
  }
}

/**
 * Parse a 5-field cron expression. Throws CronParseError on bad input.
 */
export function parseCron(expr: string): ParsedSchedule {
  if (typeof expr !== 'string') {
    throw new CronParseError(`expected string cron expression, got ${typeof expr}`);
  }
  const trimmed = expr.trim();
  if (trimmed.length === 0) {
    throw new CronParseError('empty cron expression');
  }
  const parts = trimmed.split(/\s+/);
  if (parts.length !== 5) {
    throw new CronParseError(
      `cron expression must have 5 fields (minute hour dom month dow); got ${String(parts.length)}: ${expr}`,
    );
  }
  const [minRaw, hourRaw, domRaw, monthRaw, dowRaw] = parts as [
    string,
    string,
    string,
    string,
    string,
  ];
  return {
    minute: parseField(minRaw, MINUTE, 'minute'),
    hour: parseField(hourRaw, HOUR, 'hour'),
    dom: parseField(domRaw, DOM, 'day-of-month'),
    month: parseField(monthRaw, MONTH, 'month'),
    dow: parseField(dowRaw, DOW, 'day-of-week', DOW_NAMES),
    domAny: domRaw === '*',
    dowAny: dowRaw === '*',
  };
}

function parseField(
  raw: string,
  bounds: FieldBounds,
  label: string,
  nameMap?: Readonly<Record<string, number>>,
): ReadonlySet<number> {
  const out = new Set<number>();
  for (const piece of raw.split(',')) {
    const [rangePart, stepPart] = piece.split('/');
    if (rangePart === undefined) {
      throw new CronParseError(`bad ${label} field segment: '${piece}'`);
    }
    const step = stepPart === undefined ? 1 : Number.parseInt(stepPart, 10);
    if (!Number.isFinite(step) || step <= 0) {
      throw new CronParseError(`bad ${label} step value: '${piece}'`);
    }
    let lo: number;
    let hi: number;
    if (rangePart === '*') {
      lo = bounds.min;
      hi = bounds.max;
    } else if (rangePart.includes('-')) {
      const [loRaw, hiRaw] = rangePart.split('-');
      if (loRaw === undefined || hiRaw === undefined) {
        throw new CronParseError(`bad ${label} range: '${piece}'`);
      }
      lo = resolveAtom(loRaw, label, nameMap);
      hi = resolveAtom(hiRaw, label, nameMap);
    } else {
      lo = resolveAtom(rangePart, label, nameMap);
      hi = lo;
    }
    if (lo < bounds.min || hi > bounds.max || lo > hi) {
      throw new CronParseError(
        `bad ${label} range ${String(lo)}..${String(hi)} (allowed ${String(bounds.min)}..${String(bounds.max)}): '${piece}'`,
      );
    }
    for (let v = lo; v <= hi; v += step) {
      out.add(v);
    }
  }
  if (out.size === 0) {
    throw new CronParseError(`empty ${label} field: '${raw}'`);
  }
  return out;
}

function resolveAtom(
  atom: string,
  label: string,
  nameMap?: Readonly<Record<string, number>>,
): number {
  if (nameMap !== undefined) {
    const lower = atom.toLowerCase();
    if (lower in nameMap) {
      const v = nameMap[lower];
      if (v !== undefined) return v;
    }
  }
  const n = Number.parseInt(atom, 10);
  if (!Number.isFinite(n) || String(n) !== atom) {
    throw new CronParseError(`bad ${label} atom: '${atom}'`);
  }
  return n;
}

/**
 * Does the schedule match the given Date (UTC fields)?
 *
 * Matches if minute/hour/month all match AND the dom/dow OR-rule holds:
 *   - both fields wildcarded → match
 *   - either field non-wildcard and matches → match
 *   - both fields restricted, neither matches → no match
 */
export function cronMatches(parsed: ParsedSchedule, date: Date): boolean {
  if (!parsed.minute.has(date.getUTCMinutes())) return false;
  if (!parsed.hour.has(date.getUTCHours())) return false;
  if (!parsed.month.has(date.getUTCMonth() + 1)) return false;
  const domMatch = parsed.dom.has(date.getUTCDate());
  const dowMatch = parsed.dow.has(date.getUTCDay());
  if (parsed.domAny && parsed.dowAny) return true;
  if (parsed.domAny) return dowMatch;
  if (parsed.dowAny) return domMatch;
  return domMatch || dowMatch;
}

/**
 * Compute the first matching minute boundary strictly after `from`.
 * Caps at 4 years of forward search before giving up (returns
 * `undefined` so the controller logs and parks the schedule rather than
 * spinning).
 *
 * Naïve loop — adds 1 minute and re-checks. For 5-field cron the worst
 * case bounded by 4y * 365d * 24h * 60m = 2_103_840 iterations, which
 * runs in <100ms on Node 22 in cold benchmarks. Optimization is
 * unwarranted for v0.1.
 */
export function nextTickAfter(parsed: ParsedSchedule, from: Date): Date | undefined {
  // Round up to the next minute boundary (drop seconds/ms, then +1m).
  const start = new Date(
    Date.UTC(
      from.getUTCFullYear(),
      from.getUTCMonth(),
      from.getUTCDate(),
      from.getUTCHours(),
      from.getUTCMinutes() + 1,
      0,
      0,
    ),
  );
  const HORIZON_MS = 4 * 365 * 24 * 60 * 60 * 1000;
  const deadline = start.getTime() + HORIZON_MS;
  let cursor = start;
  while (cursor.getTime() <= deadline) {
    if (cronMatches(parsed, cursor)) return cursor;
    cursor = new Date(cursor.getTime() + 60_000);
  }
  return undefined;
}
