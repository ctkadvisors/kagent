/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

import type { ToolCall, ToolResult } from '@kagent/agent-loop';

import {
  SteelBrowserAdapter,
  type BrowserClickOptions,
  type BrowserSelectOptions,
  type BrowserTypeTextOptions,
  type BrowserWaitForOptions,
  type SteelBrowserSession,
} from './browser-steel.js';
import { LocalCodeRunner, type ExecuteCodeInput, type ExecuteCommandInput } from './code-runner.js';

export interface ToolGatewayTaskIdentity {
  readonly tenant: string;
  readonly namespace: string;
  readonly taskUid: string;
  readonly agentName: string;
}

export interface ToolGatewayInvocation {
  readonly task: ToolGatewayTaskIdentity;
  readonly call: ToolCall;
}

export interface ToolGatewayHandlerInput extends ToolGatewayInvocation {
  readonly request: Request;
}

export type ToolGatewayExternalHandler = (
  input: ToolGatewayHandlerInput,
) => Promise<ToolResult> | ToolResult;

export interface ToolGatewayHttpHandlerOptions {
  readonly codeRunner?: LocalCodeRunner;
  readonly browser?: SteelBrowserAdapter;
  readonly externalHandlers?: Readonly<Record<string, ToolGatewayExternalHandler>>;
  readonly paused?: boolean;
}

export class ToolGatewayHttpHandler {
  private readonly codeRunner: LocalCodeRunner | undefined;
  private readonly browser: SteelBrowserAdapter | undefined;
  private readonly externalHandlers: Readonly<Record<string, ToolGatewayExternalHandler>>;
  private readonly browserSessions = new Map<string, SteelBrowserSession>();
  private paused: boolean;

  constructor(options: ToolGatewayHttpHandlerOptions = {}) {
    this.codeRunner = options.codeRunner;
    this.browser = options.browser;
    this.externalHandlers = options.externalHandlers ?? {};
    this.paused = options.paused ?? false;
  }

  setPaused(paused: boolean): void {
    this.paused = paused;
  }

