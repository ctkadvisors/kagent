/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { expect, it } from 'vitest';

it('credentialed gateway imports work when fleet-owned runtime modules throw on evaluation', () => {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
  const scratch = mkdtempSync(join(tmpdir(), 'kagent-kernel-import-'));
  const copies = ['agent-loop', 'http-tool-provider', 'mcp-tool-provider', 'tool-gateway'];
  try {
    writeFileSync(join(scratch, 'package.json'), JSON.stringify({ type: 'module' }));
    const modules = join(scratch, 'node_modules');
    mkdirSync(join(modules, '@kagent'), { recursive: true });
    for (const entry of readdirSync(join(root, 'packages/tool-gateway/node_modules'))) {
      if (entry === '@kagent' || entry === '.bin') continue;
      symlinkSync(join(root, 'packages/tool-gateway/node_modules', entry), join(modules, entry));
    }
    for (const name of readdirSync(join(root, 'packages/tool-gateway/node_modules/@kagent'))) {
      if (copies.includes(name)) continue;
      symlinkSync(join(root, 'packages', name), join(modules, '@kagent', name));
    }
    for (const name of copies) {
      const target = join(scratch, 'packages', name);
      mkdirSync(target, { recursive: true });
      cpSync(join(root, 'packages', name, 'package.json'), join(target, 'package.json'));
      cpSync(join(root, 'packages', name, 'src'), join(target, 'src'), { recursive: true });
      symlinkSync(target, join(modules, '@kagent', name));
    }
    const protectedKernel = new Set([
      'kernel.ts',
      'registry.ts',
      'tool-provider.ts',
      'errors.ts',
      'llm-client.ts',
      'types.ts',
    ]);
    const runtimeSource = join(scratch, 'packages/agent-loop/src');
    for (const name of readdirSync(runtimeSource, { recursive: true, encoding: 'utf8' })) {
      if (!name.endsWith('.ts') || name.endsWith('.test.ts') || protectedKernel.has(name)) continue;
      const path = join(runtimeSource, name);
      writeFileSync(
        path,
        `throw new Error('fleet-runtime-evaluated:${name}');\n${readFileSync(path, 'utf8')}`,
      );
    }
    const script = join(scratch, 'verify.ts');
    writeFileSync(
      script,
      `
      import { buildExternalToolRegistry } from './packages/tool-gateway/src/external-providers.ts';
      import './packages/tool-gateway/src/http-server.ts';
      const registry = buildExternalToolRegistry({ providers: [] });
      const tools = await registry.describeTools({ runId: 'boundary', abortSignal: new AbortController().signal });
      if (tools.length !== 0) throw new Error('unexpected tools');
      console.log('gateway-kernel-only');
    `,
    );
    const loader = pathToFileURL(
      join(root, 'packages/tool-gateway/node_modules/tsx/dist/loader.mjs'),
    ).href;
    const result = spawnSync(process.execPath, ['--import', loader, script], {
      cwd: scratch,
      encoding: 'utf8',
      timeout: 20_000,
    });
    expect(result.stderr).not.toContain('fleet-runtime-evaluated:');
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe('gateway-kernel-only');
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});
