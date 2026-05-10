/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * Phase 4 / REV-01 — ReviewQueueRow DTO tests.
 *
 * Validates the shared DTO that workbench-api emits and workbench-ui
 * consumes. The runtime guard `assertIsReviewQueueRow` is a UI-side
 * defense against schema drift — every required field MUST be checked.
 *
 * Mirrors disposition.test.ts's guard test structure.
 */

import { describe, expect, it, expectTypeOf } from 'vitest';

import {
  assertIsReviewQueueRow,
  type ReviewQueueRow,
  type ReviewReason,
  type ArtifactRefSummary,
} from './review-queue.js';

function validRow(overrides: Partial<ReviewQueueRow> = {}): ReviewQueueRow {
  return {
    taskRef: {
      namespace: 'kagent-system',
      name: 'researcher-task-01',
      uid: 'uid-task-01',
    },
    reason: 'verifier-failed',
    reasonDetail: 'verifier returned non-JSON output',
    enqueuedAt: '2026-05-10T10:00:00.000Z',
    stalenessSeconds: 3600,
    phase: 'Failed',
    targetAgent: 'researcher',
    model: 'workers-ai/@cf/meta/llama-4-scout-17b-16e-instruct',
    verifierError: 'verifier_returned_non_json',
    ...overrides,
  };
}

