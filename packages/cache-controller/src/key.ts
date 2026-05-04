/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * Cache-key derivation — Wave 3 / Cache sub-team (v0.4.2-cache).
 *
 * `deriveCacheKey` is the SOLE substrate-blessed way to turn an
 * `Agent.spec.caches[].key` template + a (Agent, AgentTask) pair into
 * the sha256 hex string that becomes the second segment of a
 * `cache://sha256:<hex>/<name>` URI. Pure function: same inputs always
 * produce the same output; no I/O; no clock; no random.
 *
 * Recipe (per docs/WAVES.md §5.3 deliverable 2):
 *   sha256( resolved-template-string )
 *
 * where the template-string is the user's `key` field with the
 * recognized tokens replaced verbatim:
 *
 *   {input_artifact_hashes}  → joined sorted hashes, '+'-delimited
 *   {image_digest}           → ctx.imageDigest verbatim
 *   {model_name}             → agent.spec.model verbatim
 *
 * The literal `key: "default"` is sugar for the canonical recipe
 * `"{input_artifact_hashes}+{image_digest}+{model_name}"` so most
 * Agents never have to write the template themselves.
 *
 * Why hash the rendered string (vs hash the components individually
 * and concatenate)? — gives the user freedom to bake non-token
 * substrings into the key (e.g. `npm-{image_digest}-v2`) so
 * cache-key invalidation can be controlled by template authors at
 * authoring time without a CRD change. The substrate just renders +
 * hashes, never inspects.
 *
 * Stability properties:
 *   1. Order of `inputArtifactHashes` doesn't matter (we sort).
 *   2. Whitespace + casing in `key` matters (it's a literal template).
 *   3. Empty `inputArtifactHashes` is valid; `{input_artifact_hashes}`
 *      renders to the empty string.
 *   4. Unrecognized `{token}` substrings pass through verbatim — the
 *      substrate does NOT throw on them so future tokens (e.g.
 *      `{tenant}` for v0.5 Tenancy) can be added additively without
 *      breaking pre-aware Agents.
 */

import { createHash } from 'node:crypto';

import type { AgentLike, AgentTaskLike, KeyDerivationContext } from './types.js';

/**
 * Sugar for the canonical recipe — `key: "default"` on `Agent.spec.caches[]`
 * resolves to this template before substitution + hashing.
 */
export const DEFAULT_KEY_TEMPLATE = '{input_artifact_hashes}+{image_digest}+{model_name}';

/** The `key` value Agent authors write to opt into the canonical recipe. */
export const DEFAULT_KEY_SUGAR = 'default';

/**
 * Render a key template (substitute the three recognized tokens), then
 * sha256-hex it. Pure function: same inputs always yield the same hex
 * string. Throws only on programmer error — never on user-controlled
 * input — to keep call sites unconditional.
 *
 * @param template     — `Agent.spec.caches[].key`; `'default'` sugars
 *                       to {@link DEFAULT_KEY_TEMPLATE}.
 * @param agent        — structural Agent (`spec.model`).
 * @param task         — structural AgentTask (unused today; threaded for
 *                       forward-compat with v0.5 tokens like `{tenant}`).
 * @param ctx          — caller-resolved side info: image digest +
 *                       sorted-or-unsorted artifact hashes.
 * @returns 64-char lowercase hex sha256 of the rendered template.
 */
export function deriveCacheKey(
  template: string,
  agent: AgentLike,
  task: AgentTaskLike,
  ctx: KeyDerivationContext,
): string {
  if (typeof template !== 'string' || template.length === 0) {
    throw new Error('deriveCacheKey: template must be a non-empty string');
  }
  if (typeof agent.spec.model !== 'string') {
    throw new Error('deriveCacheKey: agent.spec.model must be a string');
  }

  const resolved = renderKeyTemplate(template, agent, task, ctx);
  return createHash('sha256').update(resolved, 'utf8').digest('hex');
}

/**
 * Substitute the three recognized tokens in `template`. Exposed for
 * the unit tests + the operator's debug logging path (so a misbehaving
 * Agent's effective key string is observable without re-running the
 * sha256). Sugar (`template === 'default'`) is expanded BEFORE
 * substitution.
 *
 * `_task` is reserved for future tokens; the parameter is named with a
 * leading underscore so eslint doesn't complain about an unused arg.
 */
export function renderKeyTemplate(
  template: string,
  agent: AgentLike,
  _task: AgentTaskLike,
  ctx: KeyDerivationContext,
): string {
  const expanded = template === DEFAULT_KEY_SUGAR ? DEFAULT_KEY_TEMPLATE : template;

  // Sort + join the artifact hashes so ordering of the AgentTask's
  // inputs[] never affects the key. `'+'` is the v0.4.2 separator —
  // intentionally NOT a hash-character so a stray hash collision in
  // the joined string (vanishingly improbable) is not splittable into
  // valid sub-hashes by a downstream consumer.
  const sortedHashes = [...ctx.inputArtifactHashes].sort();
  const inputHashesRendered = sortedHashes.join('+');

  // Use replace-with-callback so a single pass handles all three
  // tokens deterministically. Unrecognized `{xxx}` substrings pass
  // through unchanged (this is a feature — see file-level docstring).
  return expanded.replace(/\{(input_artifact_hashes|image_digest|model_name)\}/g, (_match, tok) => {
    switch (tok) {
      case 'input_artifact_hashes':
        return inputHashesRendered;
      case 'image_digest':
        return ctx.imageDigest;
      case 'model_name':
        return agent.spec.model;
      default:
        // Should be unreachable given the regex; defensive default.
        /* istanbul ignore next */
        return _match;
    }
  });
}

/**
 * Compute the relative on-disk path for a cache entry under the cache
 * PVC mount. Mirrors the CAS layout exactly:
 *   `<mount>/cache/sha256/<first-2-hex>/<remaining-62-hex>/<name>`
 *
 * Same Git-loose-objects sharding pattern as
 * `packages/agent-pod/src/cas-backend.ts`. Sharing the layout means
 * the same disk-walk + dedup tooling works for both `cas://` and
 * `cache://` URIs (Helm's `cache.pvcName` may equal `cas.pvcName`).
 *
 * Returned path is relative — caller prepends the mount root.
 */
export function cacheStorageRelPath(key: string, name: string): string {
  if (typeof key !== 'string' || !/^[0-9a-f]{64}$/.test(key)) {
    throw new Error(`cacheStorageRelPath: key must be a 64-char lowercase sha256 hex (got ${key})`);
  }
  if (typeof name !== 'string' || name.length === 0) {
    throw new Error('cacheStorageRelPath: name required');
  }
  if (name.startsWith('/')) {
    throw new Error('cacheStorageRelPath: name must not begin with "/"');
  }
  if (name.split('/').includes('..')) {
    throw new Error('cacheStorageRelPath: name must not contain ".." segment');
  }
  const shard = key.slice(0, 2);
  const rest = key.slice(2);
  return `cache/sha256/${shard}/${rest}/${name}`;
}

/**
 * Build the canonical `cache://sha256:<key>/<name>` URI. Mirrors
 * `casUri()` from `packages/operator/src/crds/artifact-ref.ts` so the
 * two scheme families have identical shape; the only distinction is
 * the scheme prefix and the disk root (`cas/sha256/...` vs.
 * `cache/sha256/...`).
 */
export function cacheUri(key: string, name: string): string {
  if (typeof key !== 'string' || !/^[0-9a-f]{64}$/.test(key)) {
    throw new Error(`cacheUri: key must be a 64-char lowercase sha256 hex (got ${key})`);
  }
  if (typeof name !== 'string' || name.length === 0) {
    throw new Error('cacheUri: name required');
  }
  if (name.startsWith('/')) {
    throw new Error('cacheUri: name must not begin with "/"');
  }
  if (name.split('/').includes('..')) {
    throw new Error('cacheUri: name must not contain ".." segment');
  }
  return `cache://sha256:${key}/${name}`;
}
