/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * Agent-pod-side NATS connect helper for the blackboard tools.
 *
 * Boots a single NATS connection + binds the per-task-tree KV bucket.
 * The `BlackboardClient` returned is consumed by the four built-in
 * blackboard tools (`read_blackboard`, `write_blackboard`,
 * `list_blackboard`, `append_blackboard`) registered in main.ts.
 *
 * The connection lifetime is the pod's; we don't bother closing on
 * task end because the pod itself exits and Node tears the socket
 * down. This mirrors the runtime pattern of NatsDispatcher in the
 * operator — lazy connect, opportunistic cleanup.
 */

import { connect, type NatsConnection } from 'nats';

import { NatsBlackboardClient, type BlackboardClient, type KvLike } from '@kagent/blackboard';

export interface BuildBlackboardClientInput {
  /** Bucket name (operator stamps `KAGENT_BLACKBOARD_BUCKET`). */
  readonly bucket: string;
  /** NATS server URL (operator stamps `KAGENT_NATS_URL`). */
  readonly natsUrl: string;
  /**
   * Optional connection factory override — tests inject a stub. When
   * unset, calls `connect({ servers: natsUrl })` from the `nats`
   * package.
   */
  readonly connectFn?: (url: string) => Promise<NatsConnection>;
}

/**
 * Build a NATS-backed `BlackboardClient` for the configured bucket.
 * Throws when NATS is unreachable OR the bucket is absent — the
 * caller (main.ts) catches and logs a "blackboard tools DISABLED"
 * warning so the agent loop continues without the tools registered.
 *
 * NOTE on bucket existence: `views.kv(name)` is get-or-create on the
 * NATS side; if the operator hasn't yet provisioned the bucket, the
 * agent-pod's first `views.kv` call will materialize one with
 * default opts. This is acceptable for v0.4.1: the operator's
 * BlackboardBucketManager idempotently re-applies the right opts on
 * its next reconcile, and the agent-pod-created bucket carries the
 * same name. Belt-and-suspenders if anything; keeps the agent-pod's
 * boot path from waiting for operator-side admission.
 */
export async function buildBlackboardClientFromEnv(
  input: BuildBlackboardClientInput,
): Promise<BlackboardClient> {
  const connector = input.connectFn ?? defaultConnect;
  const nc = await connector(input.natsUrl);
  const js = nc.jetstream();
  const kv = (await js.views.kv(input.bucket)) as unknown as KvLike;
  return new NatsBlackboardClient({ kv });
}

async function defaultConnect(url: string): Promise<NatsConnection> {
  return await connect({ servers: url });
}
