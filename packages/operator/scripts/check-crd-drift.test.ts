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
  // Match `export interface Name {` then capture the body up to the matching
  // closing brace at depth zero. A naive `\{([^}]*)\}` stops at the first `}`,
  // which truncates any interface with an inline object type (e.g.
  // `AgentSpec.systemPromptRef?: { readonly name: string }`) — the whole
  // remainder of the interface, and every member after it, would be silently
  // dropped. Walk brace depth from the opening brace instead.
  //
  // Depth is tracked while simultaneously skipping string literals and
  // block comments, because a `/* ... */` (or a `/*` inside one) can embed a
  // stray `{` / `}` — e.g. `terminate-and-restart-{tree,subset}` inside an
  // AgentTaskSpec JSDoc — that would otherwise perturb the brace count and
  // make the walker stop inside or past the interface. A single pass over the
  // whole source is the only way to get strings and comments right, since a
  // string can contain `/*` and a comment can contain `"` / `*/`.
  const startRe = new RegExp(`export interface ${name}\\s*{`);
  const sm = startRe.exec(text);
  if (!sm) throw new Error(`could not find interface ${name} in types.ts`);
  let depth = 0;
  let i = sm.index + sm[0].length;
  const n = text.length;
  let inString: string | null = null;
  let inComment = false;
  for (; i < n; i++) {
    const ch = text[i] ?? '';
    const two = text.slice(i, i + 2);
    if (inComment) {
      if (two === '*/') {
        inComment = false;
        i++;
      }
      continue;
    }
    if (inString) {
      if (ch === '\\') {
        i++;
        continue;
      }
      if (ch === inString) inString = null;
      continue;
    }
    if (two === '/*') {
      inComment = true;
      i++;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      inString = ch;
      continue;
    }
    if (ch === '{') depth++;
    else if (ch === '}') {
      if (depth === 0) return text.slice(sm.index + sm[0].length, i);
      depth--;
    }
  }
  throw new Error(`interface ${name} never closes`);
}

/** Required (non-optional) top-level member names of an interface body. */
function requiredFields(interfaceBody: string): string[] {
  // A required member is `readonly name: <type>;`; an optional one is
  // `readonly name?: <type>;`. The `?` attaches to the member's own name,
  // so we capture it with the property regex and reject only when the
  // captured optional marker is present. Rejecting on `ln.includes('?:')`
  // (the old approach) misclassifies a required member whose *type* happens
  // to contain a nested `?:` — e.g. an object literal with its own optional
  // member, or a `?:` inside an inline comment on the type — by dropping it
  // from the required list. Strip block comments first so a `?:` hiding in
  // a `/* ... */` block can never reach the line.
  //
  // A member line only counts when it sits at the interface's own member
  // indent — not a member of a nested inline/`interface` object type nested
  // inside. We derive that indent from the first matching member line (the
  // TS here indents members at 2 spaces) and read every line whose leading
  // whitespace is exactly that long; anything at a deeper indent is a nested
  // member and is skipped. That is what keeps the equality assertions honest:
  // only real top-level members feed the comparison, so `EventPublishDecl`'s
  // `schema` nested inside `AgentSpec` never leaks into `AgentSpec`'s required
  // set.
  const stripped = interfaceBody.replace(/\/\*[\s\S]*?\*\//g, ' ');
  const lines = stripped.split(/\r?\n/);
  const out: string[] = [];
  let memberIndent: number | null = null;
  for (const ln of lines) {
    const m = ln.match(/^( {2,4})readonly\s+(\w+)(\?)?\s*:\s/);
    if (!m) continue;
    const indent = m[1].length;
    // Lock the interface's member indent to the shallowest member we see.
    // A member inside a nested inline object type sits one level deeper than
    // the interface's own members, so the shallowest indent is the interface
    // member indent (types.ts indents interface members at 2, their nested
    // inline-object members at 4). Anything at a deeper indent is a nested
    // member and is skipped.
    if (memberIndent === null || indent < memberIndent) memberIndent = indent;
    if (indent !== memberIndent) continue;
    if (!m[3]) out.push(m[2]);
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
    // Full equality: adding a required (non-`?`) member to AgentSpec must fail.
    expect(agentSpecRequired).toEqual(exp!.specRequired);
    expect(agentSpecRequired).not.toContain('model');
    expect(agentSpecRequired).not.toContain('modelClass');
  });

  it('agenttask.yaml.specRequired equals ["payload"], the only non-optional scalar', () => {
    const agentTaskRequired = requiredFields(interfaceBody(types, 'AgentTaskSpec'));
    const exp = expectations.find((e) => e.file === 'agenttask.yaml');
    expect(exp, 'agenttask.yaml expectation must exist').toBeDefined();
    // Full equality: adding a required (non-`?`) member to AgentTaskSpec
    // (or removing `payload`) must fail. targetAgent / targetCapability are
    // optional; the "at least one" rule is enforced by a oneOf in the YAML,
    // not by spec.required.
    expect(agentTaskRequired).toEqual(exp!.specRequired);
    expect(agentTaskRequired).toContain('payload');
  });

  it('agentcapability.yaml.specRequired equals ["capability"], the only non-optional scalar', () => {
    const capRequired = requiredFields(interfaceBody(types, 'AgentCapabilitySpec'));
    const exp = expectations.find((e) => e.file === 'agentcapability.yaml');
    expect(exp, 'agentcapability.yaml expectation must exist').toBeDefined();
    // Full equality: agentSelector is optional (`?`), so it must not appear;
    // adding a required member to AgentCapabilitySpec must fail.
    expect(capRequired).toEqual(exp!.specRequired);
    expect(capRequired).toContain('capability');
    expect(capRequired).not.toContain('agentSelector');
  });
});

// ---------------------------------------------------------------------------
// Sanity: the script still expects exactly the CRDs it ships.
// ---------------------------------------------------------------------------

describe('expectation coverage', () => {
  it('the script declares an expectation for each shipped CRD file', () => {
    const files = getExpectations()
      .map((e) => e.file)
      .sort();
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
