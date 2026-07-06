/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

import type {
  ToolCall,
  ToolDescriptor,
  ToolInvocationContext,
  ToolResult,
} from '@kagent/agent-loop';
import { isToolRuntimeTool, type ToolRuntimeToolName } from '@kagent/dto';

import {
  SteelBrowserAdapter,
  type BrowserClickOptions,
  type BrowserSelectOptions,
  type BrowserTypeTextOptions,
  type BrowserWaitForOptions,
  type SteelBrowserSession,
} from './browser-steel.js';
import {
  type CodeRunnerFile,
  type CodeRunnerListEntry,
  type CodeRunnerReadResult,
  type CommandResult,
  type ExecuteCodeInput,
  type ExecuteCommandInput,
  type StartedCommand,
} from './code-runner.js';
import type { ExternalToolRegistry } from './external-providers.js';
import { resolveToolProfileToolNames, type ToolProfileConfig } from './tool-profiles.js';

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

export interface ToolGatewayCodeRunner {
  readonly executeCode: (input: ExecuteCodeInput) => Promise<CommandResult>;
  readonly executeCommand: (input: ExecuteCommandInput) => Promise<CommandResult>;
  readonly startCommand: (input: ExecuteCommandInput) => Promise<StartedCommand>;
  readonly stopTask: (taskId: string) => Promise<CommandResult>;
  readonly readFiles: (paths: readonly string[]) => Promise<readonly CodeRunnerReadResult[]>;
  readonly writeFiles: (files: readonly CodeRunnerFile[]) => Promise<void>;
  readonly listFiles: (root?: string) => Promise<readonly CodeRunnerListEntry[]>;
}

export type ToolGatewayCodeRunnerFactory = (task: ToolGatewayTaskIdentity) => ToolGatewayCodeRunner;

export interface ToolGatewayShellRunner {
  readonly exec: (input: {
    readonly host: 'elitemini2' | 'jetson2';
    readonly command: string;
    readonly timeoutSeconds?: number;
  }) => Promise<{
    readonly stdout: string;
    readonly stderr: string;
    readonly exitCode: number | null;
    readonly timedOut: boolean;
  }>;
}

export interface ToolGatewayHttpHandlerOptions {
  readonly codeRunner?: ToolGatewayCodeRunner;
  readonly codeRunnerFactory?: ToolGatewayCodeRunnerFactory;
  readonly browser?: SteelBrowserAdapter;
  readonly shellRunner?: ToolGatewayShellRunner;
  readonly externalHandlers?: Readonly<Record<string, ToolGatewayExternalHandler>>;
  readonly externalRegistry?: ExternalToolRegistry;
  readonly toolProfiles?: ToolProfileConfig;
  readonly paused?: boolean;
}

export class ToolGatewayHttpHandler {
  private readonly codeRunner: ToolGatewayCodeRunner | undefined;
  private readonly codeRunnerFactory: ToolGatewayCodeRunnerFactory | undefined;
  private readonly browser: SteelBrowserAdapter | undefined;
  private readonly shellRunner: ToolGatewayShellRunner | undefined;
  private readonly externalHandlers: Readonly<Record<string, ToolGatewayExternalHandler>>;
  private readonly externalRegistry: ExternalToolRegistry | undefined;
  private readonly toolProfiles: ToolProfileConfig;
  private readonly browserSessions = new Map<string, SteelBrowserSession>();
  private paused: boolean;

  constructor(options: ToolGatewayHttpHandlerOptions = {}) {
    this.codeRunner = options.codeRunner;
    this.codeRunnerFactory = options.codeRunnerFactory;
    this.browser = options.browser;
    this.shellRunner = options.shellRunner;
    this.externalHandlers = options.externalHandlers ?? {};
    this.externalRegistry = options.externalRegistry;
    this.toolProfiles = options.toolProfiles ?? { profiles: [] };
    this.paused = options.paused ?? false;
  }

