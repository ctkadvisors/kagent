/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * Public re-exports for embedding `kagent`'s submit logic into other
 * Node tools (webhook handlers, scheduled-job wrappers, etc.) without
 * shelling out to the binary. The binary entry point is `cli.ts`.
 */

export { submitTask, waitForTask, type SubmitOptions } from './commands/submit.js';
export {
  createKubeClient,
  type KubeClient,
  type CreateAgentTaskInput,
  type AgentTaskCreated,
  type AgentTaskStatus,
} from './k8s-client.js';
