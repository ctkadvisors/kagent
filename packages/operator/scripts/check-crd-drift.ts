#!/usr/bin/env tsx
/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * CRD-drift checker.
 *
 * Asserts that the YAML CRD manifests under `packages/operator/manifests/
 * crds/` haven't drifted from the operator's TypeScript surface in
 * `packages/operator/src/crds/types.ts`. This is intentionally a
 * pragmatic, hand-coded set of checks rather than a full bidirectional
 * generator — see `CRD-DRIFT-NOTES.md` (sibling) for the gap list.
 *
 * What it checks today:
 *   1. Each CRD YAML's `spec.group` matches `API_GROUP` from types.ts.
 *   2. Each CRD YAML's `spec.versions[].name` matches `API_VERSION`.
 *   3. Each CRD YAML's `metadata.name` follows `<plural>.<group>`.
 *   4. The YAML schema declares the required *spec* properties the
 *      operator's TS types treat as non-optional. Right now:
 *        - Agent.spec.model           (required)
 *        - AgentTask.spec.payload     (required)
 *        - AgentCapability.spec.capability (required)
 *   5. Status fields the operator actively reads/writes are present in
 *      the YAML schema for the AgentTask CRD:
 *        - phase, podName, completedAt, error
 *        - structuralVerdict, artifacts (additive but operator-aware)
 *        - children, aggregatePhase, successCount, failureCount,
 *          inFlightCount (task-graph projection)
 *
 * Exit non-zero if any check fails. Designed to run in CI as a separate
 * step after typecheck — the cheapest way to catch "we added a field
 * to types.ts and forgot to update the YAML" or vice-versa, while we
 * defer a real generator.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Hard-coded constants mirroring `src/crds/types.ts`. Duplicated rather
// than imported because the checker runs as a top-level tsx script and
// we don't want it to drag the operator's transitive deps just to
// resolve TS module imports. If these constants change in types.ts,
// this script will fail and force an explicit update here too — that's
// the point.
const API_GROUP = 'kagent.knuteson.io';
const API_VERSION = 'v1alpha1';

const __dirname = dirname(fileURLToPath(import.meta.url));
const operatorRoot = resolve(__dirname, '..');
const crdsDir = join(operatorRoot, 'manifests', 'crds');

interface SimpleCRD {
  readonly metadataName: string;
  readonly group: string;
  readonly versionNames: readonly string[];
  readonly plural: string;
  readonly kind: string;
  readonly specRequired: readonly string[];
  readonly specProperties: readonly string[];
  readonly statusProperties: readonly string[];
}

/**
 * Microscopic YAML reader — extracts only the fields we care about.
 * We do NOT use `js-yaml` because the operator's deps don't depend on
 * one yet and pulling in a dep just for CI is overkill. The CRD files
 * are hand-authored and follow a stable shape; line-based extraction
 * is sufficient. If schema complexity grows, swap to `yaml` package.
 */
function parseCRD(text: string): SimpleCRD {
  const lines = text.split(/\r?\n/);

  const get = (key: string, indent = 0): string | undefined => {
    const re = new RegExp(`^ {${indent}}${key}:\\s*(.*)$`);
    for (const ln of lines) {
      const m = ln.match(re);
      if (m && m[1] !== undefined) return m[1].trim();
    }
    return undefined;
  };

  const metadataName = get('name', 2) ?? '';
  const group = get('group', 2) ?? '';
  const plural = get('plural', 4) ?? '';
  const kind = get('kind', 4) ?? '';

  // Versions: pick names under `versions:` block.
  const versionNames: string[] = [];
  let inVersions = false;
  for (const ln of lines) {
    if (/^ {2}versions:\s*$/.test(ln)) {
      inVersions = true;
      continue;
    }
    if (inVersions) {
      const m = ln.match(/^ {4}- name:\s+(\S+)/);
      if (m && m[1]) versionNames.push(m[1]);
      // Bail when we hit a sibling block of versions: (top of next CRD,
      // or the additionalPrinterColumns / preserved-spec block at depth
      // <=2). This text is one CRD per file, so this rarely triggers.
      if (/^ {0,2}\S/.test(ln) && !/^ {2}versions:/.test(ln) && versionNames.length > 0) break;
    }
  }

  // spec block — required + properties, status properties.
  const specRequired = extractRequiredList(text, 'spec');
  const specProperties = extractPropertyKeys(text, 'spec');
  const statusProperties = extractPropertyKeys(text, 'status');

  return {
    metadataName,
    group,
    versionNames,
    plural,
    kind,
    specRequired,
    specProperties,
    statusProperties,
  };
}