  async handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method !== 'POST' || url.pathname !== '/v1/tool-runtime/invoke') {
      return jsonResponse({ error: 'not_found' }, 404);
    }

    if (this.paused) {
      return jsonResponse({ error: 'tool_runtime_paused' }, 503);
    }

    const invocation = await parseInvocation(request);
    if (invocation === null) {
      return jsonResponse({ error: 'invalid_request' }, 400);
    }
    if (!requestHeadersMatchTask(request, invocation.task)) {
      return jsonResponse(
        { error: 'policy_denied: task identity mismatch between headers and request body' },
        403,
      );
    }

    const external = this.externalHandlers[invocation.call.name];
    if (external !== undefined) {
      return jsonResponse(await external({ ...invocation, request }));
    }

    return jsonResponse(await this.invokeRuntimeTool(invocation));
  }

  private async invokeRuntimeTool(invocation: ToolGatewayInvocation): Promise<ToolResult> {
    switch (invocation.call.name) {
      case 'code_interpreter.start_session':
        this.requireCodeRunner();
        return { content: 'code_interpreter session ready', isError: false };
      case 'code_interpreter.execute_code':
        return this.executeCode(invocation.call.args);
      case 'code_interpreter.execute_command':
        return this.executeCommand(invocation.call.args);
      case 'code_interpreter.read_files':
        return this.readFiles(invocation.call.args);
      case 'code_interpreter.write_files':
        return this.writeFiles(invocation.call.args);
      case 'code_interpreter.list_files':
        return this.listFiles(invocation.call.args);
      case 'code_interpreter.start_command':
      case 'code_interpreter.stop_task':
        return {
          content: `${invocation.call.name} is not implemented by the local MVP runner`,
          isError: true,
          metadata: { policy: 'unsupported-runtime-tool' },
        };
      case 'code_interpreter.terminate_session':
        return { content: 'code_interpreter session terminated', isError: false };
      case 'browser.start_session':
        return this.startBrowserSession(invocation.task, invocation.call.args);
      case 'browser.goto':
        return this.browserGoto(invocation.task, invocation.call.args);
      case 'browser.click':
        return this.browserClick(invocation.task, invocation.call.args);
      case 'browser.type':
        return this.browserType(invocation.task, invocation.call.args);
      case 'browser.select':
        return this.browserSelect(invocation.task, invocation.call.args);
      case 'browser.wait_for':
        return this.browserWaitFor(invocation.task, invocation.call.args);
      case 'browser.screenshot':
        return this.browserScreenshot(invocation.task, invocation.call.args);
      case 'browser.extract_text':
        return this.browserExtractText(invocation.task, invocation.call.args);
      case 'browser.cdp_url':
      case 'browser.live_view_url':
      case 'browser.recording_url':
        return this.browserSessionUrl(invocation.task, invocation.call.name);
      case 'browser.terminate_session':
        return this.terminateBrowserSession(invocation.task);
      default:
        return {
          content: `unknown runtime tool "${invocation.call.name}"`,
          isError: true,
          metadata: { policy: 'unknown-tool' },
        };
    }
  }

  private async executeCode(args: unknown): Promise<ToolResult> {
    const runner = this.requireCodeRunner();
    const input = parseExecuteCodeInput(args);
    if (input === null) return invalidArgs('code_interpreter.execute_code');

    const result = await runner.executeCode(input);
    return commandResultToToolResult(result);
  }

  private async executeCommand(args: unknown): Promise<ToolResult> {
    const runner = this.requireCodeRunner();
    const input = parseExecuteCommandInput(args);
    if (input === null) return invalidArgs('code_interpreter.execute_command');

    const result = await runner.executeCommand(input);
    return commandResultToToolResult(result);
  }

  private async readFiles(args: unknown): Promise<ToolResult> {
    const paths = isRecord(args) && Array.isArray(args.paths) ? args.paths : null;
    if (paths === null || !paths.every((path): path is string => typeof path === 'string')) {
      return invalidArgs('code_interpreter.read_files');
    }

    return {
      content: JSON.stringify(await this.requireCodeRunner().readFiles(paths)),
      isError: false,
    };
  }

  private async writeFiles(args: unknown): Promise<ToolResult> {
    const files = isRecord(args) && Array.isArray(args.files) ? args.files : null;
    if (
      files === null ||
      !files.every(
        (file): file is { readonly path: string; readonly content: string } =>
          isRecord(file) && typeof file.path === 'string' && typeof file.content === 'string',
      )
    ) {
      return invalidArgs('code_interpreter.write_files');
    }

    await this.requireCodeRunner().writeFiles(files);
    return { content: `wrote ${files.length} file(s)`, isError: false };
  }

  private async listFiles(args: unknown): Promise<ToolResult> {
    const root = isRecord(args) && typeof args.root === 'string' ? args.root : '.';
    return {
      content: JSON.stringify(await this.requireCodeRunner().listFiles(root)),
      isError: false,
    };
  }

  private async startBrowserSession(
    task: ToolGatewayTaskIdentity,
    args: unknown,
  ): Promise<ToolResult> {
    const session = await this.requireBrowser().startSession(parseBrowserStartArgs(args));
    this.browserSessions.set(taskKey(task), session);
    return {
      content: JSON.stringify(session),
      isError: false,
      metadata: { sessionId: session.id },
    };
  }

  private async browserGoto(task: ToolGatewayTaskIdentity, args: unknown): Promise<ToolResult> {
    if (!isRecord(args) || typeof args.url !== 'string') return invalidArgs('browser.goto');
    const session = await this.requireBrowserSession(task);
    const timeoutMs = typeof args.timeoutMs === 'number' ? args.timeoutMs : undefined;
    const result = await this.requireBrowser().goto(session, args.url, { timeoutMs });
    return {
      content: JSON.stringify(result),
      isError: false,
      metadata: { sessionId: session.id },
    };
  }

  private async browserClick(task: ToolGatewayTaskIdentity, args: unknown): Promise<ToolResult> {
    const input = parseBrowserClickInput(args);
    if (input === null) return invalidArgs('browser.click');
    const session = await this.requireBrowserSession(task);
    const result = await this.requireBrowser().click(session, input);
    return {
      content: JSON.stringify(result),
      isError: false,
      metadata: { sessionId: session.id },
    };
  }

  private async browserType(task: ToolGatewayTaskIdentity, args: unknown): Promise<ToolResult> {
    const input = parseBrowserTypeInput(args);
    if (input === null) return invalidArgs('browser.type');
    const session = await this.requireBrowserSession(task);
    const result = await this.requireBrowser().typeText(session, input);
    return {
      content: JSON.stringify(result),
      isError: false,
      metadata: { sessionId: session.id },
    };
  }

  private async browserSelect(task: ToolGatewayTaskIdentity, args: unknown): Promise<ToolResult> {
    const input = parseBrowserSelectInput(args);
    if (input === null) return invalidArgs('browser.select');
    const session = await this.requireBrowserSession(task);
    const result = await this.requireBrowser().select(session, input);
    return {
      content: JSON.stringify(result),
      isError: false,
      metadata: { sessionId: session.id },
    };
  }

  private async browserWaitFor(task: ToolGatewayTaskIdentity, args: unknown): Promise<ToolResult> {
    const input = parseBrowserWaitForInput(args);
    if (input === null) return invalidArgs('browser.wait_for');
    const session = await this.requireBrowserSession(task);
    const result = await this.requireBrowser().waitFor(session, input);
    return {
      content: JSON.stringify(result),
      isError: false,
      metadata: { sessionId: session.id },
    };
  }

  private async browserScreenshot(
    task: ToolGatewayTaskIdentity,
    args: unknown,
  ): Promise<ToolResult> {
    const session = await this.requireBrowserSession(task);
    const fullPage =
      isRecord(args) && typeof args.fullPage === 'boolean' ? args.fullPage : undefined;
    const screenshot = await this.requireBrowser().screenshot(
      session,
      fullPage === undefined ? {} : { fullPage },
    );
    return {
      content: [{ type: 'image', bytes: screenshot.base64, mimeType: screenshot.mimeType }],
      isError: false,
      metadata: { sessionId: session.id },
    };
  }

  private async browserExtractText(
    task: ToolGatewayTaskIdentity,
    args: unknown,
  ): Promise<ToolResult> {
    const session = await this.requireBrowserSession(task);
    const maxChars =
      isRecord(args) && typeof args.maxChars === 'number' ? args.maxChars : undefined;
    const result = await this.requireBrowser().extractText(session, { maxChars });
    return {
      content: result.text,
      isError: false,
      metadata: { sessionId: session.id },
    };
  }

  private async browserSessionUrl(
    task: ToolGatewayTaskIdentity,
    toolName: string,
  ): Promise<ToolResult> {
    const session = await this.requireBrowserSession(task);
    const content =
      toolName === 'browser.cdp_url'
        ? session.cdpUrl
        : toolName === 'browser.recording_url'
          ? session.recordingUrl
          : session.liveViewUrl;
    return {
      content,
      isError: false,
      metadata: { sessionId: session.id },
    };
  }

  private async terminateBrowserSession(task: ToolGatewayTaskIdentity): Promise<ToolResult> {
    const key = taskKey(task);
    const session = this.browserSessions.get(key);
    if (session !== undefined) {
      await this.requireBrowser().releaseSession(session.id);
      this.browserSessions.delete(key);
    }
    return { content: 'browser session terminated', isError: false };
  }

  private async requireBrowserSession(task: ToolGatewayTaskIdentity): Promise<SteelBrowserSession> {
    const key = taskKey(task);
    const existing = this.browserSessions.get(key);
    if (existing !== undefined) return existing;

    const session = await this.requireBrowser().startSession();
    this.browserSessions.set(key, session);
    return session;
  }

  private requireCodeRunner(): LocalCodeRunner {
    if (this.codeRunner === undefined) {
      throw new Error('tool_gateway_misconfigured: code runner is not configured');
    }
    return this.codeRunner;
  }

  private requireBrowser(): SteelBrowserAdapter {
    if (this.browser === undefined) {
      throw new Error('tool_gateway_misconfigured: browser adapter is not configured');
    }
    return this.browser;
  }
}

