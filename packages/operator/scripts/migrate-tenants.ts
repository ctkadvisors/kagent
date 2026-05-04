#!/usr/bin/env tsx
/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * migrate-tenants — Wave 4 / Tenancy CLI tool (v0.5.0-tenancy).
 *
 * Rewrites an Agent's `metadata.labels[kagent.knuteson.io/tenant]`
 * label from one tenant to another AND cascades the label-rewrite to
 * all in-flight AgentTasks owned by that Agent.
 *
 * Usage:
 *
 *   node scripts/migrate-tenants.ts move \
 *     <agent-name> \
 *     --from-tenant <a> \
 *     --to-tenant <b> \
 *     [--namespace <ns>] \
 *     [--apply]   # dry-run by default
 *
 * Refusal taxonomy:
 *   - Target tenant CR doesn't exist: error + exit 1
 *   - Target tenant's namespaceAllowlist doesn't include the Agent's
 *     namespace: error + exit 1
 *   - Source tenant doesn't match the Agent's current label: error
 *     + exit 1
 *
 * Best-effort: prints the migration plan first; only commits with
 * `--apply`. Tested with mocked K8s client (see migrate-tenants.test.ts).
 *
 * Per docs/WAVES.md §6.1 deliverable 5.
 */

import { CustomObjectsApi, KubeConfig } from '@kubernetes/client-node';

import {
  API_GROUP,
  API_VERSION,
  TENANT_LABEL,
  isTenant,
  tenantAdmitsNamespace,
  type Agent,
  type AgentTask,
  type Tenant,
} from '../src/crds/index.js';

/* =====================================================================
 * Pure helpers — testable in isolation, no K8s I/O.
 * ===================================================================== */

export interface MigrationPlanInput {
  readonly agent: Agent;
  readonly inFlightTasks: readonly AgentTask[];
  readonly fromTenant: string;
  readonly toTenant: string;
  readonly toTenantCr: Tenant | undefined;
}

export type MigrationPlan =
  | {
      readonly ok: true;
      readonly agentPatchNeeded: boolean;
      readonly taskPatches: readonly { readonly namespace: string; readonly name: string }[];
      readonly summary: string;
    }
  | {
      readonly ok: false;
      readonly reason:
        | 'TargetTenantNotFound'
        | 'TargetNamespaceNotAllowed'
        | 'SourceTenantMismatch'
        | 'AgentMissingNamespace';
      readonly message: string;
    };

/**
 * Compute the migration plan from the resolved Agent + in-flight
 * AgentTask cache + target Tenant CR. Pure: no I/O. The CLI's
 * commit step uses this plan + only patches when `--apply`.
 */
export function computeMigrationPlan(input: MigrationPlanInput): MigrationPlan {
  const { agent, inFlightTasks, fromTenant, toTenant, toTenantCr } = input;
  const agentName = agent.metadata.name ?? '';
  const agentNamespace = agent.metadata.namespace;
  if (typeof agentNamespace !== 'string' || agentNamespace.length === 0) {
    return {
      ok: false,
      reason: 'AgentMissingNamespace',
      message: `Agent ${agentName} is missing metadata.namespace; cannot resolve tenant scope`,
    };
  }
  const currentTenant = agent.metadata.labels?.[TENANT_LABEL];
  if (currentTenant !== fromTenant) {
    return {
      ok: false,
      reason: 'SourceTenantMismatch',
      message: `Agent ${agentNamespace}/${agentName} has tenant label "${currentTenant ?? '(none)'}", expected "${fromTenant}"`,
    };
  }
  if (toTenantCr === undefined) {
    return {
      ok: false,
      reason: 'TargetTenantNotFound',
      message: `Target tenant "${toTenant}" not found in cluster (no Tenant CR)`,
    };
  }
  if (!tenantAdmitsNamespace(toTenantCr, agentNamespace)) {
    return {
      ok: false,
      reason: 'TargetNamespaceNotAllowed',
      message: `Target tenant "${toTenant}" namespaceAllowlist does not include Agent's namespace "${agentNamespace}" (allowlist: ${toTenantCr.spec.namespaceAllowlist.join(', ')})`,
    };
  }
  const taskPatches = inFlightTasks
    .filter((t) => t.metadata.labels?.[TENANT_LABEL] === fromTenant)
    .map((t) => ({
      namespace: t.metadata.namespace ?? agentNamespace,
      name: t.metadata.name ?? '',
    }))
    .filter((r) => r.name.length > 0);
  return {
    ok: true,
    agentPatchNeeded: true,
    taskPatches,
    summary: `Migrate Agent ${agentNamespace}/${agentName} (${fromTenant} → ${toTenant}); cascading ${String(taskPatches.length)} in-flight AgentTask label patches`,
  };
}

