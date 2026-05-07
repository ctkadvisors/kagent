/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

import { describe, expect, it } from 'vitest';

import {
  applyResolvedModel,
  resolveAgentModel,
  type ModelClassMap,
} from './model-class-resolver.js';

describe('resolveAgentModel', () => {
  const emptyMap: ModelClassMap = {};
  const map: ModelClassMap = {
    'tool-caller-default': 'workers-ai/@cf/meta/llama-4-scout-17b-16e-instruct',
    'text-generator-default': 'ollama/nemotron-3-nano:4b',
    'reasoner-default': 'workers-ai/@cf/meta/llama-4-scout-17b-16e-instruct',
  };

  /* --------------------- escape-hatch (model wins) --------------------- */

  it('resolves to spec.model with source=override when only model is set', () => {
    const result = resolveAgentModel({
      agentSpec: { model: 'workers-ai/@cf/meta/llama-4-scout-17b-16e-instruct' },
      classMap: emptyMap,
    });
    expect(result).toEqual({
      kind: 'resolved',
      model: 'workers-ai/@cf/meta/llama-4-scout-17b-16e-instruct',
      source: 'override',
    });
  });

  it('prefers spec.model over spec.modelClass when both are set (model wins)', () => {
    const result = resolveAgentModel({
      agentSpec: {
        model: 'anthropic/claude-3-7-sonnet-20250219',
        modelClass: 'tool-caller-default',
      },
      classMap: map,
    });
    expect(result).toEqual({
      kind: 'resolved',
      model: 'anthropic/claude-3-7-sonnet-20250219',
      source: 'override',
    });
  });

  /* ------------------------ class resolution path ---------------------- */

  it('resolves modelClass against classMap with source=class when only modelClass is set', () => {
    const result = resolveAgentModel({
      agentSpec: { modelClass: 'tool-caller-default' },
      classMap: map,
    });
    expect(result).toEqual({
      kind: 'resolved',
      model: 'workers-ai/@cf/meta/llama-4-scout-17b-16e-instruct',
      source: 'class',
    });
  });

  it('treats empty-string model as absent and falls through to modelClass', () => {
    // CRD admission allows model:'' if modelClass carries the validity;
    // resolver must mirror that semantic, not treat the empty string as
    // an explicit override.
    const result = resolveAgentModel({
      agentSpec: { model: '', modelClass: 'reasoner-default' },
      classMap: map,
    });
    expect(result).toEqual({
      kind: 'resolved',
      model: 'workers-ai/@cf/meta/llama-4-scout-17b-16e-instruct',
      source: 'class',
    });
  });

  it('treats whitespace-only model as absent and falls through to modelClass', () => {
    const result = resolveAgentModel({
      agentSpec: { model: '   \t\n', modelClass: 'tool-caller-default' },
      classMap: map,
    });
    expect(result).toEqual({
      kind: 'resolved',
      model: 'workers-ai/@cf/meta/llama-4-scout-17b-16e-instruct',
      source: 'class',
    });
  });

  /* ------------------------ unresolvable: missing key ------------------ */

  it('returns unresolvable when modelClass key is not in classMap', () => {
    const result = resolveAgentModel({
      agentSpec: { modelClass: 'tool-caller-strict' },
      classMap: map,
    });
    expect(result.kind).toBe('unresolvable');
    if (result.kind === 'unresolvable') {
      expect(result.modelClass).toBe('tool-caller-strict');
      expect(result.reason).toContain('tool-caller-strict');
      expect(result.reason).toContain('not in cluster config');
    }
  });

  it('returns unresolvable when classMap is empty (no classes configured)', () => {
    const result = resolveAgentModel({
      agentSpec: { modelClass: 'tool-caller-default' },
      classMap: emptyMap,
    });
    expect(result.kind).toBe('unresolvable');
    if (result.kind === 'unresolvable') {
      expect(result.modelClass).toBe('tool-caller-default');
    }
  });

  it('returns unresolvable when modelClass key maps to an empty string', () => {
    // Defense-in-depth: a misconfigured chart could ship a class with
    // an empty model. The resolver refuses; the operator must log loud.
    const result = resolveAgentModel({
      agentSpec: { modelClass: 'broken-class' },
      classMap: { 'broken-class': '' },
    });
    expect(result.kind).toBe('unresolvable');
    if (result.kind === 'unresolvable') {
      expect(result.modelClass).toBe('broken-class');
    }
  });

  it('returns unresolvable when modelClass key maps to a whitespace-only string', () => {
    const result = resolveAgentModel({
      agentSpec: { modelClass: 'broken-class' },
      classMap: { 'broken-class': '   ' },
    });
    expect(result.kind).toBe('unresolvable');
    if (result.kind === 'unresolvable') {
      expect(result.modelClass).toBe('broken-class');
    }
  });

  /* ----------------------- unresolvable: neither set ------------------- */

  it('returns unresolvable when neither model nor modelClass is set (defense-in-depth)', () => {
    // Validator should have caught this at admission, but the resolver
    // must not fabricate a model under any circumstance.
    const result = resolveAgentModel({
      agentSpec: {},
      classMap: map,
    });
    expect(result.kind).toBe('unresolvable');
    if (result.kind === 'unresolvable') {
      expect(result.reason).toMatch(/neither model nor modelClass/i);
      expect(result.modelClass).toBeUndefined();
    }
  });

  it('returns unresolvable when both are empty/whitespace strings', () => {
    const result = resolveAgentModel({
      agentSpec: { model: '', modelClass: '   ' },
      classMap: map,
    });
    expect(result.kind).toBe('unresolvable');
    if (result.kind === 'unresolvable') {
      expect(result.reason).toMatch(/neither model nor modelClass/i);
    }
  });

  /* --------------------------- robustness ------------------------------ */

  it('does not mutate the supplied classMap', () => {
    const localMap: ModelClassMap = { 'tool-caller-default': 'openai/gpt-4o' };
    const snapshot = { ...localMap };
    resolveAgentModel({
      agentSpec: { modelClass: 'tool-caller-default' },
      classMap: localMap,
    });
    expect(localMap).toEqual(snapshot);
  });
});

