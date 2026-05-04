/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

import { describe, expect, it } from 'vitest';

import { API_GROUP_VERSION } from './types.js';
import {
  DEFAULT_WORKSPACE_TTL_MS,
  isWorkspace,
  isWorkspaceFailed,
  isWorkspaceReady,
  parseDuration,
  resolveWorkspaceTtlMs,
} from './workspace.js';
import type { Workspace, WorkspaceSpec } from './workspace.js';

const baseSpec: WorkspaceSpec = {
  pvc: { storage: '5Gi' },
};

const baseWorkspace: Workspace = {
  apiVersion: API_GROUP_VERSION,
  kind: 'Workspace',
  metadata: { name: 'corpus', namespace: 'default' },
  spec: baseSpec,
};

describe('isWorkspace', () => {
  it('accepts a minimal valid Workspace', () => {
    expect(isWorkspace(baseWorkspace)).toBe(true);
  });

  it('rejects null/undefined/non-objects', () => {
    expect(isWorkspace(null)).toBe(false);
    expect(isWorkspace(undefined)).toBe(false);
    expect(isWorkspace('string')).toBe(false);
    expect(isWorkspace(42)).toBe(false);
  });

  it('rejects wrong apiVersion', () => {
    expect(isWorkspace({ ...baseWorkspace, apiVersion: 'kagent.knuteson.io/v2alpha1' })).toBe(
      false,
    );
  });

  it('rejects wrong kind', () => {
    expect(isWorkspace({ ...baseWorkspace, kind: 'Agent' })).toBe(false);
  });

  it('rejects missing spec.pvc.storage', () => {
    expect(
      isWorkspace({
        ...baseWorkspace,
        // intentionally missing storage
        spec: { pvc: {} as unknown },
      }),
    ).toBe(false);
  });

  it('rejects empty-string storage', () => {
    expect(isWorkspace({ ...baseWorkspace, spec: { pvc: { storage: '' } } })).toBe(false);
  });
});

describe('parseDuration', () => {
  it('returns null on undefined / empty', () => {
    expect(parseDuration(undefined)).toBeNull();
    expect(parseDuration('')).toBeNull();
  });

  it('parses simple seconds', () => {
    expect(parseDuration('30s')).toBe(30 * 1000);
  });

  it('parses simple minutes', () => {
    expect(parseDuration('5m')).toBe(5 * 60 * 1000);
  });

  it('parses simple hours', () => {
    expect(parseDuration('24h')).toBe(24 * 60 * 60 * 1000);
  });

  it('parses simple days', () => {
    expect(parseDuration('7d')).toBe(7 * 24 * 60 * 60 * 1000);
  });

  it('parses combined suffixes', () => {
    expect(parseDuration('1h30m')).toBe(90 * 60 * 1000);
    expect(parseDuration('1d6h')).toBe(30 * 60 * 60 * 1000);
  });

  it('treats "0" as zero', () => {
    expect(parseDuration('0')).toBe(0);
  });

  it('returns null on malformed input', () => {
    expect(parseDuration('abc')).toBeNull();
    expect(parseDuration('5x')).toBeNull(); // unknown suffix
    expect(parseDuration('5h trailing')).toBeNull();
    expect(parseDuration('5')).toBeNull(); // no suffix
    expect(parseDuration('-1h')).toBeNull(); // negative regex won't match
  });

  it('returns null on non-contiguous combined input', () => {
    // gap between segments
    expect(parseDuration('1h xx 30m')).toBeNull();
  });
});

describe('resolveWorkspaceTtlMs', () => {
  it('uses default when ttl is unset', () => {
    expect(resolveWorkspaceTtlMs(baseSpec)).toBe(DEFAULT_WORKSPACE_TTL_MS);
  });

  it('uses default when ttl is malformed', () => {
    expect(resolveWorkspaceTtlMs({ ...baseSpec, ttl: 'wonky' })).toBe(DEFAULT_WORKSPACE_TTL_MS);
  });

  it('honors a valid duration', () => {
    expect(resolveWorkspaceTtlMs({ ...baseSpec, ttl: '2h' })).toBe(2 * 60 * 60 * 1000);
  });

  it('honors explicit zero', () => {
    expect(resolveWorkspaceTtlMs({ ...baseSpec, ttl: '0' })).toBe(0);
  });

  it('accepts a Workspace CR (top-level) or a spec directly', () => {
    expect(resolveWorkspaceTtlMs({ ...baseWorkspace, spec: { ...baseSpec, ttl: '12h' } })).toBe(
      12 * 60 * 60 * 1000,
    );
  });
});

describe('isWorkspaceReady', () => {
  it('returns false with no status', () => {
    expect(isWorkspaceReady(baseWorkspace)).toBe(false);
  });

  it('returns false with status.phase != Ready', () => {
    expect(
      isWorkspaceReady({
        ...baseWorkspace,
        status: { phase: 'Pending', ready: false },
      }),
    ).toBe(false);
  });

  it('returns false with phase=Ready but ready=false', () => {
    // Defensive: belt-and-suspenders against partial status patches.
    expect(isWorkspaceReady({ ...baseWorkspace, status: { phase: 'Ready', ready: false } })).toBe(
      false,
    );
  });

  it('returns true when both phase=Ready and ready=true', () => {
    expect(isWorkspaceReady({ ...baseWorkspace, status: { phase: 'Ready', ready: true } })).toBe(
      true,
    );
  });
});

describe('isWorkspaceFailed', () => {
  it('returns true on phase=Failed', () => {
    expect(isWorkspaceFailed({ ...baseWorkspace, status: { phase: 'Failed' } })).toBe(true);
  });

  it('returns false on Pending / Ready / Releasing', () => {
    expect(isWorkspaceFailed(baseWorkspace)).toBe(false);
    expect(isWorkspaceFailed({ ...baseWorkspace, status: { phase: 'Pending' } })).toBe(false);
    expect(isWorkspaceFailed({ ...baseWorkspace, status: { phase: 'Ready' } })).toBe(false);
    expect(isWorkspaceFailed({ ...baseWorkspace, status: { phase: 'Releasing' } })).toBe(false);
  });
});
