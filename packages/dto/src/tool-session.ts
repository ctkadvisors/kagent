/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * Shared DTOs and pure helpers for task-scoped browser/code tool sessions.
 *
 * The load-bearing invariant is that a session is not identified by a
 * session id alone. Every lookup includes tenant, namespace, AgentTask UID,
 * tool kind, and session id so sibling/child tasks cannot reuse each other's
 * browser cookies, code workspace, CDP URL, or process state.
 */

export const TOOL_KINDS = ['browser', 'code_interpreter'] as const;
export type ToolKind = (typeof TOOL_KINDS)[number];

export const CODE_INTERPRETER_TOOL_NAMES = [
  'code_interpreter.start_session',
  'code_interpreter.execute_code',
  'code_interpreter.execute_command',
  'code_interpreter.start_command',
  'code_interpreter.read_files',
  'code_interpreter.write_files',
  'code_interpreter.list_files',
  'code_interpreter.stop_task',
  'code_interpreter.terminate_session',
] as const;
export type CodeInterpreterToolName = (typeof CODE_INTERPRETER_TOOL_NAMES)[number];

export const BROWSER_TOOL_NAMES = [
  'browser.start_session',
  'browser.goto',
  'browser.click',
  'browser.type',
  'browser.select',
  'browser.wait_for',
  'browser.screenshot',
  'browser.extract_text',
  'browser.cdp_url',
  'browser.live_view_url',
  'browser.recording_url',
  'browser.terminate_session',
] as const;
export type BrowserToolName = (typeof BROWSER_TOOL_NAMES)[number];

export type ToolRuntimeToolName = CodeInterpreterToolName | BrowserToolName;

export const DEFAULT_TOOL_SESSION_ENV = {
  HOME: '/workspace',
  TMPDIR: '/tmp',
  PATH: '/usr/local/bin:/usr/bin:/bin',
  LANG: 'C.UTF-8',
} as const;

export const FORBIDDEN_TOOL_SESSION_ENV_KEYS = [
  'OPENAI_API_KEY',
  'CLOUDFLARE_API_TOKEN',
  'ANTHROPIC_API_KEY',
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'KUBECONFIG',
  'KUBERNETES_SERVICE_HOST',
  'KUBERNETES_SERVICE_PORT',
  'GITHUB_TOKEN',
  'LANGFUSE_SECRET_KEY',
  'DATABASE_URL',
] as const;

export interface ToolSessionIdentity {
  readonly tenant: string;
  readonly namespace: string;
  readonly agentTaskUid: string;
  readonly toolKind: ToolKind;
  readonly sessionId: string;
}

export interface ToolSessionEnvContext {
  readonly taskUid: string;
  readonly agentName: string;
  readonly namespace: string;
  readonly sessionId: string;
  readonly toolKind: ToolKind;
}

export interface ToolSessionRecord extends ToolSessionIdentity {
  readonly agentName: string;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly idleExpiresAt?: string;
  readonly status: 'starting' | 'ready' | 'terminating' | 'terminated' | 'failed';
  readonly sandboxName?: string;
  readonly podName?: string;
}

export function isToolKind(value: unknown): value is ToolKind {
  return typeof value === 'string' && (TOOL_KINDS as readonly string[]).includes(value);
}

export function isCodeInterpreterTool(value: unknown): value is CodeInterpreterToolName {
  return (
    typeof value === 'string' && (CODE_INTERPRETER_TOOL_NAMES as readonly string[]).includes(value)
  );
}

export function isBrowserTool(value: unknown): value is BrowserToolName {
  return typeof value === 'string' && (BROWSER_TOOL_NAMES as readonly string[]).includes(value);
}

export function isToolRuntimeTool(value: unknown): value is ToolRuntimeToolName {
  return isCodeInterpreterTool(value) || isBrowserTool(value);
}

export function isForbiddenToolSessionEnvKey(key: string): boolean {
  const normalized = key.toUpperCase();
  return (FORBIDDEN_TOOL_SESSION_ENV_KEYS as readonly string[]).includes(normalized);
}

export function buildToolSessionKey(identity: ToolSessionIdentity): string {
  return [
    identity.tenant,
    identity.namespace,
    identity.agentTaskUid,
    identity.toolKind,
    identity.sessionId,
  ].join('/');
}

export function filterToolSessionEnv(
  _ambientEnv: Readonly<Record<string, string | undefined>>,
  context: ToolSessionEnvContext,
): Record<string, string> {
  return {
    ...DEFAULT_TOOL_SESSION_ENV,
    KAGENT_TASK_UID: context.taskUid,
    KAGENT_AGENT_NAME: context.agentName,
    KAGENT_NAMESPACE: context.namespace,
    KAGENT_TOOL_SESSION_ID: context.sessionId,
    KAGENT_TOOL_KIND: context.toolKind,
  };
}
