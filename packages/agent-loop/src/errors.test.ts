/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

import { describe, it, expect } from 'vitest';
import {
  AgentRegistryError,
  DuplicateAgentTypeError,
  DuplicateSkillIdError,
  UnknownAgentTypeError,
} from './errors.js';

describe('error classes — instanceof across dual-emit', () => {
  it('SC4h: DuplicateAgentTypeError — instanceof own class, parent, and Error', () => {
    const err = new DuplicateAgentTypeError('chat');
    expect(err).toBeInstanceOf(DuplicateAgentTypeError);
    expect(err).toBeInstanceOf(AgentRegistryError);
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('DuplicateAgentTypeError');
    expect(err.type).toBe('chat');
    expect(err.message).toContain('chat');
    expect(err.message).toContain('already registered');
  });

  it('SC4h: DuplicateSkillIdError — instanceof own class, parent, and Error; preserves type + skillId fields', () => {
    const err = new DuplicateSkillIdError('chat', 'talk');
    expect(err).toBeInstanceOf(DuplicateSkillIdError);
    expect(err).toBeInstanceOf(AgentRegistryError);
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('DuplicateSkillIdError');
    expect(err.type).toBe('chat');
    expect(err.skillId).toBe('talk');
    expect(err.message).toContain('chat');
    expect(err.message).toContain('talk');
  });

  it('SC4g: UnknownAgentTypeError — message embeds the type; instanceof parent', () => {
    const err = new UnknownAgentTypeError('nonesuch');
    expect(err).toBeInstanceOf(UnknownAgentTypeError);
    expect(err).toBeInstanceOf(AgentRegistryError);
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('UnknownAgentTypeError');
    expect(err.type).toBe('nonesuch');
    expect(err.message).toContain('nonesuch');
    expect(err.message).toContain('is not registered');
  });

  it('AgentRegistryError parent can be thrown and caught directly', () => {
    expect(() => {
      throw new AgentRegistryError('synthetic');
    }).toThrow(AgentRegistryError);
  });
});

// Phase 3 additions — AgentExecutor error family.
import {
  AgentExecutorError,
  AgentNotFoundError,
  NoLLMClientError,
  NoToolProviderError,
  InvalidConfigError,
  NotImplementedError,
  DuplicateToolNameError,
} from './errors.js';

// Phase 4 additions — LLMClient error family (D-16).
import {
  LLMClientError,
  LLMClientHttpError,
  LLMClientProtocolError,
  LLMClientAbortError,
  LLMClientTimeoutError,
} from './errors.js';

// Phase 5 additions — ToolProvider error family (D-24).
import {
  ToolProviderError,
  HttpToolProviderNetworkError,
  HttpToolProviderConfigError,
  McpToolProviderProtocolError,
  McpToolProviderSubprocessError,
  McpToolProviderAbortError,
} from './errors.js';

describe('AgentExecutor error family (Phase 3)', () => {
  it('SC7.1: AgentNotFoundError — instanceof own class, AgentExecutorError, Error; .agentType set', () => {
    const err = new AgentNotFoundError('chat');
    expect(err).toBeInstanceOf(AgentNotFoundError);
    expect(err).toBeInstanceOf(AgentExecutorError);
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('AgentNotFoundError');
    expect(err.agentType).toBe('chat');
    expect(err.message).toContain('chat');
    expect(err.message).toContain('not registered');
  });

  it('SC7.2: NoToolProviderError — instanceof, .toolName set, message contains tool name', () => {
    const err = new NoToolProviderError('echo');
    expect(err).toBeInstanceOf(NoToolProviderError);
    expect(err).toBeInstanceOf(AgentExecutorError);
    expect(err.name).toBe('NoToolProviderError');
    expect(err.toolName).toBe('echo');
    expect(err.message).toContain('echo');
  });

  it('SC7.3: InvalidConfigError — instanceof, .field set', () => {
    const err = new InvalidConfigError('maxIterations', 'must be positive');
    expect(err).toBeInstanceOf(InvalidConfigError);
    expect(err).toBeInstanceOf(AgentExecutorError);
    expect(err.field).toBe('maxIterations');
    expect(err.message).toContain('maxIterations');
    expect(err.message).toContain('must be positive');
  });

  it('SC7.4: NotImplementedError — instanceof, .capability set', () => {
    const err = new NotImplementedError('embed');
    expect(err).toBeInstanceOf(NotImplementedError);
    expect(err).toBeInstanceOf(AgentExecutorError);
    expect(err.capability).toBe('embed');
    expect(err.message).toContain('embed');
  });

  it('NoLLMClientError — instanceof, no typed field; static message', () => {
    const err = new NoLLMClientError();
    expect(err).toBeInstanceOf(NoLLMClientError);
    expect(err).toBeInstanceOf(AgentExecutorError);
    expect(err.message).toContain('LLMClient');
  });

  it('DuplicateToolNameError — instanceof, .toolName + .providerId set', () => {
    const err = new DuplicateToolNameError('echo', 'p2');
    expect(err).toBeInstanceOf(DuplicateToolNameError);
    expect(err).toBeInstanceOf(AgentExecutorError);
    expect(err.toolName).toBe('echo');
    expect(err.providerId).toBe('p2');
    expect(err.message).toContain('echo');
    expect(err.message).toContain('p2');
  });

  it('AgentExecutorError parent can be thrown and caught directly', () => {
    expect(() => {
      throw new AgentExecutorError('synthetic');
    }).toThrow(AgentExecutorError);
  });
});

