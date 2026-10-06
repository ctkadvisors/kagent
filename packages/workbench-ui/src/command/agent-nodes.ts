/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/** Current map projection; task history remains in the snapshot. */
import type { AgentNode } from './layout.js';
import type { CommandSnapshot } from './state.js';
import { assertCanvasOrphan } from './source-binding.js';

export function currentAgentNodes(
  snapshot: Pick<CommandSnapshot, 'agents' | 'tasks'>,
): readonly AgentNode[] {
  const map = new Map<string, AgentNode>();
  for (const a of snapshot.agents.values()) {
    const key = `${a.namespace}/${a.name}`;
    map.set(key, {
      key,
      namespace: a.namespace,
      name: a.name,
      ...(a.model !== undefined && { model: a.model }),
      ...(a.modelClass !== undefined && { modelClass: a.modelClass }),
      ...(a.tools !== undefined && { tools: a.tools }),
    });
  }
  for (const t of snapshot.tasks.values()) {
    if (t.targetAgent === undefined) continue;
    const key = `${t.namespace}/${t.targetAgent}`;
    // History is retained in snapshot.tasks but cannot resurrect a retired building.
    if (!map.has(key) && (t.phase === 'Completed' || t.phase === 'Failed')) continue;
    // CC-01: dev-only orphan trap. Throws when a task references
    // an agent key not in snapshot.agents. No-op in prod — the
    // nonterminal synthetic AgentNode fallback below continues unchanged so
    // homelab SSE-reconnect windows degrade gracefully.
    assertCanvasOrphan(snapshot, t.namespace, t.name, key);
    if (!map.has(key)) {
      map.set(key, {
        key,
        namespace: t.namespace,
        name: t.targetAgent,
        ...(t.model !== undefined && { model: t.model }),
      });
    }
  }
  return Array.from(map.values());
}
