/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

import { describe, it, expect } from 'vitest';
import { mapMcpResultToToolResult } from './content-mapper.js';

describe('mapMcpResultToToolResult', () => {
  it('Test 1 — single text block flattens to flat-string content', () => {
    const result = mapMcpResultToToolResult({
      content: [{ type: 'text', text: 'hello' }],
      isError: false,
    });
    expect(result).toEqual({ content: 'hello', isError: false });
  });

  it('Test 2 — multi-block result returns ContentBlock[] form', () => {
    const result = mapMcpResultToToolResult({
      content: [
        { type: 'text', text: 'a' },
        { type: 'text', text: 'b' },
      ],
      isError: false,
    });
    expect(result.content).toEqual([
      { type: 'text', text: 'a' },
      { type: 'text', text: 'b' },
    ]);
    expect(result.isError).toBe(false);
  });

  it('Test 3 — image block: data → bytes rename + mimeType preserved', () => {
    const result = mapMcpResultToToolResult({
      content: [{ type: 'image', data: 'AAAA', mimeType: 'image/png' }],
      isError: false,
    });
    expect(result.content).toEqual([{ type: 'image', bytes: 'AAAA', mimeType: 'image/png' }]);
  });

  it('Test 4 — audio block: dropped with text placeholder marker (single block flattens to string)', () => {
    const result = mapMcpResultToToolResult({
      content: [{ type: 'audio', data: 'X', mimeType: 'audio/mp3' }],
      isError: false,
    });
    // Single mapped text block flattens to flat-string (D-08).
    expect(typeof result.content).toBe('string');
    const text = result.content as string;
    expect(text).toContain('audio block dropped');
    expect(text).toContain('audio/mp3');
  });

  it('Test 5 — resource block: nested resource fields hoisted', () => {
    const result = mapMcpResultToToolResult({
      content: [
        {
          type: 'resource',
          resource: { uri: 'file:///a', text: 'contents', mimeType: 'text/plain' },
        },
      ],
      isError: false,
    });
    expect(result.content).toEqual([
      {
        type: 'resource',
        uri: 'file:///a',
        text: 'contents',
        mimeType: 'text/plain',
      },
    ]);
  });

  it('Test 6 — resource_link: degraded to resource with uri-only', () => {
    const result = mapMcpResultToToolResult({
      content: [{ type: 'resource_link', uri: 'https://x', name: 'X', mimeType: 'text/html' }],
      isError: false,
    });
    expect(result.content).toEqual([
      {
        type: 'resource',
        uri: 'https://x',
        mimeType: 'text/html',
      },
    ]);
  });

  it('Test 7 — isError true preserved on output (NOT thrown)', () => {
    const result = mapMcpResultToToolResult({
      content: [{ type: 'text', text: 'tool failed' }],
      isError: true,
    });
    expect(result).toEqual({ content: 'tool failed', isError: true });
  });

  it('Test 8 — empty content array → empty content (default isError false)', () => {
    const result = mapMcpResultToToolResult({ content: [] });
    expect(result.content).toEqual([]);
    expect(result.isError).toBe(false);
  });

  it('Test 9 — _meta hoisted to metadata._meta', () => {
    const result = mapMcpResultToToolResult({
      content: [{ type: 'text', text: 'hi' }],
      isError: false,
      _meta: { upstreamRequestId: 'r1' },
    });
    expect(result.metadata).toEqual({ _meta: { upstreamRequestId: 'r1' } });
  });

  it('Test 10 — branch coverage: text block with missing text falls back to empty string', () => {
    const result = mapMcpResultToToolResult({
      content: [{ type: 'text' }],
      isError: false,
    });
    expect(result.content).toBe('');
  });

  it('Test 11 — branch coverage: image block missing data is dropped', () => {
    const result = mapMcpResultToToolResult({
      content: [{ type: 'image', mimeType: 'image/png' }],
      isError: false,
    });
    expect(result.content).toEqual([]);
  });

  it('Test 12 — branch coverage: resource block without resource is dropped', () => {
    const result = mapMcpResultToToolResult({
      content: [{ type: 'resource' }],
      isError: false,
    });
    expect(result.content).toEqual([]);
  });

  it('Test 13 — branch coverage: resource_link missing uri is dropped', () => {
    const result = mapMcpResultToToolResult({
      content: [{ type: 'resource_link', name: 'X' }],
      isError: false,
    });
    expect(result.content).toEqual([]);
  });

  it('Test 14 — branch coverage: audio block with no mimeType uses unknown marker', () => {
    const result = mapMcpResultToToolResult({
      content: [{ type: 'audio', data: 'X' }],
      isError: false,
    });
    // Single audio block maps to one text block which flattens to flat-string content.
    expect(result.content as string).toContain('mimeType=unknown');
  });

  it('Test 15 — branch coverage: resource block with only required uri (no text/mimeType)', () => {
    const result = mapMcpResultToToolResult({
      content: [{ type: 'resource', resource: { uri: 'file:///b' } }],
      isError: false,
    });
    expect(result.content).toEqual([{ type: 'resource', uri: 'file:///b' }]);
  });

  it('Test 16 — branch coverage: resource_link without mimeType', () => {
    const result = mapMcpResultToToolResult({
      content: [{ type: 'resource_link', uri: 'https://y' }],
      isError: false,
    });
    expect(result.content).toEqual([{ type: 'resource', uri: 'https://y' }]);
  });

  it('Test 17 — branch coverage: missing isError defaults to false', () => {
    const result = mapMcpResultToToolResult({
      content: [{ type: 'text', text: 'x' }],
    });
    expect(result.isError).toBe(false);
  });
});
