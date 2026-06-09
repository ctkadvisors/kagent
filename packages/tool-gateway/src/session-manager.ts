/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

import {
  buildToolSessionKey,
  type ToolKind,
  type ToolSessionIdentity,
  type ToolSessionRecord,
} from '@kagent/dto';

export interface StartToolSessionInput {
  readonly tenant: string;
  readonly namespace: string;
  readonly agentTaskUid: string;
  readonly agentName: string;
  readonly toolKind: ToolKind;
  readonly ttlSeconds: number;
}

export type ToolSessionLookup = ToolSessionIdentity;

export interface InMemoryToolSessionManagerOptions {
  readonly now?: () => Date;
}

export class InMemoryToolSessionManager {
  private readonly sessions = new Map<string, ToolSessionRecord>();
  private readonly now: () => Date;
  private counter = 0;
  private paused = false;

  constructor(options: InMemoryToolSessionManagerOptions = {}) {
    this.now = options.now ?? (() => new Date());
  }

  setPaused(paused: boolean): void {
    this.paused = paused;
  }

  start(input: StartToolSessionInput): ToolSessionIdentity {
    if (this.paused) {
      throw new Error('tool_runtime_paused');
    }

    this.counter += 1;
    const sessionId = `${input.toolKind}-${String(this.counter)}`;
    const created = this.now();
    const expires = new Date(created.getTime() + input.ttlSeconds * 1000);
    const identity: ToolSessionIdentity = {
      tenant: input.tenant,
      namespace: input.namespace,
      agentTaskUid: input.agentTaskUid,
      toolKind: input.toolKind,
      sessionId,
    };

    this.sessions.set(buildToolSessionKey(identity), {
      ...identity,
      agentName: input.agentName,
      createdAt: created.toISOString(),
      expiresAt: expires.toISOString(),
      status: 'ready',
    });

    return identity;
  }

  get(lookup: ToolSessionLookup): ToolSessionRecord | null {
    return this.sessions.get(buildToolSessionKey(lookup)) ?? null;
  }

  requireReady(lookup: ToolSessionLookup): ToolSessionRecord | null {
    const record = this.get(lookup);
    return record?.status === 'ready' ? record : null;
  }

  terminate(lookup: ToolSessionLookup): ToolSessionRecord | null {
    const record = this.get(lookup);
    if (record === null) return null;

    const next: ToolSessionRecord = {
      ...record,
      status: 'terminated',
    };
    this.sessions.set(buildToolSessionKey(lookup), next);
    return next;
  }
}