/**
 * Pull the property keys directly under `<schemaSection>.properties`.
 * The CRD YAML nests the section like:
 *   schema:
 *     openAPIV3Schema:
 *       properties:
 *         spec:
 *           properties:
 *             foo: ...
 *             bar: ...
 * We grep for the inner key `<schemaSection>:` followed by the next
 * `properties:` block at deeper indent and read keys until the indent
 * unwinds.
 */
function extractPropertyKeys(text: string, schemaSection: string): string[] {
  const lines = text.split(/\r?\n/);
  const out: string[] = [];
  let i = 0;
  // Find `<section>:` at indent 12 (under properties: at 10, under
  // openAPIV3Schema: at 8). The CRDs in this repo all use that shape.
  const sectionRe = new RegExp(`^ {12}${schemaSection}:\\s*$`);
  while (i < lines.length) {
    const ln = lines[i];
    if (ln && sectionRe.test(ln)) {
      // Walk forward to the inner `properties:` line at indent 14.
      let j = i + 1;
      while (j < lines.length) {
        const inner = lines[j];
        if (inner && /^ {14}properties:\s*$/.test(inner)) {
          // Read keys at indent 16 until indent unwinds below 16.
          let k = j + 1;
          while (k < lines.length) {
            const kln = lines[k];
            if (!kln) {
              k++;
              continue;
            }
            const m = kln.match(/^ {16}(\w+):/);
            if (m && m[1]) {
              out.push(m[1]);
              k++;
              continue;
            }
            // Indent unwound (less than 14 spaces of content) → done.
            const indent = kln.match(/^( *)\S/);
            if (indent !== null && (indent[1] ?? '').length <= 12) break;
            k++;
          }
          break;
        }
        // Bail if we leave the section block.
        const indent = inner ? inner.match(/^( *)\S/) : null;
        if (indent !== null && (indent[1] ?? '').length <= 12) break;
        j++;
      }
      break;
    }
    i++;
  }
  return out;
}

/** Pull the `required:` list directly under `<schemaSection>:`. */
function extractRequiredList(text: string, schemaSection: string): string[] {
  const lines = text.split(/\r?\n/);
  const sectionRe = new RegExp(`^ {12}${schemaSection}:\\s*$`);
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (!sectionRe.test(lines[i] ?? '')) continue;
    // Walk forward to a `required:` at indent 14.
    for (let j = i + 1; j < lines.length; j++) {
      const ln = lines[j] ?? '';
      if (/^ {14}required:\s*$/.test(ln)) {
        let k = j + 1;
        while (k < lines.length) {
          const kln = lines[k] ?? '';
          const m = kln.match(/^ {16}- (\w+)\s*$/);
          if (m && m[1]) {
            out.push(m[1]);
            k++;
            continue;
          }
          const indent = kln.match(/^( *)\S/);
          if (indent !== null && (indent[1] ?? '').length <= 14) break;
          k++;
        }
        return out;
      }
      const indent = ln.match(/^( *)\S/);
      if (indent !== null && (indent[1] ?? '').length <= 12) break;
    }
  }
  return out;
}

