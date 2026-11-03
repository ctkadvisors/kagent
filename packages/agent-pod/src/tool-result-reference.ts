/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

import { createHash } from 'node:crypto';
import type { ToolCall } from '@kagent/agent-loop';
import { CODE_SANDBOX_MAX_BODY_BYTES } from '@kagent/dto';
import type { ArtifactRef } from './artifacts.js';
import { validateArtifactName } from './artifacts.js';
import { PvcCasBackend } from './cas-backend.js';
import type { ToolGatewayTaskIdentity } from './tool-gateway-provider.js';

/** Ephemeral CAS in the agent pod's /tmp. Never a durable status artifact. */
export interface RawResultStorageOptions {
  readonly root: string;
  readonly maxContentChars: number;
  readonly maxBytes: number;
  readonly maxTotalBytes: number;
  readonly expiresAt: number;
  readonly now?: () => number;
}
export interface ToolResultReference {
  readonly schema: 'kagent-ephemeral-tool-result/v1';
  readonly scope: 'task';
  readonly uri: string;
  readonly taskUid: string;
  readonly runId: string;
  readonly operationId: string;
  readonly sourceTool: string;
  readonly sourceArgumentsHash: string;
  readonly receivedAt: number;
  readonly expiresAt: number;
  readonly encoding: 'utf8-provider-content' | 'json-content-blocks';
  readonly artifact: ArtifactRef;
}
interface Manifest {
  readonly owner: ToolGatewayTaskIdentity;
  readonly reference: Omit<ToolResultReference, 'uri'>;
  readonly arguments: unknown;
}
export interface ImportedResultFile {
  readonly path: string;
  readonly content: string;
}
const hash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const unavailable = () => new Error('tool-result reference unavailable');
const importMetadata = (manifest: Manifest): string =>
  JSON.stringify({
    source_tool: manifest.reference.sourceTool,
    tool_arguments: manifest.arguments,
    received_at: manifest.reference.receivedAt,
    operation_id: manifest.reference.operationId,
    sha256: manifest.reference.artifact.contentHash,
    encoding: manifest.reference.encoding,
    task: manifest.owner,
  });

const wireBytes = (files: readonly ImportedResultFile[]) =>
  Buffer.byteLength(JSON.stringify({ op: 'writeFiles', arg: files }));

export class TaskToolResultStore {
  private readonly backend: PvcCasBackend;
  private readonly issued = new Map<string, Manifest>();
  private usedBytes = 0;
  private readonly now: () => number;

  constructor(
    private readonly task: ToolGatewayTaskIdentity,
    private readonly options: RawResultStorageOptions,
  ) {
    for (const bound of [
      options.maxContentChars,
      options.maxBytes,
      options.maxTotalBytes,
      options.expiresAt,
    ]) {
      if (!Number.isSafeInteger(bound) || bound <= 0)
        throw new Error('invalid tool-result storage bound');
    }
    this.task = Object.freeze({ ...task });
    this.now = options.now ?? Date.now;
    this.backend = new PvcCasBackend(options.root, { maxReadBytes: options.maxBytes });
  }

