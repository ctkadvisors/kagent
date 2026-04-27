/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * `@kagent/dto` — pure DTO + read-model helpers.
 *
 * This package is the substrate's READ contract. It maps raw Kubernetes
 * objects (`AgentTask`, `Job`, `Pod`) into UI-friendly summaries that any
 * client — Workbench GUI, CLI, webhook receiver, scheduler — can consume
 * identically without re-deriving the same projection logic.
 *
 * Hard constraints (per Workstream 1 brief, 2026-04-27):
 *
 *   - PURE FUNCTIONS ONLY. No HTTP, no `kc.makeApiClient()`, no `fetch()`,
 *     no file I/O. Callers compose these mappers with whatever transport
 *     they want.
 *   - Depends ONLY on `@kubernetes/client-node` (for type imports) and on
 *     a copy of the operator's CRD type shapes. No workspace dep on
 *     `@kagent/operator` — see `failure.ts` for the dep-direction
 *     rationale.
 *   - The DTO shapes are the public surface; the mapping fns are the
 *     library's value. Adding a field to a DTO is a SemVer-minor; renaming
 *     or removing one is a SemVer-major.
 *
 * Naming convention: `taskSummary(task, opts?) → TaskSummary`. Mappers
 * never throw; they degrade missing inputs to `undefined` fields.
 */

export {} from './crds.js';
