/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * Pure function — translates SDK `CallToolResult.content` blocks to kernel
 * `ToolResult.content` (Phase 3 D-08 + Phase 5 D-16).
 *
 * Mapping rules (RESEARCH §CallToolResult.content shape lines 156-176):
 *
 *   | SDK block         | kernel ContentBlock                           |
 *   | ----------------- | --------------------------------------------- |
 *   | text              | { type: 'text', text }                        |
 *   | image (data)      | { type: 'image', bytes: data, mimeType }      |
 *   | audio (data)      | dropped — kernel has no 'audio' type yet      |
 *   | resource          | { type: 'resource', uri, text?, mimeType? }   |
 *   | resource_link     | { type: 'resource', uri, mimeType? }          |
 *
 * Optimization: single text-only block → flatten to flat-string content
 * (`ToolResult.content: string`) per D-08. Multi-block or non-text → array form.
 *
 * `result.isError` PRESERVED verbatim — tool-execution errors flow back
 * to the LLM as `role: 'tool'` messages per the kernel convention.
 *
 * `result._meta` (when present) is hoisted to `ToolResult.metadata._meta`.
 *
 * Pure: no I/O, no side effects, no SDK Client coupling — just a switch
 * over the SDK block type union.
 */

import type { ContentBlock, ToolResult } from '@kagent/agent-loop';

interface SdkContentBlock {
  type: 'text' | 'image' | 'audio' | 'resource' | 'resource_link';
  text?: string;
  data?: string;
  mimeType?: string;
  uri?: string;
  name?: string;
  resource?: { uri: string; text?: string; blob?: string; mimeType?: string };
}

interface SdkCallToolResult {
  content: SdkContentBlock[];
  isError?: boolean;
  _meta?: Record<string, unknown>;
}

export function mapMcpResultToToolResult(raw: SdkCallToolResult): ToolResult {
  const blocks = raw.content ?? [];
  const mapped: ContentBlock[] = [];

  for (const block of blocks) {
    switch (block.type) {
      case 'text':
        mapped.push({ type: 'text', text: block.text ?? '' });
        break;
      case 'image':
        if (block.data !== undefined && block.mimeType !== undefined) {
          mapped.push({ type: 'image', bytes: block.data, mimeType: block.mimeType });
        }
        break;
      case 'audio':
        // Kernel has no 'audio' type yet — drop with a placeholder text marker so
        // future expansion adds an 'audio' kernel ContentBlock rather than masking.
        mapped.push({
          type: 'text',
          text: `[audio block dropped: mimeType=${block.mimeType ?? 'unknown'}]`,
        });
        break;
      case 'resource':
        if (block.resource?.uri !== undefined) {
          const cb: ContentBlock = { type: 'resource', uri: block.resource.uri };
          if (block.resource.text !== undefined) cb.text = block.resource.text;
          if (block.resource.mimeType !== undefined) cb.mimeType = block.resource.mimeType;
          mapped.push(cb);
        }
        break;
      case 'resource_link':
        if (block.uri !== undefined) {
          const cb: ContentBlock = { type: 'resource', uri: block.uri };
          if (block.mimeType !== undefined) cb.mimeType = block.mimeType;
          mapped.push(cb);
        }
        break;
    }
  }

  // Single text block → flatten to string (D-08 ergonomic optimization).
  let content: string | ContentBlock[];
  if (mapped.length === 1 && mapped[0]?.type === 'text') {
    content = mapped[0].text ?? '';
  } else {
    content = mapped;
  }

  const result: ToolResult = {
    content,
    isError: raw.isError ?? false,
  };
  if (raw._meta !== undefined) {
    result.metadata = { _meta: raw._meta };
  }
  return result;
}