async function parseInvocation(request: Request): Promise<ToolGatewayInvocation | null> {
  const raw = await request.json().catch(() => null);
  if (!isRecord(raw) || !isRecord(raw.task) || !isRecord(raw.call)) return null;

  const task = parseTask(raw.task);
  if (task === null) return null;
  if (typeof raw.call.id !== 'string' || typeof raw.call.name !== 'string') return null;

  return {
    task,
    call: {
      id: raw.call.id,
      name: raw.call.name,
      args: raw.call.args,
    },
  };
}

function parseTask(raw: Record<string, unknown>): ToolGatewayTaskIdentity | null {
  if (
    typeof raw.tenant !== 'string' ||
    typeof raw.namespace !== 'string' ||
    typeof raw.taskUid !== 'string' ||
    typeof raw.agentName !== 'string'
  ) {
    return null;
  }

  return {
    tenant: raw.tenant,
    namespace: raw.namespace,
    taskUid: raw.taskUid,
    agentName: raw.agentName,
  };
}

function requestHeadersMatchTask(request: Request, task: ToolGatewayTaskIdentity): boolean {
  return (
    request.headers.get('x-kagent-tenant') === task.tenant &&
    request.headers.get('x-kagent-namespace') === task.namespace &&
    request.headers.get('x-kagent-task-uid') === task.taskUid &&
    request.headers.get('x-kagent-agent') === task.agentName
  );
}

