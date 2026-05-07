/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

import { describe, expect, it } from 'vitest';

import { scrubErrorMessage, scrubSecrets } from './error-scrub.js';

describe('scrubSecrets — workbench-api projection', () => {
  it('redacts OpenAI sk- keys', () => {
    const out = scrubSecrets('Incorrect API key sk-abcdefghijklmnop1234');
    expect(out).toContain('[REDACTED]');
    expect(out).not.toMatch(/sk-[A-Za-z0-9_-]{16,}/);
  });

  it('redacts sk-proj- keys (longer prefix wins over generic sk-)', () => {
    const out = scrubSecrets('key=sk-proj-abcdefghijklmnop1234');
    expect(out).toContain('[REDACTED]');
    expect(out).not.toMatch(/sk-proj-[A-Za-z0-9_-]{16,}/);
  });

  it('redacts sk-ant- (Anthropic) keys', () => {
    const out = scrubSecrets('Authorization: sk-ant-api01-abcdefghijklmnop1234');
    expect(out).toContain('[REDACTED]');
    expect(out).not.toMatch(/sk-ant-[A-Za-z0-9_-]{16,}/);
  });

  it('redacts Google AIza keys (39 chars)', () => {
    const out = scrubSecrets('error: AIzaSyBabcdefghijklmnopqrstuvwxyz12345abcd');
    expect(out).toContain('[REDACTED]');
    expect(out).not.toMatch(/AIza[0-9A-Za-z_-]{35}/);
  });

  it('redacts AWS access key prefixes', () => {
    const out = scrubSecrets('AccessKeyId: AKIAIOSFODNN7EXAMPLE');
    expect(out).toContain('[REDACTED]');
    expect(out).not.toMatch(/AKIA[0-9A-Z]{16}/);
  });

  it('redacts Bearer header echoes', () => {
    const out = scrubSecrets('Authorization: Bearer abc.def.ghi-jkl-mno.pqr.stu');
    expect(out).toContain('[REDACTED]');
  });

  it('passes through clean text unchanged', () => {
    const out = scrubSecrets('upstream timed out after 60s');
    expect(out).toBe('upstream timed out after 60s');
  });
});

describe('scrubErrorMessage — null/undefined passthrough', () => {
  it('passes null through unchanged', () => {
    expect(scrubErrorMessage(null)).toBe(null);
  });

  it('passes undefined through unchanged', () => {
    expect(scrubErrorMessage(undefined)).toBe(undefined);
  });

  it('scrubs an empty string to itself', () => {
    expect(scrubErrorMessage('')).toBe('');
  });

  it('scrubs a string containing a secret', () => {
    const out = scrubErrorMessage('Invalid: sk-abcdefghijklmnop1234');
    expect(out).toContain('[REDACTED]');
  });
});