  async retain(
    call: ToolCall,
    runId: string,
    content: string | readonly unknown[],
    signal: AbortSignal,
  ): Promise<ToolResultReference> {
    this.check(signal);
    const text = typeof content === 'string' ? content : JSON.stringify(content);
    const bytes = Buffer.from(text, 'utf8');
    if (bytes.byteLength > this.options.maxBytes) throw unavailable();
    const name = 'tool-result-' + hash(runId + '\0' + call.id);
    const artifact: ArtifactRef = {
      uri: `cas://sha256:${hash(bytes)}/${name}`,
      name,
      mediaType: 'text/plain',
      sizeBytes: bytes.byteLength,
      checksum: 'sha256:' + hash(bytes),
      contentHash: hash(bytes),
      producedAt: new Date(this.now()).toISOString(),
    };
    const manifest: Manifest = {
      owner: this.task,
      reference: {
        schema: 'kagent-ephemeral-tool-result/v1',
        scope: 'task',
        taskUid: this.task.taskUid,
        runId,
        operationId: call.id,
        sourceTool: call.name,
        sourceArgumentsHash: hash(JSON.stringify(call.args ?? {})),
        receivedAt: this.now() / 1000,
        expiresAt: this.options.expiresAt / 1000,
        encoding: typeof content === 'string' ? 'utf8-provider-content' : 'json-content-blocks',
        artifact,
      },
      arguments: structuredClone(call.args ?? {}),
    };
    const metadata = importMetadata(manifest);
    const minimalImport = [
      { path: '', content: text },
      { path: '.source.json', content: metadata },
    ];
    const serialized = JSON.stringify(manifest);
    const total = bytes.byteLength + Buffer.byteLength(serialized);
    if (
      Buffer.byteLength(serialized) > this.options.maxBytes ||
      bytes.byteLength + Buffer.byteLength(metadata) > this.options.maxBytes ||
      wireBytes(minimalImport) > Math.min(this.options.maxBytes, CODE_SANDBOX_MAX_BODY_BYTES) ||
      this.usedBytes + total > this.options.maxTotalBytes
    )
      throw unavailable();
    // Reserve before I/O, including failed writes: retries cannot bypass the run's bound.
    this.usedBytes += total;
    await this.backend.write(bytes, name);
    this.check(signal);
    const stored = await this.backend.write(Buffer.from(serialized), name + '.source.json');
    this.check(signal);
    this.issued.set(stored.uri, manifest);
    return { ...manifest.reference, uri: stored.uri };
  }

  async importFiles(
    requests: unknown,
    runId: string,
    signal: AbortSignal,
  ): Promise<readonly ImportedResultFile[]> {
    this.check(signal);
    if (!Array.isArray(requests) || requests.length === 0) throw unavailable();
    const files: ImportedResultFile[] = [];
    const paths = new Set<string>();
    let size = 0;
    for (const value of requests as unknown[]) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw unavailable();
      const request = value as Record<string, unknown>;
      if (
        Object.keys(request).some((key) => key !== 'uri' && key !== 'path') ||
        typeof request.uri !== 'string' ||
        typeof request.path !== 'string'
      )
        throw unavailable();
      let path: string;
      try {
        path = validateArtifactName(request.path);
      } catch {
        throw unavailable();
      }
      const sourcePath = path + '.source.json';
      if (paths.has(path) || paths.has(sourcePath)) throw unavailable();
      paths.add(path);
      paths.add(sourcePath);
      const manifest = this.issued.get(request.uri);
      if (
        !manifest ||
        manifest.reference.runId !== runId ||
        manifest.owner.taskUid !== this.task.taskUid
      )
        throw unavailable();
      const stored = await this.backend.read(request.uri);
      this.check(signal);
      if (Buffer.from(stored).toString('utf8') !== JSON.stringify(manifest)) throw unavailable();
      const data = await this.backend.read(manifest.reference.artifact.uri);
      this.check(signal);
      if (
        data.byteLength !== manifest.reference.artifact.sizeBytes ||
        'sha256:' + hash(data) !== manifest.reference.artifact.checksum
      )
        throw unavailable();
      const metadata = importMetadata(manifest);
      size += data.byteLength + Buffer.byteLength(metadata);
      if (size > this.options.maxBytes) throw unavailable();
      files.push(
        { path, content: Buffer.from(data).toString('utf8') },
        { path: sourcePath, content: metadata },
      );
    }
    if (wireBytes(files) > Math.min(this.options.maxBytes, CODE_SANDBOX_MAX_BODY_BYTES))
      throw unavailable();
    return files;
  }

  remainingMs(): number {
    return Math.max(0, this.options.expiresAt - this.now());
  }

  private check(signal: AbortSignal): void {
    if (signal.aborted || this.now() >= this.options.expiresAt) throw unavailable();
  }
}