/* =====================================================================
 * applyResolvedModel — fix v0.1.8-modelclass.1.
 *
 * The pod's `parseEnv` reads `agent.spec.json` from the per-Job
 * ConfigMap and bails when `agentSpec.model` is empty. Phase 2 only
 * populated the resolved model into the `KAGENT_AGENT_MODEL` env, NOT
 * onto `agent.spec.json`. This helper rewrites `spec.model` to the
 * resolved physical model id so the pod sees a fully-resolved spec.
 * `modelClass` stays for traceability.
 * ===================================================================== */

describe('applyResolvedModel', () => {
  it('writes the resolved model id onto spec.model when only modelClass is set', () => {
    const spec = { modelClass: 'tool-caller-default' };
    const result = applyResolvedModel(spec, 'workers-ai/@cf/meta/llama-4-scout-17b-16e-instruct');
    expect(result.model).toBe('workers-ai/@cf/meta/llama-4-scout-17b-16e-instruct');
  });

  it('preserves the modelClass field for traceability/debugging', () => {
    const spec = { modelClass: 'tool-caller-default' };
    const result = applyResolvedModel(spec, 'workers-ai/@cf/meta/llama-4-scout-17b-16e-instruct');
    expect(result.modelClass).toBe('tool-caller-default');
  });

  it('overwrites any prior spec.model with the supplied resolved id', () => {
    // The escape-hatch case (model already set) is the caller's
    // domain — but if a caller passes the override-resolved value
    // back through, the field round-trips identically.
    const spec = { model: 'anthropic/claude-3-7-sonnet-20250219' };
    const result = applyResolvedModel(spec, 'anthropic/claude-3-7-sonnet-20250219');
    expect(result.model).toBe('anthropic/claude-3-7-sonnet-20250219');
  });

  it('does not mutate the supplied spec object (returns a new one)', () => {
    const spec = { modelClass: 'tool-caller-default' };
    const snapshot = { ...spec };
    const result = applyResolvedModel(spec, 'workers-ai/@cf/meta/llama-4-scout-17b-16e-instruct');
    expect(spec).toEqual(snapshot);
    expect(result).not.toBe(spec);
  });

  it('preserves arbitrary unrelated fields on the spec (generic over T)', () => {
    interface Extra {
      readonly model?: string;
      readonly modelClass?: string;
      readonly systemPrompt: string;
      readonly tools: readonly string[];
    }
    const spec: Extra = {
      modelClass: 'tool-caller-default',
      systemPrompt: 'You are an agent.',
      tools: ['fetch_url', 'web_search'],
    };
    const result = applyResolvedModel(spec, 'workers-ai/@cf/meta/llama-4-scout-17b-16e-instruct');
    expect(result.systemPrompt).toBe('You are an agent.');
    expect(result.tools).toEqual(['fetch_url', 'web_search']);
    expect(result.model).toBe('workers-ai/@cf/meta/llama-4-scout-17b-16e-instruct');
    expect(result.modelClass).toBe('tool-caller-default');
  });
});