/** Expectations the TS types impose on each CRD. */
interface CRDExpectation {
  readonly file: string;
  readonly kind: string;
  readonly plural: string;
  readonly specRequired: readonly string[];
  readonly specProperties: readonly string[];
  readonly statusProperties?: readonly string[];
}

const expectations: readonly CRDExpectation[] = [
  {
    file: 'agent.yaml',
    kind: 'Agent',
    plural: 'agents',
    specRequired: ['model'],
    specProperties: [
      'model',
      'systemPrompt',
      'tools',
      'capabilities',
      'sandboxProfile',
      // v0.2.0-typed-io — Wave 1 / I/O sub-team.
      'inputs',
      'outputs',
      'workspaceClaims',
      // v0.4.2-cache — Wave 3 / Cache sub-team.
      'caches',
      // v0.3.1-supervision — Wave 2 / Supervision sub-team.
      'supervisionStrategy',
      'maxRestarts',
    ],
  },
  {
    file: 'agenttask.yaml',
    kind: 'AgentTask',
    plural: 'agenttasks',
    specRequired: ['payload'],
    // From AgentTaskSpec in types.ts. `targetAgent`/`targetCapability`
    // are mutually exclusive but the YAML enforces "at least one" via
    // a oneOf at the spec level — both keys must still be declared in
    // properties.
    specProperties: [
      'targetAgent',
      'targetCapability',
      'payload',
      'timeoutSeconds',
      'parentTask',
      'originalUserMessage',
      'parentDistillation',
      'expectedTools',
      // v0.2.0-typed-io — Wave 1 / I/O sub-team.
      'inputs',
      'idempotencyKey',
    ],
    statusProperties: [
      'phase',
      'result',
      'error',
      'startedAt',
      'completedAt',
      'podName',
      'structuralVerdict',
      'artifacts',
      // v0.2.0-typed-io — typed output refs.
      'outputs',
      'children',
      'aggregatePhase',
      'successCount',
      'failureCount',
      'inFlightCount',
      // v0.3.1-supervision — Wave 2 / Supervision sub-team.
      'restartCount',
    ],
  },
  {
    file: 'agentcapability.yaml',
    kind: 'AgentCapability',
    plural: 'agentcapabilities',
    specRequired: ['capability'],
    specProperties: ['capability', 'agentSelector'],
  },
  {
    file: 'kagent-schedule.yaml',
    kind: 'KagentSchedule',
    plural: 'kagentschedules',
    specRequired: ['schedule', 'taskTemplate'],
    specProperties: ['schedule', 'suspend', 'taskTemplate'],
    statusProperties: ['lastTickAt', 'nextTickAt', 'conditions'],
  },
  // v0.2.1-workspaces — Wave 1 / Workspace sub-team. See
  // docs/SUBSTRATE-V1.md §3.4 + docs/WAVES.md §3.2.
  {
    file: 'workspaces.yaml',
    kind: 'Workspace',
    plural: 'workspaces',
    specRequired: ['pvc'],
    specProperties: ['source', 'pvc', 'ttl', 'quota'],
    statusProperties: [
      'ready',
      'phase',
      'bytesUsed',
      'lastReferencedAt',
      'observedGeneration',
      'conditions',
      'populationJobName',
      'pvcName',
    ],
  },
  // v0.3.2-workflows — Wave 2 / Workflows sub-team. See
  // docs/SUBSTRATE-V1.md §3.3 + docs/WAVES.md §4.3.
  {
    file: 'agentworkflows.yaml',
    kind: 'AgentWorkflow',
    plural: 'agentworkflows',
    specRequired: ['image', 'handler'],
    specProperties: [
      'image',
      'handler',
      'triggers',
      'capabilityRef',
      'capabilityClaims',
      'replicas',
      'restateAddress',
    ],
    statusProperties: [
      'phase',
      'observedGeneration',
      'lastTickAt',
      'activeRunCount',
      'conditions',
      'capabilityRef',
      'eventSubscriptions',
    ],
  },
  // v0.5.0-tenancy — Wave 4 / Tenancy sub-team. See
  // docs/SUBSTRATE-V1.md §3.6 + docs/WAVES.md §6.1.
  {
    file: 'tenants.yaml',
    kind: 'Tenant',
    plural: 'tenants',
    specRequired: ['name', 'namespaceAllowlist'],
    specProperties: [
      'name',
      'namespaceAllowlist',
      'capabilityRoot',
      'auditSubject',
      'defaultQuota',
      'defaultEgress',
    ],
    statusProperties: [
      'phase',
      'observedGeneration',
      'conditions',
      'namespaceCount',
      'agentCount',
      'activeTaskCount',
    ],
  },
];

