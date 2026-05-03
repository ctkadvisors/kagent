/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * In-memory cache of `ModelEndpoint` CRs keyed by `spec.model`. The
 * router consults this on every /v1/chat/completions to find which
 * backend to dispatch to without round-tripping the K8s API.
 *
 * The actual K8s informer (watch loop) lives in `model-watch.ts`;
 * this module is the pure data structure so router tests can drive
 * it directly without booting an informer.
 */

import type { ModelEndpoint } from './types.js';

export interface ModelLookup {
  readonly endpoint: ModelEndpoint;
  /** Resolved bounds — falls back to spec defaults when omitted. */
  readonly seed: number;
  readonly max: number;
  readonly minSafe: number;
}

export class ModelIndex {
  private readonly map = new Map<string, ModelEndpoint>();

  /** Replace the entire index — used on initial K8s list. */
  replaceAll(endpoints: readonly ModelEndpoint[]): void {
    this.map.clear();
    for (const ep of endpoints) this.upsert(ep);
  }

  /** Insert or update a single ModelEndpoint by `spec.model`. */
  upsert(endpoint: ModelEndpoint): void {
    this.map.set(endpoint.spec.model, endpoint);
  }

  /** Remove from the index by `spec.model` (the deleted CR's model name). */
  delete(modelName: string): void {
    this.map.delete(modelName);
  }

  /** All currently-tracked endpoint specs (read-only snapshot). */
  list(): readonly ModelEndpoint[] {
    return [...this.map.values()];
  }

  /** Lookup by the OpenAI request's `model` field. */
  lookup(model: string): ModelLookup | null {
    const ep = this.map.get(model);
    if (ep === undefined) return null;
    return {
      endpoint: ep,
      seed: ep.spec.inFlight.seed,
      max: ep.spec.inFlight.max,
      minSafe: ep.spec.minSafe ?? 1,
    };
  }
}