/* =====================================================================
 * K8s I/O wrapper — injected so tests can mock without a KubeConfig.
 * ===================================================================== */

export interface MigrationDeps {
  readonly customApi: CustomObjectsApi;
  /** Audit-emission hook — called once per successful migration. */
  readonly emitMigration?: (data: MigrationAuditData) => Promise<void>;
}

export interface MigrationAuditData {
  readonly agentName: string;
  readonly agentNamespace: string;
  readonly fromTenant: string;
  readonly toTenant: string;
  readonly agentTaskCount: number;
  readonly dryRun: boolean;
  readonly actor: string;
}

export interface RunMigrationInput {
  readonly agentName: string;
  readonly fromTenant: string;
  readonly toTenant: string;
  readonly namespace: string;
  /** When false (default), nothing is patched — plan only. */
  readonly apply: boolean;
  /** Actor identity for audit. Defaults to `cli/migrate-tenants`. */
  readonly actor?: string;
}

export interface RunMigrationResult {
  readonly plan: MigrationPlan;
  readonly applied: boolean;
  readonly agentPatched: boolean;
  readonly tasksPatched: number;
}

/**
 * High-level migration runner. Looks up Agent + Tenant CR + in-flight
 * AgentTasks via the customApi, calls `computeMigrationPlan`, and
 * (when `apply=true`) issues label patches on each.
 */
export async function runMigration(
  input: RunMigrationInput,
  deps: MigrationDeps,
): Promise<RunMigrationResult> {
  // 1. Read Agent.
  const agentObj: unknown = await deps.customApi.getNamespacedCustomObject({
    group: API_GROUP,
    version: API_VERSION,
    namespace: input.namespace,
    plural: 'agents',
    name: input.agentName,
  });
  const agent = agentObj as Agent;

  // 2. Read target Tenant (cluster-scoped).
  let toTenantCr: Tenant | undefined;
  try {
    const t: unknown = await deps.customApi.getClusterCustomObject({
      group: API_GROUP,
      version: API_VERSION,
      plural: 'tenants',
      name: input.toTenant,
    });
    if (isTenant(t)) toTenantCr = t;
  } catch {
    toTenantCr = undefined;
  }

  // 3. List in-flight AgentTasks in the same namespace; filter by
  // owning Agent name (label `kagent.knuteson.io/agent`).
  const tasksList: unknown = await deps.customApi.listNamespacedCustomObject({
    group: API_GROUP,
    version: API_VERSION,
    namespace: input.namespace,
    plural: 'agenttasks',
  });
  const items =
    typeof tasksList === 'object' && tasksList !== null && 'items' in tasksList
      ? (tasksList as { items: unknown[] }).items
      : [];
  const inFlight: AgentTask[] = [];
  for (const t of items) {
    if (typeof t !== 'object' || t === null) continue;
    const task = t as AgentTask;
    if (task.metadata.labels?.['kagent.knuteson.io/agent'] !== input.agentName) continue;
    const phase = task.status?.phase;
    if (phase === 'Completed' || phase === 'Failed') continue;
    inFlight.push(task);
  }

  // 4. Compute plan.
  const plan = computeMigrationPlan({
    agent,
    inFlightTasks: inFlight,
    fromTenant: input.fromTenant,
    toTenant: input.toTenant,
    toTenantCr,
  });

  if (!plan.ok) {
    return { plan, applied: false, agentPatched: false, tasksPatched: 0 };
  }

  // 5. Apply when requested.
  let agentPatched = false;
  let tasksPatched = 0;
  if (input.apply) {
    // Patch the Agent.
    await deps.customApi.patchNamespacedCustomObject({
      group: API_GROUP,
      version: API_VERSION,
      namespace: input.namespace,
      plural: 'agents',
      name: input.agentName,
      body: { metadata: { labels: { [TENANT_LABEL]: input.toTenant } } } as object,
    });
    agentPatched = true;
    // Cascade to in-flight AgentTasks.
    for (const ref of plan.taskPatches) {
      try {
        await deps.customApi.patchNamespacedCustomObject({
          group: API_GROUP,
          version: API_VERSION,
          namespace: ref.namespace,
          plural: 'agenttasks',
          name: ref.name,
          body: { metadata: { labels: { [TENANT_LABEL]: input.toTenant } } } as object,
        });
        tasksPatched++;
      } catch (err) {
        console.warn(
          `[migrate-tenants] failed to patch AgentTask ${ref.namespace}/${ref.name}:`,
          err,
        );
      }
    }
  }

  // 6. Audit emission (best-effort).
  if (deps.emitMigration !== undefined) {
    const data: MigrationAuditData = {
      agentName: input.agentName,
      agentNamespace: input.namespace,
      fromTenant: input.fromTenant,
      toTenant: input.toTenant,
      agentTaskCount: plan.taskPatches.length,
      dryRun: !input.apply,
      actor: input.actor ?? 'cli/migrate-tenants',
    };
    try {
      await deps.emitMigration(data);
    } catch (err) {
      console.warn('[migrate-tenants] audit emission raised (dropping):', err);
    }
  }

  return {
    plan,
    applied: input.apply,
    agentPatched,
    tasksPatched,
  };
}