function parseExecuteCodeInput(args: unknown): ExecuteCodeInput | null {
  if (!isRecord(args) || typeof args.code !== 'string') return null;
  if (
    args.language !== 'python' &&
    args.language !== 'javascript' &&
    args.language !== 'typescript'
  ) {
    return null;
  }

  const input: ExecuteCodeInput = {
    language: args.language,
    code: args.code,
  };
  if (typeof args.timeoutMs === 'number') return { ...input, timeoutMs: args.timeoutMs };
  return input;
}

function parseExecuteCommandInput(args: unknown): ExecuteCommandInput | null {
  if (!isRecord(args) || typeof args.command !== 'string') return null;
  const input: ExecuteCommandInput = {
    command: args.command,
  };
  const withArgs =
    Array.isArray(args.args) && args.args.every((arg): arg is string => typeof arg === 'string')
      ? { ...input, args: args.args }
      : input;
  if (typeof args.timeoutMs === 'number') return { ...withArgs, timeoutMs: args.timeoutMs };
  return withArgs;
}

function parseBrowserStartArgs(args: unknown): Parameters<SteelBrowserAdapter['startSession']>[0] {
  if (!isRecord(args)) return {};
  const out: {
    timeoutMs?: number;
    inactivityTimeoutMs?: number;
    viewport?: { width: number; height: number };
  } = {};
  if (typeof args.timeoutMs === 'number') out.timeoutMs = args.timeoutMs;
  if (typeof args.inactivityTimeoutMs === 'number')
    out.inactivityTimeoutMs = args.inactivityTimeoutMs;
  if (isRecord(args.viewport)) {
    const width = args.viewport.width;
    const height = args.viewport.height;
    if (typeof width === 'number' && typeof height === 'number') out.viewport = { width, height };
  }
  return out;
}

function parseBrowserClickInput(args: unknown): BrowserClickOptions | null {
  if (!isRecord(args)) return null;
  const selector =
    typeof args.selector === 'string' && args.selector.length > 0 ? args.selector : undefined;
  const text = typeof args.text === 'string' && args.text.length > 0 ? args.text : undefined;
  if (selector === undefined && text === undefined) return null;

  return {
    selector,
    text,
    timeoutMs: typeof args.timeoutMs === 'number' ? args.timeoutMs : undefined,
  };
}

function parseBrowserTypeInput(args: unknown): BrowserTypeTextOptions | null {
  if (!isRecord(args) || typeof args.selector !== 'string' || typeof args.text !== 'string') {
    return null;
  }
  if (args.selector.length === 0) return null;

  return {
    selector: args.selector,
    text: args.text,
    timeoutMs: typeof args.timeoutMs === 'number' ? args.timeoutMs : undefined,
  };
}

function parseBrowserSelectInput(args: unknown): BrowserSelectOptions | null {
  if (!isRecord(args) || typeof args.selector !== 'string' || typeof args.value !== 'string') {
    return null;
  }
  if (args.selector.length === 0 || args.value.length === 0) return null;

  return {
    selector: args.selector,
    value: args.value,
    timeoutMs: typeof args.timeoutMs === 'number' ? args.timeoutMs : undefined,
  };
}

function parseBrowserWaitForInput(args: unknown): BrowserWaitForOptions | null {
  if (!isRecord(args)) return null;
  const selector =
    typeof args.selector === 'string' && args.selector.length > 0 ? args.selector : undefined;
  const text = typeof args.text === 'string' && args.text.length > 0 ? args.text : undefined;
  if (selector === undefined && text === undefined) return null;

  return {
    selector,
    text,
    timeoutMs: typeof args.timeoutMs === 'number' ? args.timeoutMs : undefined,
  };
}

function commandResultToToolResult(result: {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number | null;
  readonly timedOut: boolean;
}): ToolResult {
  const content = result.stdout.length > 0 ? result.stdout : result.stderr;
  return {
    content,
    isError: result.exitCode !== 0 || result.timedOut,
    metadata: {
      exitCode: result.exitCode,
      timedOut: result.timedOut,
    },
  };
}

function invalidArgs(toolName: string): ToolResult {
  return {
    content: `invalid_args: ${toolName}`,
    isError: true,
    metadata: { policy: 'invalid-args' },
  };
}

function taskKey(task: ToolGatewayTaskIdentity): string {
  return `${task.tenant}/${task.namespace}/${task.taskUid}`;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
