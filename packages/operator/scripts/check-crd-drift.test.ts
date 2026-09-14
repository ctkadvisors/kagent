/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// The drift checker (`check-crd-drift.ts`) hard-codes the API group/version
// and, per CRD, the required + spec + status field lists instead of importing
// them from `src/crds/types.ts`. That duplication is the whole point — the
// script is a standalone tsx guard — but a silent divergence between the
// hard-coded copy and the source of truth would go unnoticed unless something
// asserts the two agree.
//
// These tests ARE that assertion. They import the source of truth
// (`API_GROUP` / `API_VERSION` + a regex-parsed list of each CRD's non-optional
// spec fields from `types.ts`) and compare it against the script's exported
// mirrors. Changing `types.ts` breaks the tests immediately; changing the
// script's hard-coded copy also breaks them.

import { API_GROUP, API_VERSION } from '../src/crds/types.js';

import { getAPIConstants, getExpectations } from './check-crd-drift.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const typesPath = resolve(__dirname, '..', 'src', 'crds', 'types.ts');

// ---------------------------------------------------------------------------
// Types.ts — single source of truth for API constants.
// ---------------------------------------------------------------------------

describe('API constants mirror types.ts', () => {
  it('the script hard-codes the API_GROUP exported from types.ts', () => {
    expect(getAPIConstants().API_GROUP).toBe(API_GROUP);
  });

  it('the script hard-codes the API_VERSION exported from types.ts', () => {
    expect(getAPIConstants().API_VERSION).toBe(API_VERSION);
  });
});

// ---------------------------------------------------------------------------
// Types.ts — the non-optional spec fields each CRD expects.
//
// A required field is a property line `readonly name: T;` (optional ones carry
// a `?`). We read the relevant interface body from types.ts directly and
// extract its required members, so the check is independent of the script's
// hand-written list.
// ---------------------------------------------------------------------------

function interfaceBody(text: string, name: string): string {
  // Match `export interface Name { ... }` with the next `}` at any indent.
  const re = new RegExp(`export interface ${name}\\s*\\{([^}]*)\\}`, 's');
  const m = text.match(re);
  if (!m) throw new Error(`could not find interface ${name} in types.ts`);
  return m[1];
}

/** Required (non-optional) top-level member names of an interface body. */
function requiredFields(interfaceBody: string): string[] {
  // Lines of the form `readonly name: <type>;` — required — vs
  // `readonly name?: <type>;` — optional. Strip block comments first.
  const stripped = interfaceBody.replace(/\/\*[\s\S]*?\*\//g, ' ');
  const out: string[] = [];
  for (const ln of stripped.split(/\r?\n/)) {
    const m = ln.trim().match(/^readonly\s+(\w+)\s*:\s/);
    if (m && !ln.includes('?:')) out.push(m[1]);
  }
  return out;
}

describe('specRequired lists mirror types.ts non-optional spec fields', () => {
  const types = readFileSync(typesPath, 'utf8');
  const expectations = [...getExpectations()];

  it('agent.yaml.specRequired is empty because AgentSpec has no required scalars', () => {
    // `model` / `modelClass` are optional + at-least-one, `version` optional —
    // AgentSpec declares nothing required, so the script expects nothing.
    const agentSpecRequired = requiredFields(interfaceBody(types, 'AgentSpec'));
    const exp = expectations.find((e) => e.file === 'agent.yaml');
    expect(exp, 'agent.yaml expectation must exist').toBeDefined();
    expect(exp!.specRequired).toEqual([]);
    expect(agentSpecRequired).not.toContain('model');
    expect(agentSpecRequired).not.toContain('modelClass');
  });

  it('agenttask.yaml.specRequired equals ["payload"], the only non-optional scalar', () => {
    const agentTaskRequired = requiredFields(interfaceBody(types, 'AgentTaskSpec'));
    const exp = expectations.find((e) => e.file === 'agenttask.yaml');
    expect(exp, 'agenttask.yaml expectation must exist').toBeDefined();
    // targetAgent / targetCapability are optional; the "at least one" rule is
    // enforced by a oneOf in the YAML, not by spec.required.
    expect(exp!.specRequired).toEqual(['payload']);
    expect(agentTaskRequired).toContain('payload');
  });

  it('agentcapability.yaml.specRequired equals ["capability"], the only non-optional scalar', () => {
    const capRequired = requiredFields(interfaceBody(types, 'AgentCapabilitySpec'));
    const exp = expectations.find((e) => e.file === 'agentcapability.yaml');
    expect(exp, 'agentcapability.yaml expectation must exist').toBeDefined();
    expect(exp!.specRequired).toEqual(['capability']);
    expect(capRequired).toContain('capability');
    expect(capRequired).not.toContain('agentSelector');
  });
});

// ---------------------------------------------------------------------------
// Sanity: the script still expects exactly the CRDs it ships.
// ---------------------------------------------------------------------------

describe('expectation coverage', () => {
  it('the script declares an expectation for each shipped CRD file', () => {
    const files = getExpectations().map((e) => e.file).sort();
    expect(files).toEqual(
      [
        'agent.yaml',
        'agenttask.yaml',
        'agentcapability.yaml',
        'channels.yaml',
        'channelbindings.yaml',
        'channelsessions.yaml',
        'kagent-schedule.yaml',
        'tenants.yaml',
        'agentworkflows.yaml',
        'workspaces.yaml',
      ].sort(),
    );
  });
});