describe('assertIsReviewQueueRow', () => {
  it('passes a valid ReviewQueueRow without throwing', () => {
    expect(() => assertIsReviewQueueRow(validRow())).not.toThrow();
  });

  it('passes a minimal required-only row (no optional fields)', () => {
    const minimal: ReviewQueueRow = {
      taskRef: {
        namespace: 'default',
        name: 'task-min',
        uid: 'uid-min',
      },
      reason: 'suspicious-detector',
      reasonDetail: 'hallucination-pattern, unexpected-tool-use',
      enqueuedAt: '2026-05-10T08:00:00.000Z',
      stalenessSeconds: 7200,
      phase: 'Completed',
    };
    expect(() => assertIsReviewQueueRow(minimal)).not.toThrow();
  });

  it('passes a candidate-template row with candidateTemplate sub-object', () => {
    const row = validRow({
      reason: 'candidate-template',
      reasonDetail: 'template-researcher-v2 (candidate)',
      phase: 'Completed',
      candidateTemplate: {
        artifactRef: {
          uri: 'pvc://kagent-cas/sha256:abc123',
          mediaType: 'application/x-kagent-template-candidate+yaml',
          name: 'researcher-template-v2.yaml',
        },
        proposedTemplateName: 'researcher-v2',
        proposedNamespace: 'kagent-system',
      },
    });
    expect(() => assertIsReviewQueueRow(row)).not.toThrow();
  });

  it('passes a human-review-requested row', () => {
    const row = validRow({
      reason: 'human-review-requested',
      reasonDetail: 'requested by operator@kagent',
      phase: 'Completed',
    });
    expect(() => assertIsReviewQueueRow(row)).not.toThrow();
  });

  it('passes a row with all optional fields populated', () => {
    const row = validRow({
      reason: 'suspicious-detector',
      reasonDetail: 'hallucination-pattern',
      suspicious: ['hallucination-pattern'],
      traceLink: 'https://langfuse.local/trace/abc123',
      artifactCount: 2,
      model: 'workers-ai/@cf/meta/llama-4-scout-17b-16e-instruct',
    });
    expect(() => assertIsReviewQueueRow(row)).not.toThrow();
  });

  it('throws when value is not an object', () => {
    expect(() => assertIsReviewQueueRow(null)).toThrow(/not an object/);
    expect(() => assertIsReviewQueueRow('hello')).toThrow(/not an object/);
    expect(() => assertIsReviewQueueRow(42)).toThrow(/not an object/);
    expect(() => assertIsReviewQueueRow(undefined)).toThrow(/not an object/);
  });

  it('throws when taskRef is missing', () => {
    const bad = { ...validRow() } as Record<string, unknown>;
    delete bad['taskRef'];
    expect(() => assertIsReviewQueueRow(bad)).toThrow(/taskRef missing/);
  });

  it('throws when taskRef.namespace is missing', () => {
    const bad: Record<string, unknown> = {
      ...validRow(),
      taskRef: { name: 'test', uid: 'uid' },
    };
    expect(() => assertIsReviewQueueRow(bad)).toThrow(/taskRef.namespace missing/);
  });

  it('throws when taskRef.name is missing', () => {
    const bad: Record<string, unknown> = {
      ...validRow(),
      taskRef: { namespace: 'default', uid: 'uid' },
    };
    expect(() => assertIsReviewQueueRow(bad)).toThrow(/taskRef.name missing/);
  });

  it('throws when taskRef.uid is missing', () => {
    const bad: Record<string, unknown> = {
      ...validRow(),
      taskRef: { namespace: 'default', name: 'test' },
    };
    expect(() => assertIsReviewQueueRow(bad)).toThrow(/taskRef.uid missing/);
  });

  it('throws when reason is missing', () => {
    const bad = { ...validRow() } as Record<string, unknown>;
    delete bad['reason'];
    expect(() => assertIsReviewQueueRow(bad)).toThrow(/reason missing/);
  });

  it('throws when reason is an unknown value', () => {
    const bad = { ...validRow(), reason: 'not-a-real-reason' };
    expect(() => assertIsReviewQueueRow(bad)).toThrow(
      /reason 'not-a-real-reason' is not a known ReviewReason/,
    );
  });

  it('throws when reasonDetail is missing', () => {
    const bad = { ...validRow() } as Record<string, unknown>;
    delete bad['reasonDetail'];
    expect(() => assertIsReviewQueueRow(bad)).toThrow(/reasonDetail missing/);
  });

  it('throws when enqueuedAt is missing', () => {
    const bad = { ...validRow() } as Record<string, unknown>;
    delete bad['enqueuedAt'];
    expect(() => assertIsReviewQueueRow(bad)).toThrow(/enqueuedAt missing/);
  });

  it('throws when stalenessSeconds is missing', () => {
    const bad = { ...validRow() } as Record<string, unknown>;
    delete bad['stalenessSeconds'];
    expect(() => assertIsReviewQueueRow(bad)).toThrow(/stalenessSeconds missing/);
  });

  it('throws when phase is missing', () => {
    const bad = { ...validRow() } as Record<string, unknown>;
    delete bad['phase'];
    expect(() => assertIsReviewQueueRow(bad)).toThrow(/phase missing/);
  });

  it('throws when optional targetAgent is not a string', () => {
    const bad = { ...validRow(), targetAgent: 42 };
    expect(() => assertIsReviewQueueRow(bad)).toThrow(/targetAgent must be a string/);
  });

  it('throws when optional model is not a string', () => {
    const bad = { ...validRow(), model: true };
    expect(() => assertIsReviewQueueRow(bad)).toThrow(/model must be a string/);
  });

  it('throws when optional verifierError is not a string', () => {
    const bad = { ...validRow(), verifierError: {} };
    expect(() => assertIsReviewQueueRow(bad)).toThrow(/verifierError must be a string/);
  });

  it('throws when optional traceLink is not a string', () => {
    const bad = { ...validRow(), traceLink: 123 };
    expect(() => assertIsReviewQueueRow(bad)).toThrow(/traceLink must be a string/);
  });

  it('throws when optional artifactCount is not a number', () => {
    const bad = { ...validRow(), artifactCount: 'three' };
    expect(() => assertIsReviewQueueRow(bad)).toThrow(/artifactCount must be a number/);
  });

  it('throws when optional suspicious is not an array', () => {
    const bad = { ...validRow(), suspicious: 'not-an-array' };
    expect(() => assertIsReviewQueueRow(bad)).toThrow(/suspicious must be an array/);
  });

  it('throws when candidateTemplate is present but not an object', () => {
    const bad = { ...validRow(), candidateTemplate: 'string-value' };
    expect(() => assertIsReviewQueueRow(bad)).toThrow(/candidateTemplate must be an object/);
  });

  it('throws when candidateTemplate.artifactRef.uri is missing', () => {
    const bad = {
      ...validRow(),
      candidateTemplate: {
        artifactRef: { mediaType: 'application/x-kagent-template-candidate+yaml' },
        proposedTemplateName: 'researcher-v2',
        proposedNamespace: 'kagent-system',
      },
    };
    expect(() => assertIsReviewQueueRow(bad)).toThrow(/artifactRef.uri missing/);
  });

  it('throws when candidateTemplate.proposedTemplateName is missing', () => {
    const bad = {
      ...validRow(),
      candidateTemplate: {
        artifactRef: { uri: 'pvc://kagent-cas/sha256:abc' },
        proposedNamespace: 'kagent-system',
      },
    };
    expect(() => assertIsReviewQueueRow(bad)).toThrow(/proposedTemplateName missing/);
  });

  it('throws when candidateTemplate.proposedNamespace is missing', () => {
    const bad = {
      ...validRow(),
      candidateTemplate: {
        artifactRef: { uri: 'pvc://kagent-cas/sha256:abc' },
        proposedTemplateName: 'researcher-v2',
      },
    };
    expect(() => assertIsReviewQueueRow(bad)).toThrow(/proposedNamespace missing/);
  });

  it('accepts all 6 known ReviewReason values', () => {
    const reasons: ReviewReason[] = [
      'verifier-failed',
      'suspicious-detector',
      'human-review-requested',
      'candidate-template',
      'replay-divergence',
      'eval-failed',
    ];
    for (const reason of reasons) {
      expect(() => assertIsReviewQueueRow(validRow({ reason }))).not.toThrow();
    }
  });
});