  setPaused(paused: boolean): void {
    this.paused = paused;
  }

  async handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === 'POST' && url.pathname === '/v1/tool-runtime/describe') {
      return this.handleDescribe(request);
    }

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

    try {
      const external = this.externalHandlers[invocation.call.name];
      if (external !== undefined) {
        return jsonResponse(await external({ ...invocation, request }));
      }
      if (isExternalGatewayToolName(invocation.call.name) && this.externalRegistry !== undefined) {
        return jsonResponse(
          await this.externalRegistry.executeTool(invocation, toolInvocationContext(request)),
        );
      }

      return jsonResponse(await this.invokeRuntimeTool(invocation));
    } catch (err) {
      return jsonResponse(runtimeError(err));
    }
  }

  private async handleDescribe(request: Request): Promise<Response> {
    if (this.paused) {
      return jsonResponse({ error: 'tool_runtime_paused' }, 503);
    }

    const parsed = await parseDescribeRequest(request);
    if (parsed === null) {
      return jsonResponse({ error: 'invalid_request' }, 400);
    }
    if (!requestHeadersMatchTask(request, parsed.task)) {
      return jsonResponse(
        { error: 'policy_denied: task identity mismatch between headers and request body' },
        403,
      );
    }

    const profileResolution = resolveToolProfileToolNames(
      this.toolProfiles,
      parsed.toolProfileRefs,
    );
    if (!profileResolution.ok) {
      return jsonResponse(
        { error: 'unknown_tool_profile', profileName: profileResolution.profileName },
        400,
      );
    }

    const tools = await this.describeToolsForNames(
      deDupe([...parsed.toolNames, ...profileResolution.toolNames]),
      toolInvocationContext(request),
    );
    return jsonResponse({ tools });
  }

  private async describeToolsForNames(
    toolNames: readonly string[],
    ctx: ToolInvocationContext,
  ): Promise<readonly ToolDescriptor[]> {
    const descriptors = new Map<string, ToolDescriptor>();

    for (const name of toolNames) {
      if (isToolRuntimeTool(name)) {
        descriptors.set(name, runtimeToolDescriptor(name));
      }
    }

    if (this.externalRegistry !== undefined) {
      for (const tool of await Promise.resolve(this.externalRegistry.describeTools(ctx))) {
        if (toolNames.includes(tool.name)) descriptors.set(tool.name, tool);
      }
    }

    return toolNames
      .map((name) => descriptors.get(name))
      .filter((tool): tool is ToolDescriptor => tool !== undefined);
  }

  private async invokeRuntimeTool(invocation: ToolGatewayInvocation): Promise<ToolResult> {
    switch (invocation.call.name) {
      case 'code_interpreter.start_session':
        this.codeRunnerFor(invocation.task);
        return { content: 'code_interpreter session ready', isError: false };
      case 'code_interpreter.execute_code':
        return this.executeCode(invocation.task, invocation.call.args);
      case 'code_interpreter.execute_command':
        return this.executeCommand(invocation.task, invocation.call.args);
      case 'code_interpreter.start_command':
        return this.startCommand(invocation.task, invocation.call.args);
      case 'code_interpreter.read_files':
        return this.readFiles(invocation.task, invocation.call.args);
      case 'code_interpreter.write_files':
        return this.writeFiles(invocation.task, invocation.call.args);
      case 'code_interpreter.list_files':
        return this.listFiles(invocation.task, invocation.call.args);
      case 'code_interpreter.stop_task':
        return this.stopTask(invocation.task, invocation.call.args);
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
      case 'shell.exec':
        return this.execShell(invocation.call.args);
      default:
        return {
          content: `unknown runtime tool "${invocation.call.name}"`,
          isError: true,
          metadata: { policy: 'unknown-tool' },
        };
    }
  }

  private async executeCode(task: ToolGatewayTaskIdentity, args: unknown): Promise<ToolResult> {
    const runner = this.codeRunnerFor(task);
    const input = parseExecuteCodeInput(args);
    if (input === null) return invalidArgs('code_interpreter.execute_code');

    const result = await runner.executeCode(input);
    return commandResultToToolResult(result);
  }

  private async executeCommand(task: ToolGatewayTaskIdentity, args: unknown): Promise<ToolResult> {
    const runner = this.codeRunnerFor(task);
    const input = parseExecuteCommandInput(args);
    if (input === null) return invalidArgs('code_interpreter.execute_command');

    const result = await runner.executeCommand(input);
    return commandResultToToolResult(result);
  }

  private async execShell(args: unknown): Promise<ToolResult> {
    if (this.shellRunner === undefined) {
      return { content: 'shell.exec is not configured on this gateway', isError: true };
    }
    const input = parseShellExecInput(args);
    if (input === null) return invalidArgs('shell.exec');

    const result = await this.shellRunner.exec(input);
    return commandResultToToolResult(result);
  }

  private async startCommand(task: ToolGatewayTaskIdentity, args: unknown): Promise<ToolResult> {
    const runner = this.codeRunnerFor(task);
    const input = parseExecuteCommandInput(args);
    if (input === null) return invalidArgs('code_interpreter.start_command');

    const started = await runner.startCommand(input);
    return {
      content: JSON.stringify(started),
      isError: false,
      metadata: { taskId: started.taskId },
    };
  }

  private async stopTask(task: ToolGatewayTaskIdentity, args: unknown): Promise<ToolResult> {
    if (!isRecord(args) || typeof args.taskId !== 'string' || args.taskId.length === 0) {
      return invalidArgs('code_interpreter.stop_task');
    }

    const result = await this.codeRunnerFor(task).stopTask(args.taskId);
    return commandResultToToolResult(result);
  }

  private async readFiles(task: ToolGatewayTaskIdentity, args: unknown): Promise<ToolResult> {
    const paths = isRecord(args) && Array.isArray(args.paths) ? args.paths : null;
    if (paths === null || !paths.every((path): path is string => typeof path === 'string')) {
      return invalidArgs('code_interpreter.read_files');
    }

    return {
      content: JSON.stringify(await this.codeRunnerFor(task).readFiles(paths)),
      isError: false,
    };
  }

  private async writeFiles(task: ToolGatewayTaskIdentity, args: unknown): Promise<ToolResult> {
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

    await this.codeRunnerFor(task).writeFiles(files);
    return { content: `wrote ${files.length} file(s)`, isError: false };
  }

  private async listFiles(task: ToolGatewayTaskIdentity, args: unknown): Promise<ToolResult> {
    const root = isRecord(args) && typeof args.root === 'string' ? args.root : '.';
    return {
      content: JSON.stringify(await this.codeRunnerFor(task).listFiles(root)),
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

  private codeRunnerFor(task: ToolGatewayTaskIdentity): ToolGatewayCodeRunner {
    if (this.codeRunnerFactory !== undefined) {
      return this.codeRunnerFactory(task);
    }
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

async function parseDescribeRequest(request: Request): Promise<{
  readonly task: ToolGatewayTaskIdentity;
  readonly toolNames: readonly string[];
  readonly toolProfileRefs: readonly string[];
} | null> {
  const raw = await request.json().catch(() => null);
  if (!isRecord(raw) || !isRecord(raw.task) || !Array.isArray(raw.toolNames)) return null;

  const task = parseTask(raw.task);
  if (task === null) return null;
  if (!raw.toolNames.every((name): name is string => typeof name === 'string')) return null;
  const toolProfileRefs = raw.toolProfileRefs;
  if (
    toolProfileRefs !== undefined &&
    (!Array.isArray(toolProfileRefs) ||
      !toolProfileRefs.every((name): name is string => typeof name === 'string'))
  ) {
    return null;
  }

  return {
    task,
    toolNames: raw.toolNames,
    toolProfileRefs: toolProfileRefs ?? [],
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

function parseShellExecInput(
  args: unknown,
): { host: 'elitemini2' | 'jetson2'; command: string; timeoutSeconds?: number } | null {
  if (!isRecord(args) || typeof args.command !== 'string' || args.command.length === 0) {
    return null;
  }
  if (args.host !== 'elitemini2' && args.host !== 'jetson2') return null;
  const out: { host: 'elitemini2' | 'jetson2'; command: string; timeoutSeconds?: number } = {
    host: args.host,
    command: args.command,
  };
  if (typeof args.timeoutSeconds === 'number') out.timeoutSeconds = args.timeoutSeconds;
  return out;
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

function runtimeToolDescriptor(name: ToolRuntimeToolName): ToolDescriptor {
  return {
    name,
    description: runtimeToolDescription(name),
    inputSchema: runtimeToolInputSchema(name),
    tags: runtimeToolTags(name),
  };
}

function runtimeToolDescription(name: ToolRuntimeToolName): string {
  switch (name) {
    case 'browser.start_session':
      return 'Start or fetch the task-scoped isolated browser session.';
    case 'browser.goto':
      return 'Navigate the task-scoped browser session to a URL.';
    case 'browser.click':
      return 'Click an element in the task-scoped browser session.';
    case 'browser.type':
      return 'Type text into an element in the task-scoped browser session.';
    case 'browser.select':
      return 'Select options in a dropdown in the task-scoped browser session.';
    case 'browser.wait_for':
      return 'Wait for visible text or a selector in the task-scoped browser session.';
    case 'browser.screenshot':
      return 'Capture a screenshot from the task-scoped browser session.';
    case 'browser.extract_text':
      return 'Extract visible text from the current browser page.';
    case 'browser.cdp_url':
      return 'Return the internal CDP URL for approved automation clients.';
    case 'browser.live_view_url':
      return 'Return the live viewer URL for human inspection.';
    case 'browser.recording_url':
      return 'Return the browser session recording URL when available.';
    case 'browser.terminate_session':
      return 'Release the task-scoped browser session.';
    case 'code_interpreter.start_session':
      return 'Start or fetch the task-scoped code interpreter session.';
    case 'code_interpreter.execute_code':
      return 'Execute inline Python, JavaScript, or TypeScript in the code workspace.';
    case 'code_interpreter.execute_command':
      return 'Execute an allowlisted command in the code workspace.';
    case 'code_interpreter.start_command':
      return 'Start a long-running allowlisted command in the code workspace.';
    case 'code_interpreter.read_files':
      return 'Read files under the code workspace root.';
    case 'code_interpreter.write_files':
      return 'Write files under the code workspace root.';
    case 'code_interpreter.list_files':
      return 'List files under the code workspace root.';
    case 'code_interpreter.stop_task':
      return 'Stop a long-running code interpreter command.';
    case 'code_interpreter.terminate_session':
      return 'Release the task-scoped code interpreter session.';
    case 'shell.exec':
      return 'Run a shell command over SSH on a specific homelab node (elitemini2 or jetson2 only).';
  }
}

function runtimeToolTags(name: ToolRuntimeToolName): readonly string[] {
  if (name.endsWith('.terminate_session') || name === 'code_interpreter.stop_task') {
    return ['destructive', 'idempotent'];
  }
  if (
    name === 'browser.cdp_url' ||
    name === 'browser.live_view_url' ||
    name === 'browser.recording_url' ||
    name === 'browser.extract_text' ||
    name === 'browser.screenshot' ||
    name === 'code_interpreter.read_files' ||
    name === 'code_interpreter.list_files'
  ) {
    return ['read-only'];
  }
  if (name === 'shell.exec') return ['destructive'];
  return [];
}

function runtimeToolInputSchema(name: ToolRuntimeToolName): Record<string, unknown> {
  switch (name) {
    case 'browser.goto':
      return objectSchema(
        {
          url: { type: 'string', minLength: 1 },
          timeoutMs: { type: 'number', minimum: 1 },
        },
        ['url'],
      );
    case 'browser.click':
      return objectSchema({
        selector: { type: 'string' },
        text: { type: 'string' },
        timeoutMs: { type: 'number', minimum: 1 },
      });
    case 'browser.type':
      return objectSchema(
        {
          selector: { type: 'string', minLength: 1 },
          text: { type: 'string' },
        },
        ['selector', 'text'],
      );
    case 'browser.select':
      return objectSchema(
        {
          selector: { type: 'string', minLength: 1 },
          value: { type: 'string', minLength: 1 },
        },
        ['selector', 'value'],
      );
    case 'browser.wait_for':
      return objectSchema({
        text: { type: 'string' },
        selector: { type: 'string' },
        timeoutMs: { type: 'number', minimum: 1 },
      });
    case 'browser.screenshot':
      return objectSchema({ fullPage: { type: 'boolean' } });
    case 'browser.extract_text':
      return objectSchema({ maxChars: { type: 'number', minimum: 1 } });
    case 'code_interpreter.execute_code':
      return objectSchema(
        {
          language: { type: 'string', enum: ['python', 'javascript', 'typescript'] },
          code: { type: 'string', minLength: 1 },
          timeoutMs: { type: 'number', minimum: 1 },
        },
        ['language', 'code'],
      );
    case 'code_interpreter.execute_command':
    case 'code_interpreter.start_command':
      return objectSchema(
        {
          command: { type: 'string', minLength: 1 },
          args: { type: 'array', items: { type: 'string' } },
          timeoutMs: { type: 'number', minimum: 1 },
        },
        ['command'],
      );
    case 'code_interpreter.read_files':
      return objectSchema(
        {
          paths: { type: 'array', items: { type: 'string', minLength: 1 }, minItems: 1 },
        },
        ['paths'],
      );
    case 'code_interpreter.write_files':
      return objectSchema(
        {
          files: {
            type: 'array',
            minItems: 1,
            items: objectSchema(
              {
                path: { type: 'string', minLength: 1 },
                content: { type: 'string' },
              },
              ['path', 'content'],
            ),
          },
        },
        ['files'],
      );
    case 'code_interpreter.list_files':
      return objectSchema({ root: { type: 'string' } });
    case 'code_interpreter.stop_task':
      return objectSchema({ taskId: { type: 'string', minLength: 1 } }, ['taskId']);
    case 'shell.exec':
      return objectSchema(
        {
          host: { type: 'string', enum: ['elitemini2', 'jetson2'] },
          command: { type: 'string', minLength: 1 },
          timeoutSeconds: { type: 'number', minimum: 1, maximum: 600 },
        },
        ['host', 'command'],
      );
    default:
      return objectSchema({});
  }
}

function objectSchema(
  properties: Record<string, unknown>,
  required: readonly string[] = [],
): Record<string, unknown> {
  return {
    type: 'object',
    properties,
    required,
    additionalProperties: false,
  };
}

function invalidArgs(toolName: string): ToolResult {
  return {
    content: `invalid_args: ${toolName}`,
    isError: true,
    metadata: { policy: 'invalid-args' },
  };
}

function runtimeError(err: unknown): ToolResult {
  return {
    content: err instanceof Error ? err.message : String(err),
    isError: true,
    metadata: { policy: 'runtime-error' },
  };
}

function taskKey(task: ToolGatewayTaskIdentity): string {
  return `${task.tenant}/${task.namespace}/${task.taskUid}`;
}

function isExternalGatewayToolName(name: string): boolean {
  return name.startsWith('mcp.') || name.startsWith('http.');
}

function deDupe(values: readonly string[]): readonly string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}

function toolInvocationContext(request: Request): ToolInvocationContext {
  return {
    runId: request.headers.get('x-kagent-run-id') ?? 'tool-gateway',
    abortSignal: request.signal,
  };
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
