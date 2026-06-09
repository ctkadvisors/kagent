/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

import {
  filterToolSessionEnv,
  isForbiddenToolSessionEnvKey,
  type ToolSessionEnvContext,
} from '@kagent/dto';

export interface BuildSandboxEnvOptions {
  readonly ambientEnv: Readonly<Record<string, string | undefined>>;
  readonly context: ToolSessionEnvContext;
}

export function buildSandboxEnv(options: BuildSandboxEnvOptions): Record<string, string> {
  return filterToolSessionEnv(options.ambientEnv, options.context);
}

export function findForbiddenEnvKeys(
  env: Readonly<Record<string, string | undefined>>,
): readonly string[] {
  return Object.keys(env).filter((key) => isForbiddenToolSessionEnvKey(key));
}
