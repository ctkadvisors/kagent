/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

import { describe, expect, it } from 'vitest';

import { CronParseError, cronMatches, nextTickAfter, parseCron } from './cron.js';

const utc = (year: number, month: number, day: number, hour: number, minute: number): Date =>
  new Date(Date.UTC(year, month - 1, day, hour, minute, 0, 0));

describe('parseCron', () => {
  it('parses a 5-field wildcard expression', () => {
    const p = parseCron('* * * * *');
    expect(p.minute.size).toBe(60);
    expect(p.hour.size).toBe(24);
    expect(p.dom.size).toBe(31);
    expect(p.month.size).toBe(12);
    expect(p.dow.size).toBe(7);
    expect(p.domAny).toBe(true);
    expect(p.dowAny).toBe(true);
  });

  it('parses single integers', () => {
    const p = parseCron('5 9 1 1 1');
    expect(Array.from(p.minute)).toEqual([5]);
    expect(Array.from(p.hour)).toEqual([9]);
    expect(Array.from(p.dom)).toEqual([1]);
    expect(Array.from(p.month)).toEqual([1]);
    expect(Array.from(p.dow)).toEqual([1]);
    expect(p.domAny).toBe(false);
    expect(p.dowAny).toBe(false);
  });

  it('parses comma-list and range', () => {
    const p = parseCron('0,15,30,45 9-17 * * *');
    expect(Array.from(p.minute).sort((a, b) => a - b)).toEqual([0, 15, 30, 45]);
    expect(Array.from(p.hour).sort((a, b) => a - b)).toEqual([9, 10, 11, 12, 13, 14, 15, 16, 17]);
  });

  it('parses step values with wildcards', () => {
    const p = parseCron('*/15 * * * *');
    expect(Array.from(p.minute).sort((a, b) => a - b)).toEqual([0, 15, 30, 45]);
  });

  it('parses step values with explicit ranges', () => {
    const p = parseCron('0-30/10 * * * *');
    expect(Array.from(p.minute).sort((a, b) => a - b)).toEqual([0, 10, 20, 30]);
  });

  it('accepts day-of-week names case-insensitive', () => {
    const p = parseCron('0 0 * * MON');
    expect(Array.from(p.dow)).toEqual([1]);
  });

  it('rejects an empty expression', () => {
    expect(() => parseCron('')).toThrow(CronParseError);
  });

  it('rejects fewer than 5 fields', () => {
    expect(() => parseCron('* * * *')).toThrow(CronParseError);
  });

  it('rejects more than 5 fields', () => {
    expect(() => parseCron('* * * * * *')).toThrow(CronParseError);
  });

  it('rejects out-of-range minute', () => {
    expect(() => parseCron('60 * * * *')).toThrow(CronParseError);
  });

  it('rejects bad atoms', () => {
    expect(() => parseCron('abc * * * *')).toThrow(CronParseError);
  });

  it('rejects step zero', () => {
    expect(() => parseCron('*/0 * * * *')).toThrow(CronParseError);
  });
});

describe('cronMatches', () => {
  it('matches every minute for the wildcard expression', () => {
    const p = parseCron('* * * * *');
    expect(cronMatches(p, utc(2026, 5, 3, 0, 0))).toBe(true);
    expect(cronMatches(p, utc(2026, 5, 3, 23, 59))).toBe(true);
  });

  it('matches the configured minute only', () => {
    const p = parseCron('5 * * * *');
    expect(cronMatches(p, utc(2026, 5, 3, 12, 5))).toBe(true);
    expect(cronMatches(p, utc(2026, 5, 3, 12, 4))).toBe(false);
    expect(cronMatches(p, utc(2026, 5, 3, 12, 6))).toBe(false);
  });

  it('matches every-15-minute schedule', () => {
    const p = parseCron('*/15 * * * *');
    expect(cronMatches(p, utc(2026, 5, 3, 12, 0))).toBe(true);
    expect(cronMatches(p, utc(2026, 5, 3, 12, 15))).toBe(true);
    expect(cronMatches(p, utc(2026, 5, 3, 12, 30))).toBe(true);
    expect(cronMatches(p, utc(2026, 5, 3, 12, 45))).toBe(true);
    expect(cronMatches(p, utc(2026, 5, 3, 12, 1))).toBe(false);
  });

  it('OR-matches dom and dow when both restricted', () => {
    // 1st day of month OR Monday → match either
    const p = parseCron('0 0 1 * 1');
    expect(cronMatches(p, utc(2026, 5, 1, 0, 0))).toBe(true); // 1st of May 2026 (Friday)
    expect(cronMatches(p, utc(2026, 5, 4, 0, 0))).toBe(true); // Mon May 4
    expect(cronMatches(p, utc(2026, 5, 6, 0, 0))).toBe(false); // Wed May 6
  });

  it('AND-matches month + minute fields', () => {
    const p = parseCron('30 6 * 12 *');
    expect(cronMatches(p, utc(2026, 12, 25, 6, 30))).toBe(true);
    expect(cronMatches(p, utc(2026, 11, 25, 6, 30))).toBe(false);
  });
});

describe('nextTickAfter', () => {
  it('finds the next minute boundary for *', () => {
    const p = parseCron('* * * * *');
    const from = new Date(Date.UTC(2026, 4, 3, 12, 30, 30, 500));
    const next = nextTickAfter(p, from);
    expect(next).toBeInstanceOf(Date);
    // Round-up of a 12:30:30.500 → next tick is 12:31:00 for `*`.
    expect(next?.getUTCSeconds()).toBe(0);
    expect(next?.getUTCMilliseconds()).toBe(0);
    expect(next?.getUTCMinutes()).toBe(31);
  });

  it('finds the daily 06:00 tick', () => {
    const p = parseCron('0 6 * * *');
    const from = utc(2026, 5, 3, 7, 0);
    const next = nextTickAfter(p, from);
    expect(next).toBeInstanceOf(Date);
    expect(next?.getUTCHours()).toBe(6);
    expect(next?.getUTCMinutes()).toBe(0);
    expect(next?.getUTCDate()).toBe(4);
  });

  it('rolls forward across a year for an exotic schedule', () => {
    const p = parseCron('0 0 29 2 *');
    // 2026-Feb has no 29th; 2027 either; 2028 is a leap year → next match.
    const from = utc(2026, 5, 3, 0, 0);
    const next = nextTickAfter(p, from);
    expect(next).toBeInstanceOf(Date);
    expect(next?.getUTCFullYear()).toBe(2028);
    expect(next?.getUTCMonth()).toBe(1);
    expect(next?.getUTCDate()).toBe(29);
  });
});
