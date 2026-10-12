/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

import { createHash } from 'node:crypto';
import { signedIdentityHeaders } from '@kagent/http-tool-provider';
import type { ToolResult } from '@kagent/agent-loop/kernel';
import type { FleetRunToolOptions } from './fleet-run-tool.js';
import type { ToolGatewayExternalHandler } from './http-server.js';

export const FLEET_COMMIT_FILES_NAME = 'fleet.playground_commit_files';
const FOLDER = /^\d{4}-\d{2}-\d{2}-[a-z0-9][a-z0-9-]{1,48}$/;
// The existing playground service's commit bounds. Recheck before sending bytes.
const MAX_FILES = 60;
const MAX_BYTES = 512 * 1024;
const REPO_PATH = /^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/;

export const FLEET_COMMIT_FILES_DESCRIPTOR = {
  name: FLEET_COMMIT_FILES_NAME,
  description:
    'Commit exact UTF-8 files from this task code workspace into one fleet-playground folder. Args: folder (YYYY-MM-DD-name), message, files mapping repository-relative destination paths to workspace-relative source paths. 1..60 files, total 512 KiB. No model transcription. Returns the server SHA/URL and SHA-256 for each file. Same signed playground commit authority; no product repository write.',
  inputSchema: {
    type: 'object',
    required: ['folder', 'message', 'files'],
    additionalProperties: false,
    properties: {
      folder: { type: 'string' },
      message: { type: 'string' },
      files: {
        type: 'object',
        minProperties: 1,
        maxProperties: MAX_FILES,
        additionalProperties: { type: 'string' },
      },
    },
  },
};

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function relativePath(value: string): boolean {
  return (
    value.length > 0 &&
    !value.startsWith('/') &&
    !value.includes('\\') &&
    !value.includes('\0') &&
    !value.split('/').some((part) => part === '.' || part === '..' || part === '')
  );
}

function error(content: string): ToolResult {
  return { content, isError: true };
}

export function defineFleetPlaygroundCommitFiles(
  options: FleetRunToolOptions,
): ToolGatewayExternalHandler {
  const fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
  const url = options.playgroundUrl.replace(/\/+$/, '') + '/commit';
  return async ({ task, call, request }): Promise<ToolResult> => {
    const args = call.args;
    if (
      !record(args) ||
      typeof args.folder !== 'string' ||
      !FOLDER.test(args.folder) ||
      typeof args.message !== 'string' ||
      !args.message.trim() ||
      !record(args.files) ||
      Object.keys(args.files).length < 1 ||
      Object.keys(args.files).length > MAX_FILES
    ) {
      return error(
        'invalid_args: fleet.playground_commit_files requires folder, message and 1..60 file paths',
      );
    }
    const mapping = Object.entries(args.files);
    if (
      !mapping.every(
        ([destination, source]) =>
          REPO_PATH.test(destination) &&
          relativePath(destination) &&
          typeof source === 'string' &&
          relativePath(source),
      )
    ) {
      return error(
        'invalid_args: file paths must stay relative to the playground folder and task workspace',
      );
    }
    const sources = [...new Set(mapping.map(([, source]) => source as string))];
    const reads = await options.codeRunnerFor(task).readFiles(sources);
    const contents = new Map(reads.map((item) => [item.path, item.content]));
    if (
      reads.length !== sources.length ||
      contents.size !== sources.length ||
      !sources.every((path) => typeof contents.get(path) === 'string')
    ) {
      return error(
        'workspace_read_incomplete: missing, mismatched or duplicate file paths; nothing committed',
      );
    }
    const files = Object.fromEntries(
      mapping.map(([destination, source]) => [destination, contents.get(source as string)!]),
    );
    if (
      Object.values(files).reduce(
        (total, content) => total + Buffer.byteLength(content, 'utf8'),
        0,
      ) > MAX_BYTES
    ) {
      return error('files_exceed_limit: total UTF-8 file size exceeds 512 KiB; nothing committed');
    }
    const body = JSON.stringify({ folder: args.folder, message: args.message, files });
    const response = await fetchImpl(url, {
      method: 'POST',
      body,
      signal: request.signal,
      headers: {
        'Content-Type': 'application/json',
        ...signedIdentityHeaders(options.signingKey, task, body),
      },
    });
    if (!response.ok)
      return error(
        `playground commit refused: HTTP ${response.status} ${(await response.text()).slice(0, 300)}`,
      );
    const receipt: unknown = await response.json();
    if (!record(receipt) || typeof receipt.sha !== 'string' || typeof receipt.url !== 'string') {
      return error('playground commit returned no SHA/URL receipt');
    }
    const fileDigests = Object.fromEntries(
      Object.entries(files).map(([path, content]) => [
        path,
        createHash('sha256').update(content, 'utf8').digest('hex'),
      ]),
    );
    return { content: JSON.stringify({ ...receipt, fileDigests }), isError: false };
  };
}