describe('ReviewQueueRow type-level invariants', () => {
  it('ReviewReason union has exactly 6 members', () => {
    // Exhaustive check — adding a member to ReviewReason without updating
    // this list is caught by the TypeScript exhaustive assignment below.
    const reasons: ReviewReason[] = [
      'verifier-failed',
      'suspicious-detector',
      'human-review-requested',
      'candidate-template',
      'replay-divergence',
      'eval-failed',
    ];
    expect(reasons).toHaveLength(6);
  });

  it('ArtifactRefSummary.uri is a required string', () => {
    expectTypeOf<ArtifactRefSummary['uri']>().toEqualTypeOf<string>();
  });

  it('ReviewQueueRow.reason is typed as ReviewReason', () => {
    expectTypeOf<ReviewQueueRow['reason']>().toEqualTypeOf<ReviewReason>();
  });

  it('ReviewQueueRow.taskRef fields are all required strings', () => {
    expectTypeOf<ReviewQueueRow['taskRef']['namespace']>().toEqualTypeOf<string>();
    expectTypeOf<ReviewQueueRow['taskRef']['name']>().toEqualTypeOf<string>();
    expectTypeOf<ReviewQueueRow['taskRef']['uid']>().toEqualTypeOf<string>();
  });

  it('ReviewQueueRow.stalenessSeconds is a required number', () => {
    expectTypeOf<ReviewQueueRow['stalenessSeconds']>().toEqualTypeOf<number>();
  });

  it('ReviewQueueRow optional fields are properly typed as union with undefined', () => {
    expectTypeOf<ReviewQueueRow['targetAgent']>().toEqualTypeOf<string | undefined>();
    expectTypeOf<ReviewQueueRow['model']>().toEqualTypeOf<string | undefined>();
    expectTypeOf<ReviewQueueRow['verifierError']>().toEqualTypeOf<string | undefined>();
    expectTypeOf<ReviewQueueRow['traceLink']>().toEqualTypeOf<string | undefined>();
    expectTypeOf<ReviewQueueRow['artifactCount']>().toEqualTypeOf<number | undefined>();
  });
});
