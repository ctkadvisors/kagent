/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

import { describe, expect, it } from 'vitest';

import type { VersionedAgent } from './types.js';
import { AgentVersionIndex, compareVersions, resolveAgentVersion } from './version-index.js';

function agent(name: string, version: string, namespace = 'default'): VersionedAgent {
  return {
    metadata: { name, namespace },
    spec: { model: 'test/model', version },
  };
}

describe('compareVersions (lexical)', () => {
  it('returns 0 for identical strings', () => {
    expect(compareVersions('1.0.0', '1.0.0')).toBe(0);
  });

  it('returns < 0 when a sorts before b', () => {
    expect(compareVersions('1.0.0', '1.1.0')).toBeLessThan(0);
    expect(compareVersions('a', 'b')).toBeLessThan(0);
  });

  it('returns > 0 when a sorts after b', () => {
    expect(compareVersions('1.1.0', '1.0.0')).toBeGreaterThan(0);
  });

  it('demonstrates lexical ≠ semver caveat (1.10.0 < 1.2.0 lexically)', () => {
    // Documents the trade-off the substrate makes — Agent authors
    // who need numeric ordering zero-pad. Test pins the behavior.
    expect(compareVersions('1.10.0', '1.2.0')).toBeLessThan(0);
  });
});

describe('resolveAgentVersion', () => {
  it('returns spec.version when set', () => {
    expect(resolveAgentVersion(agent('a', '1.2.3'))).toBe('1.2.3');
  });

  it('returns 0.0.0 when spec.version is empty / absent', () => {
    expect(
      resolveAgentVersion({
        metadata: { name: 'a' },
        spec: { model: 'm' },
      }),
    ).toBe('0.0.0');
    expect(
      resolveAgentVersion({
        metadata: { name: 'a' },
        spec: { model: 'm', version: '' },
      }),
    ).toBe('0.0.0');
  });
});

describe('AgentVersionIndex', () => {
  it('stores per-(name, version) entries', () => {
    const idx = new AgentVersionIndex();
    expect(idx.onAdd(agent('researcher', '1.0.0'))).toBe('inserted');
    expect(idx.onAdd(agent('researcher', '1.1.0'))).toBe('inserted');
    expect(idx.size()).toBe(2);
    expect(idx.versionsOf('default', 'researcher')).toEqual(['1.0.0', '1.1.0']);
  });

  it('upserts an existing (name, version) without growing size', () => {
    const idx = new AgentVersionIndex();
    idx.onAdd(agent('a', '1.0.0'));
    expect(idx.onAdd(agent('a', '1.0.0'))).toBe('updated');
    expect(idx.size()).toBe(1);
  });

  it('lookupExact returns the precise CR; undefined for misses', () => {
    const idx = new AgentVersionIndex();
    const cr = agent('a', '1.0.0');
    idx.onAdd(cr);
    expect(idx.lookupExact('default', 'a', '1.0.0')).toBe(cr);
    expect(idx.lookupExact('default', 'a', '2.0.0')).toBeUndefined();
    expect(idx.lookupExact('other', 'a', '1.0.0')).toBeUndefined();
  });

  it('lookupLatest returns the lexically-greatest version', () => {
    const idx = new AgentVersionIndex();
    idx.onAdd(agent('a', '1.0.0'));
    idx.onAdd(agent('a', '1.2.0'));
    idx.onAdd(agent('a', '1.1.0'));
    const latest = idx.lookupLatest('default', 'a');
    expect((latest?.spec as { version: string }).version).toBe('1.2.0');
  });

  it('lookupLatest tiebreaks on insertion order when versions are equal', () => {
    const idx = new AgentVersionIndex();
    const a = agent('a', '1.0.0');
    const b = agent('a', '1.0.0'); // same version, different insertion
    idx.onAdd(a);
    idx.onAdd(b);
    expect(idx.lookupLatest('default', 'a')).toBe(b);
  });

  it('lookupLatest returns undefined for an unknown name', () => {
    const idx = new AgentVersionIndex();
    expect(idx.lookupLatest('default', 'missing')).toBeUndefined();
  });

  it('isolates by namespace', () => {
    const idx = new AgentVersionIndex();
    idx.onAdd(agent('a', '1.0.0', 'ns1'));
    idx.onAdd(agent('a', '2.0.0', 'ns2'));
    expect((idx.lookupLatest('ns1', 'a')?.spec as { version: string }).version).toBe('1.0.0');
    expect((idx.lookupLatest('ns2', 'a')?.spec as { version: string }).version).toBe('2.0.0');
  });

  it('onDelete removes the entry; bucket drops on last version', () => {
    const idx = new AgentVersionIndex();
    idx.onAdd(agent('a', '1.0.0'));
    idx.onAdd(agent('a', '2.0.0'));
    expect(idx.onDelete(agent('a', '1.0.0'))).toBe('removed');
    expect(idx.size()).toBe(1);
    expect(idx.onDelete(agent('a', '2.0.0'))).toBe('removed');
    expect(idx.size()).toBe(0);
    expect(idx.lookupLatest('default', 'a')).toBeUndefined();
  });

  it('onDelete on missing entry returns not-found', () => {
    const idx = new AgentVersionIndex();
    expect(idx.onDelete(agent('a', '1.0.0'))).toBe('not-found');
    idx.onAdd(agent('a', '1.0.0'));
    expect(idx.onDelete(agent('a', '2.0.0'))).toBe('not-found');
  });

  it('iterates every (namespace, name, version, agent) tuple', () => {
    const idx = new AgentVersionIndex();
    idx.onAdd(agent('a', '1.0.0', 'ns1'));
    idx.onAdd(agent('a', '2.0.0', 'ns1'));
    idx.onAdd(agent('b', '1.0.0', 'ns2'));
    const tuples = [...idx.entries()].map((e) => `${e.namespace}/${e.name}@${e.version}`);
    tuples.sort();
    expect(tuples).toEqual(['ns1/a@1.0.0', 'ns1/a@2.0.0', 'ns2/b@1.0.0']);
  });

  it('reset clears all state', () => {
    const idx = new AgentVersionIndex();
    idx.onAdd(agent('a', '1.0.0'));
    idx.reset();
    expect(idx.size()).toBe(0);
  });

  it('skips Agents without a name', () => {
    const idx = new AgentVersionIndex();
    expect(
      idx.onAdd({
        metadata: {},
        spec: { model: 'm', version: '1.0.0' },
      }),
    ).toBe('updated'); // returns 'updated' (treated as no-op) for nameless
    expect(idx.size()).toBe(0);
  });
});