/* =====================================================================
 * CLI entrypoint — argv parser + dispatcher. Tests don't drive this
 * directly; they exercise `runMigration` against a mocked customApi.
 * ===================================================================== */

interface ParsedArgs {
  readonly subcommand: 'move' | 'help';
  readonly agentName?: string;
  readonly fromTenant?: string;
  readonly toTenant?: string;
  readonly namespace?: string;
  readonly apply?: boolean;
}

export function parseArgs(argv: readonly string[]): ParsedArgs {
  if (argv.length === 0) return { subcommand: 'help' };
  const subcommand = argv[0];
  if (subcommand !== 'move') return { subcommand: 'help' };

  let agentName: string | undefined;
  let fromTenant: string | undefined;
  let toTenant: string | undefined;
  let namespace: string | undefined = 'default';
  let apply = false;

  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--from-tenant') {
      fromTenant = argv[++i];
    } else if (a === '--to-tenant') {
      toTenant = argv[++i];
    } else if (a === '--namespace' || a === '-n') {
      namespace = argv[++i];
    } else if (a === '--apply') {
      apply = true;
    } else if (typeof a === 'string' && !a.startsWith('--') && agentName === undefined) {
      agentName = a;
    }
  }

  return {
    subcommand: 'move',
    ...(agentName !== undefined && { agentName }),
    ...(fromTenant !== undefined && { fromTenant }),
    ...(toTenant !== undefined && { toTenant }),
    ...(namespace !== undefined && { namespace }),
    apply,
  };
}

function printHelp(): void {
  process.stdout.write(
    [
      'migrate-tenants — Wave 4 / Tenancy CLI (v0.5.0-tenancy)',
      '',
      'Usage:',
      '  node scripts/migrate-tenants.ts move <agent-name> \\',
      '    --from-tenant <a> \\',
      '    --to-tenant <b> \\',
      '    [--namespace <ns>] \\',
      '    [--apply]   # dry-run by default',
      '',
      'Refuses if the target tenant CR is missing OR its',
      'namespaceAllowlist does not include the Agent namespace.',
      '',
      '`--apply` commits the patches; without it the run is a dry-run',
      '(plan only; no patches issued).',
      '',
    ].join('\n'),
  );
}

/* =====================================================================
 * Production main — used when the script is executed directly.
 * Tests import `runMigration` and bypass main().
 * ===================================================================== */

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  if (args.subcommand !== 'move') {
    printHelp();
    return 0;
  }
  if (
    args.agentName === undefined ||
    args.fromTenant === undefined ||
    args.toTenant === undefined
  ) {
    process.stderr.write(
      'migrate-tenants: missing required args (<agent-name>, --from-tenant, --to-tenant)\n',
    );
    printHelp();
    return 2;
  }
  const kc = new KubeConfig();
  kc.loadFromDefault();
  const customApi = kc.makeApiClient(CustomObjectsApi);

  const result = await runMigration(
    {
      agentName: args.agentName,
      fromTenant: args.fromTenant,
      toTenant: args.toTenant,
      namespace: args.namespace ?? 'default',
      apply: args.apply ?? false,
    },
    { customApi },
  );

  if (!result.plan.ok) {
    process.stderr.write(
      `migrate-tenants: REFUSED — ${result.plan.reason}: ${result.plan.message}\n`,
    );
    return 1;
  }
  process.stdout.write(`${result.plan.summary}\n`);
  if (result.applied) {
    process.stdout.write(
      `migrate-tenants: APPLIED — agent patched, ${String(result.tasksPatched)}/${String(result.plan.taskPatches.length)} tasks patched\n`,
    );
  } else {
    process.stdout.write('migrate-tenants: DRY-RUN — pass --apply to commit\n');
  }
  return 0;
}

const isDirectInvocation =
  typeof process.argv[1] === 'string' &&
  import.meta.url === new URL(`file://${process.argv[1]}`).href;

if (isDirectInvocation) {
  main()
    .then((code) => process.exit(code))
    .catch((err: unknown) => {
      process.stderr.write(
        `migrate-tenants: fatal: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      process.exit(1);
    });
}
