/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

import { spawn } from 'node:child_process';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';

export interface CodeRunnerFile {
  readonly path: string;
  readonly content: string;
}

export interface CodeRunnerReadResult {
  readonly path: string;
  readonly content: string;
}

export interface CodeRunnerListEntry {
  readonly path: string;
  readonly kind: 'file' | 'directory';
}

export interface CommandResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly timedOut: boolean;
}

export interface ExecuteCommandInput {
  readonly command: string;
  readonly args?: readonly string[];
  readonly timeoutMs?: number;
}

export interface ExecuteCodeInput {
  readonly language: 'javascript' | 'typescript' | 'python';
  readonly code: string;
  readonly timeoutMs?: number;
}

export interface LocalCodeRunnerOptions {
  readonly workspaceDir: string;
  readonly env: Readonly<Record<string, string>>;
  readonly outputLimitBytes?: number;
}

const ALLOWED_COMMANDS = new Set([
  'awk',
  'cat',
  'diff',
  'env',
  'eslint',
  'find',
  'git',
  'grep',
  'head',
  'jest',
  'jq',
  'ls',
  'node',
  'npm',
  'npx',
  'pip',
  'pip3',
  'pnpm',
  'prettier',
  'printenv',
  'pwd',
  'pytest',
  'python',
  'python3',
  'rg',
  'sed',
  'tail',
  'tsc',
  'vitest',
  'wc',
  'yarn',
]);

const DENIED_COMMANDS = new Set([
  'docker',
  'helm',
  'kubectl',
  'mount',
  'podman',
  'scp',
  'ssh',
  'sudo',
]);

const DEFAULT_OUTPUT_LIMIT_BYTES = 1024 * 1024;

let snippetCounter = 0;

export class LocalCodeRunner {
  private readonly workspaceDir: string;
  private readonly env: Record<string, string>;
  private readonly outputLimitBytes: number;

  constructor(options: LocalCodeRunnerOptions) {
    this.workspaceDir = resolve(options.workspaceDir);
    this.env = { ...options.env };
    this.outputLimitBytes = options.outputLimitBytes ?? DEFAULT_OUTPUT_LIMIT_BYTES;
  }

  async writeFiles(files: readonly CodeRunnerFile[]): Promise<void> {
    for (const file of files) {
      const resolved = this.resolveWorkspacePath(file.path);
      await mkdir(dirname(resolved), { recursive: true });
      await writeFile(resolved, file.content, 'utf8');
    }
  }

  async readFiles(paths: readonly string[]): Promise<readonly CodeRunnerReadResult[]> {
    const results: CodeRunnerReadResult[] = [];

    for (const path of paths) {
      const resolved = this.resolveWorkspacePath(path);
      results.push({
        path,
        content: await readFile(resolved, 'utf8'),
      });
    }

    return results;
  }

  async listFiles(root = '.'): Promise<readonly CodeRunnerListEntry[]> {
    const resolvedRoot = this.resolveWorkspacePath(root);
    const entries: CodeRunnerListEntry[] = [];

    await this.collectFiles(resolvedRoot, entries);

    return entries;
  }

  async executeCommand(input: ExecuteCommandInput): Promise<CommandResult> {
    const command = this.assertCommandAllowed(input.command);
    const timeoutMs = input.timeoutMs ?? 30_000;

    return new Promise<CommandResult>((resolveResult, reject) => {
      let stdout = '';
      let stderr = '';
      let timedOut = false;

      const child = spawn(command, [...(input.args ?? [])], {
        cwd: this.workspaceDir,
        env: this.env,
        shell: false,
      });

      const timer =
        timeoutMs > 0
          ? setTimeout(() => {
              timedOut = true;
              child.kill('SIGKILL');
            }, timeoutMs)
          : null;

      child.stdout.on('data', (chunk: Buffer) => {
        stdout = this.appendBounded(stdout, chunk.toString('utf8'));
      });
      child.stderr.on('data', (chunk: Buffer) => {
        stderr = this.appendBounded(stderr, chunk.toString('utf8'));
      });
      child.on('error', reject);
      child.on('close', (exitCode, signal) => {
        if (timer !== null) clearTimeout(timer);
        resolveResult({
          stdout,
          stderr,
          exitCode: timedOut ? null : exitCode,
          signal,
          timedOut,
        });
      });
    });
  }

  async executeCode(input: ExecuteCodeInput): Promise<CommandResult> {
    snippetCounter += 1;
    const extension = this.extensionForLanguage(input.language);
    const snippetPath = join(
      '.kagent-code-runner',
      `snippet-${Date.now()}-${snippetCounter}${extension}`,
    );

    await this.writeFiles([{ path: snippetPath, content: input.code }]);

    switch (input.language) {
      case 'javascript':
        return this.executeCommand(this.buildCommandInput('node', [snippetPath], input.timeoutMs));
      case 'typescript':
        return this.executeCommand(
          this.buildCommandInput('npx', ['tsx', snippetPath], input.timeoutMs),
        );
      case 'python':
        return this.executeCommand(
          this.buildCommandInput('python3', [snippetPath], input.timeoutMs),
        );
    }
  }

  private buildCommandInput(
    command: string,
    args: readonly string[],
    timeoutMs: number | undefined,
  ): ExecuteCommandInput {
    if (timeoutMs === undefined) {
      return { command, args };
    }

    return { command, args, timeoutMs };
  }

  private resolveWorkspacePath(path: string): string {
    if (path.length === 0 || path.includes('\0')) {
      throw new Error('policy_denied: invalid workspace path');
    }
    if (isAbsolute(path)) {
      throw new Error(`policy_denied: absolute paths are not allowed: ${path}`);
    }

    const resolved = resolve(this.workspaceDir, path);
    const relativePath = relative(this.workspaceDir, resolved);
    if (
      relativePath === '..' ||
      relativePath.startsWith(`..${dirSeparator()}`) ||
      isAbsolute(relativePath)
    ) {
      throw new Error(`policy_denied: path escapes workspace: ${path}`);
    }

    return resolved;
  }

  private assertCommandAllowed(command: string): string {
    if (command.length === 0 || command.includes('\0')) {
      throw new Error('policy_denied: invalid command');
    }

    const commandName = basename(command);
    if (DENIED_COMMANDS.has(commandName) || !ALLOWED_COMMANDS.has(commandName)) {
      throw new Error(`policy_denied: command is not allowed: ${commandName}`);
    }

    return commandName;
  }

  private async collectFiles(resolvedRoot: string, entries: CodeRunnerListEntry[]): Promise<void> {
    const dirents = await readdir(resolvedRoot, { withFileTypes: true });

    for (const dirent of dirents) {
      const absolutePath = join(resolvedRoot, dirent.name);
      const path = relative(this.workspaceDir, absolutePath);
      if (dirent.isDirectory()) {
        entries.push({ path, kind: 'directory' });
        await this.collectFiles(absolutePath, entries);
      } else if (dirent.isFile()) {
        entries.push({ path, kind: 'file' });
      }
    }
  }

  private extensionForLanguage(language: ExecuteCodeInput['language']): string {
    switch (language) {
      case 'javascript':
        return '.mjs';
      case 'typescript':
        return '.ts';
      case 'python':
        return '.py';
    }
  }

  private appendBounded(current: string, next: string): string {
    const combined = current + next;
    if (Buffer.byteLength(combined, 'utf8') <= this.outputLimitBytes) {
      return combined;
    }

    return combined.slice(0, this.outputLimitBytes);
  }
}

function dirSeparator(): '/' | '\\' {
  return process.platform === 'win32' ? '\\' : '/';
}