describe('LLMClient error family (Phase 4 — D-16)', () => {
  it('LLMClientError parent — direct instantiation, instanceof Error, name set', () => {
    const err = new LLMClientError('synthetic parent throw');
    expect(err).toBeInstanceOf(LLMClientError);
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('LLMClientError');
    expect(err.message).toBe('synthetic parent throw');
  });

  it('LLMClientHttpError — full instanceof chain; .status / .body / .requestId set; message contains status', () => {
    const err = new LLMClientHttpError(429, 'rate limited', 'req-abc');
    expect(err).toBeInstanceOf(LLMClientHttpError);
    expect(err).toBeInstanceOf(LLMClientError);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(AgentExecutorError); // sibling families
    expect(err.name).toBe('LLMClientHttpError');
    expect(err.status).toBe(429);
    expect(err.body).toBe('rate limited');
    expect(err.requestId).toBe('req-abc');
    expect(err.message).toContain('429');
  });

  it('LLMClientHttpError — omitted optional fields are undefined (NOT empty string)', () => {
    const err = new LLMClientHttpError(500);
    expect(err.status).toBe(500);
    expect(err.body).toBeUndefined();
    expect(err.requestId).toBeUndefined();
    expect(err.retryAfterSec).toBeUndefined();
    // exactOptionalPropertyTypes verification: the property either isn't set or is undefined
    expect('body' in err ? err.body : undefined).toBeUndefined();
  });

  it('LLMClientHttpError — retryAfterSec round-trips when supplied (gateway 429 + Retry-After)', () => {
    const err = new LLMClientHttpError(429, 'at capacity', 'req-1', 2);
    expect(err.status).toBe(429);
    expect(err.retryAfterSec).toBe(2);
    expect(err.body).toBe('at capacity');
    expect(err.requestId).toBe('req-1');
  });

  it('LLMClientProtocolError — instanceof chain; .raw round-trips arbitrary unknown', () => {
    const payload = { partial: 'sse', bytes: 47 };
    const err = new LLMClientProtocolError('malformed SSE event', payload);
    expect(err).toBeInstanceOf(LLMClientProtocolError);
    expect(err).toBeInstanceOf(LLMClientError);
    expect(err.name).toBe('LLMClientProtocolError');
    expect(err.raw).toBe(payload);
    expect(err.message).toContain('malformed SSE event');
  });

  it('LLMClientAbortError — parameter-free; instanceof chain; message mentions abort', () => {
    const err = new LLMClientAbortError();
    expect(err).toBeInstanceOf(LLMClientAbortError);
    expect(err).toBeInstanceOf(LLMClientError);
    expect(err.name).toBe('LLMClientAbortError');
    expect(err.message.toLowerCase()).toContain('abort');
  });

  it('LLMClientTimeoutError — instanceof chain; .timeoutMs round-trips; message contains the value', () => {
    const err = new LLMClientTimeoutError(30000);
    expect(err).toBeInstanceOf(LLMClientTimeoutError);
    expect(err).toBeInstanceOf(LLMClientError);
    expect(err.name).toBe('LLMClientTimeoutError');
    expect(err.timeoutMs).toBe(30000);
    expect(err.message).toContain('30000');
  });

  it('T-LLM-01: error messages NEVER contain "Bearer ", "sk-", or "Authorization" — apiKey leak guard', () => {
    // Adapter MUST NOT interpolate request headers (which carry the apiKey)
    // into any error field. Verify the constructors themselves are safe even
    // if a sloppy call site passes a body that contains those strings.
    const errorBody = '{"error":{"message":"invalid_api_key","code":"invalid_api_key"}}';
    const err = new LLMClientHttpError(401, errorBody);

    // The body field itself MAY contain whatever the backend returned; but
    // the message MUST be backend-status-only — no leakage of apiKey-shaped
    // strings INTO the message field.
    expect(err.message).not.toContain('Bearer');
    expect(err.message).not.toContain('sk-');
    expect(err.message).not.toContain('Authorization');

    // The body field receives whatever was passed (call-site responsibility);
    // assert message-level isolation only.
    expect(err.message).toBe('LLM backend returned HTTP 401');
  });

  it('subclasses preserve sibling-family separation: NOT instanceof AgentExecutorError or AgentRegistryError', () => {
    const errs = [
      new LLMClientHttpError(500),
      new LLMClientProtocolError('x', null),
      new LLMClientAbortError(),
      new LLMClientTimeoutError(1),
    ];
    for (const err of errs) {
      expect(err).not.toBeInstanceOf(AgentExecutorError);
      expect(err).not.toBeInstanceOf(AgentRegistryError);
      expect(err).toBeInstanceOf(LLMClientError);
    }
  });
});

