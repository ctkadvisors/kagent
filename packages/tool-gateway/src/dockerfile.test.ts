/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

describe('tool-gateway runtime image', () => {
  it('installs the OpenSSH client required by shell.exec', () => {
    const dockerfile = readFileSync(new URL('../Dockerfile', import.meta.url), 'utf8');
    const runtimeStage = dockerfile.split('FROM node:22-alpine AS runtime')[1] ?? '';

    expect(runtimeStage).toContain('openssh-client');
  });
});
