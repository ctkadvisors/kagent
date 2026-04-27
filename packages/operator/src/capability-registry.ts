/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * Capability registry — abstracts the lookup that resolves an
 * AgentTask's `targetCapability` to a concrete `agentId`. Backed by
 * a NATS JetStream KV bucket (`agents-live`) per docs/DESIGN-V0.1.md
 * §4.3 in production; pluggable for tests + the StubDispatcher path.
 *
 * The KV bucket maps `agentId → {capabilities[], lastHeartbeatMs}`
 * (heartbeat-expiring). Capability resolution: scan live entries
 * for the first agent whose `capabilities` array contains the tag.
 *
 * Phase 3 C3 wires the interface + stubs; agents start emitting
 * heartbeats once the agent-pod gains its NATS subscriber (Phase 3
 * C4 / C5).
 */

export interface CapabilityRegistry {
  /**
   * Resolve a capability tag to a concrete agent id. Returns null
   * when no live agent satisfies the capability — reconcile maps
   * null → AgentTask.status=Failed with a clear message.
   */
  resolveCapability(capability: string): Promise<string | null>;
}

/**
 * Always returns null. Used by the v0.1 default operator (when run
 * without a NATS URL) and by tests that want to exercise the
 * "capability resolution unavailable" branch.
 */
export class StubCapabilityRegistry implements CapabilityRegistry {
  resolveCapability(_capability: string): Promise<string | null> {
    return Promise.resolve(null);
  }
}

/**
 * In-memory registry — useful for end-to-end tests that pre-seed a
 * capability → agent map without standing up NATS. Production
 * substrate uses NatsCapabilityRegistry.
 */
export class StaticCapabilityRegistry implements CapabilityRegistry {
  private readonly map: Map<string, string>;

  constructor(entries: Readonly<Record<string, string>> = {}) {
    this.map = new Map(Object.entries(entries));
  }

  set(capability: string, agentId: string): void {
    this.map.set(capability, agentId);
  }

  resolveCapability(capability: string): Promise<string | null> {
    return Promise.resolve(this.map.get(capability) ?? null);
  }
}
