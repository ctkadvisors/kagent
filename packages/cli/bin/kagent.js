#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Chris Knuteson
//
// Thin shim that delegates to the compiled CLI entry point. Kept
// out of `src/` so the eslint license-header rule + no-unsafe-shebang
// concerns don't apply — this file is the executable surface, the
// TypeScript source is the implementation.
import('../dist/cli.js').catch((err) => {
  console.error('kagent: fatal:', err);
  process.exit(1);
});