describe('ToolProvider error family (Phase 5 — D-24)', () => {
  it('ToolProviderError parent — direct instantiation, instanceof Error, name set', () => {
    const err = new ToolProviderError('synthetic parent throw');
    expect(err).toBeInstanceOf(ToolProviderError);
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('ToolProviderError');
    expect(err.message).toBe('synthetic parent throw');
  });

  it('HttpToolProviderNetworkError — full instanceof chain; message round-trips', () => {
    const err = new HttpToolProviderNetworkError('connect ECONNREFUSED');
    expect(err).toBeInstanceOf(HttpToolProviderNetworkError);
    expect(err).toBeInstanceOf(ToolProviderError);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(AgentExecutorError);
    expect(err).not.toBeInstanceOf(LLMClientError);
    expect(err).not.toBeInstanceOf(AgentRegistryError);
    expect(err.name).toBe('HttpToolProviderNetworkError');
    expect(err.message).toBe('connect ECONNREFUSED');
  });

  it('HttpToolProviderConfigError — full instanceof chain; message round-trips', () => {
    const err = new HttpToolProviderConfigError('Path placeholder "{id}" has no matching argument');
    expect(err).toBeInstanceOf(HttpToolProviderConfigError);
    expect(err).toBeInstanceOf(ToolProviderError);
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('HttpToolProviderConfigError');
    expect(err.message).toContain('Path placeholder');
  });

  it('McpToolProviderProtocolError — full instanceof chain; message round-trips', () => {
    const err = new McpToolProviderProtocolError('JSON-RPC InvalidRequest');
    expect(err).toBeInstanceOf(McpToolProviderProtocolError);
    expect(err).toBeInstanceOf(ToolProviderError);
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('McpToolProviderProtocolError');
    expect(err.message).toContain('JSON-RPC InvalidRequest');
  });

  it('McpToolProviderSubprocessError — full instanceof chain; message round-trips', () => {
    const err = new McpToolProviderSubprocessError('spawn ENOENT');
    expect(err).toBeInstanceOf(McpToolProviderSubprocessError);
    expect(err).toBeInstanceOf(ToolProviderError);
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('McpToolProviderSubprocessError');
    expect(err.message).toContain('spawn ENOENT');
  });

  it('McpToolProviderAbortError — parameter-free; instanceof chain; locked message', () => {
    const err = new McpToolProviderAbortError();
    expect(err).toBeInstanceOf(McpToolProviderAbortError);
    expect(err).toBeInstanceOf(ToolProviderError);
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('McpToolProviderAbortError');
    expect(err.message).toBe('MCP tool call aborted via AbortSignal');
  });

  it('subclasses preserve sibling-family separation: NOT instanceof LLMClient/AgentExecutor/AgentRegistry families', () => {
    const errs = [
      new HttpToolProviderNetworkError('x'),
      new HttpToolProviderConfigError('x'),
      new McpToolProviderProtocolError('x'),
      new McpToolProviderSubprocessError('x'),
      new McpToolProviderAbortError(),
    ];
    for (const err of errs) {
      expect(err).toBeInstanceOf(ToolProviderError);
      expect(err).not.toBeInstanceOf(AgentExecutorError);
      expect(err).not.toBeInstanceOf(LLMClientError);
      expect(err).not.toBeInstanceOf(AgentRegistryError);
    }
  });
});
