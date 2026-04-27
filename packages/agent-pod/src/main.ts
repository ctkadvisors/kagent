/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * Agent-pod entrypoint. Boots once per AgentTask:
 *
 *   1. Parse env (operator-injected) into a PodConfig.
 *   2. Run the agent loop against LiteLLM.
 *   3. Patch AgentTask.status via the K8s API.
 *   4. Exit (Job controller GCs the Pod after ttlSecondsAfterFinished).
 *
 * Designed for Bun (`bun src/main.ts`) but runs equivalently under
 * Node 22 + tsx. The Dockerfile baked in Phase 3 C7 uses Bun.
 */

import { parseEnv } from './env.js';
import { runAgentTask } from './runner.js';
import { buildStatusPatch, makeCustomObjectsApi, writeStatus } from './status.js';

async function main(): Promise<void> {
  const config = parseEnv(process.env);
  console.log(
    `[kagent-agent-pod] boot ${config.taskNamespace}/${config.taskName} ` +
      `agent=${config.agentName} model=${config.agentSpec.model}`,
  );

  let result;
  try {
    result = await runAgentTask(config);
  } catch (err) {
    // Hard failure inside the runner (e.g. cannot reach LiteLLM, fatal
    // executor error). Still try to patch status so the operator sees
    // a terminal phase rather than a perpetually-Pending task.
    const message = err instanceof Error ? err.message : String(err);
    console.error('[kagent-agent-pod] runner threw:', message);
    const api = makeCustomObjectsApi();
    await writeStatus(
      config,
      {
        phase: 'Failed',
        error: `runner threw: ${message}`,
        completedAt: new Date().toISOString(),
        structuralVerdict: { suspicious: [] },
      },
      api,
    );
    process.exit(1);
  }

  console.log(
    `[kagent-agent-pod] loop done status=${result.status} flags=[${result.flags.join(',')}] ` +
      `inputTokens=${result.budget.cumulativeInputTokens} outputTokens=${result.budget.cumulativeOutputTokens}`,
  );

  const api = makeCustomObjectsApi();
  await writeStatus(config, buildStatusPatch(result, new Date()), api);

  console.log(`[kagent-agent-pod] status patched, exiting`);
}

const isDirectInvocation =
  typeof process.argv[1] === 'string' &&
  import.meta.url === new URL(`file://${process.argv[1]}`).href;

if (isDirectInvocation) {
  main().catch((err: unknown) => {
    console.error('[kagent-agent-pod] fatal:', err);
    process.exit(1);
  });
}
