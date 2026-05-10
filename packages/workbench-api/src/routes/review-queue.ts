/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * GET /api/review-queue — Phase 4 / REV-01 read projection.
 *
 * Stub file for TDD RED phase. Full implementation follows in Task 2.
 *
 * @see REQUIREMENTS.md REV-01, REV-03
 * @see CONTEXT.md D-01-A (classifier steps)
 */

import { Hono } from 'hono';
import type { CustomObjectsApi } from '@kubernetes/client-node';
import type { AuditEvent } from '@kagent/audit-events';
import type { ReviewQueueRow } from '@kagent/dto';
import type { SnapshotCache } from '../cache.js';

export interface ReviewQueueRouteDeps {
  readonly cache: SnapshotCache;
  readonly customApi?: CustomObjectsApi;
  readonly auditPublisher?: { publish(event: AuditEvent): Promise<void> };
  readonly now?: () => Date;
  readonly defaultNamespace?: string;
  readonly langfuseBaseUrl?: string;
  readonly logger?: { warn(message: string): void; error?(message: string): void };
}

/**
 * Stub factory — RED phase placeholder.
 * Full implementation in Task 2 (GREEN phase).
 */
export function reviewQueueRoute(_deps: ReviewQueueRouteDeps): Hono {
  const app = new Hono();
  app.get('/', (c) => {
    const items: ReviewQueueRow[] = [];
    return c.json({ items });
  });
  return app;
}
