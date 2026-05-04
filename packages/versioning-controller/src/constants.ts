/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * Annotation keys + version baseline. Mirrors the operator's
 * `crds/types.ts` so this package can stay decoupled from the
 * operator's CRD bundle (operator depends on us, not the reverse).
 */

export const PUBLISHED_ANNOTATION = 'kagent.knuteson.io/published' as const;
export const DEPRECATED_ANNOTATION = 'kagent.knuteson.io/deprecated' as const;
export const REMOVED_AT_ANNOTATION = 'kagent.knuteson.io/removed-at' as const;
export const DEFAULT_AGENT_VERSION = '0.0.0' as const;