const errors: string[] = [];

function recordError(file: string, msg: string): void {
  errors.push(`[${file}] ${msg}`);
}

function checkOne(exp: CRDExpectation): void {
  const path = join(crdsDir, exp.file);
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (e) {
    recordError(exp.file, `cannot read ${path}: ${(e as Error).message}`);
    return;
  }
  const crd = parseCRD(text);

  if (crd.group !== API_GROUP) {
    recordError(exp.file, `spec.group=${crd.group}, expected ${API_GROUP}`);
  }
  if (crd.kind !== exp.kind) {
    recordError(exp.file, `names.kind=${crd.kind}, expected ${exp.kind}`);
  }
  if (crd.plural !== exp.plural) {
    recordError(exp.file, `names.plural=${crd.plural}, expected ${exp.plural}`);
  }
  if (!crd.versionNames.includes(API_VERSION)) {
    recordError(
      exp.file,
      `versions does not contain ${API_VERSION}; got ${JSON.stringify(crd.versionNames)}`,
    );
  }
  const expectedMetaName = `${exp.plural}.${API_GROUP}`;
  if (crd.metadataName !== expectedMetaName) {
    recordError(exp.file, `metadata.name=${crd.metadataName}, expected ${expectedMetaName}`);
  }

  for (const r of exp.specRequired) {
    if (!crd.specRequired.includes(r)) {
      recordError(exp.file, `spec.required missing "${r}" — TS types treat it as non-optional`);
    }
  }

  for (const p of exp.specProperties) {
    if (!crd.specProperties.includes(p)) {
      recordError(exp.file, `spec.properties missing "${p}" — declared in TS types/types.ts`);
    }
  }

  if (exp.statusProperties) {
    for (const p of exp.statusProperties) {
      if (!crd.statusProperties.includes(p)) {
        recordError(
          exp.file,
          `status.properties missing "${p}" — operator/agent-pod reads or writes this field`,
        );
      }
    }
  }
}

const present = new Set(readdirSync(crdsDir).filter((f) => f.endsWith('.yaml')));
for (const exp of expectations) {
  if (!present.has(exp.file)) {
    recordError(exp.file, 'expected CRD file is missing');
    continue;
  }
  checkOne(exp);
}

const unexpected = [...present].filter(
  (f) => !expectations.some((e) => e.file === f) && f !== 'README.md',
);
for (const f of unexpected) {
  console.warn(`[check-crd-drift] note: unrecognized CRD file ${f} (no expectation)`);
}

if (errors.length > 0) {
  console.error(`[check-crd-drift] DRIFT DETECTED — ${errors.length} issue(s):`);
  for (const e of errors) console.error(`  - ${e}`);
  console.error('');
  console.error(
    '  Fix by reconciling packages/operator/manifests/crds/*.yaml with packages/operator/src/crds/types.ts.',
  );
  console.error(
    '  See packages/operator/scripts/CRD-DRIFT-NOTES.md for what is and is not checked.',
  );
  process.exit(1);
}

console.log(
  `[check-crd-drift] OK — ${expectations.length} CRDs match TS types (group=${API_GROUP}, version=${API_VERSION})`,
);
