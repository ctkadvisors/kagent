// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Chris Knuteson
//
// Production-image helper. Walks every workspace package.json under
// `packages/*/` and rewrites any `exports` entry that points at a `.ts`
// file under `./src/` to its compiled `./dist/` equivalent. Lets dev
// tooling (vitest, tsx, eslint) keep resolving via `./src/index.ts` —
// the canonical state at rest in git — while the runtime image, which
// runs plain `node dist/main.js`, finds compiled JS through the
// resolved workspace symlinks.
//
// Invoked from each runtime Dockerfile after `pnpm -r build` completes.
// Idempotent. Skips packages without an `exports` block. Does not touch
// `engines`, `scripts`, or any other field.
//
// Usage (from repo root):
//   node scripts/rewrite-exports-to-dist.mjs
//
// Why a rewrite step rather than dual conditional `exports` from the
// start: vitest + tsx + the existing eslint flat configs all resolve
// against the at-rest exports map. Layering custom conditions across
// every dev tool adds surface area for parity bugs (already burnt by
// Bun's TLS divergence — see CLAUDE.md). One-shot rewrite at image
// build time keeps dev simple and prod compiled.

import { readdirSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');
const packagesDir = join(repoRoot, 'packages');

/**
 * Map a `./src/...ts` export path to `./dist/...js`.
 * Returns null if the input doesn't match the source-tree shape we
 * expect (so we don't accidentally rewrite a hand-tuned exports map).
 */
function srcToDist(value) {
  if (typeof value !== 'string') return null;
  if (!value.startsWith('./src/')) return null;
  if (!value.endsWith('.ts')) return null;
  return value.replace(/^\.\/src\//, './dist/').replace(/\.ts$/, '.js');
}

function rewriteExportsValue(node) {
  if (typeof node === 'string') {
    const mapped = srcToDist(node);
    return mapped ?? node;
  }
  if (node && typeof node === 'object' && !Array.isArray(node)) {
    const out = {};
    for (const [k, v] of Object.entries(node)) {
      out[k] = rewriteExportsValue(v);
    }
    return out;
  }
  return node;
}

function processPackage(pkgJsonPath) {
  const raw = readFileSync(pkgJsonPath, 'utf8');
  const pkg = JSON.parse(raw);
  if (!pkg.exports) {
    return { path: pkgJsonPath, changed: false };
  }
  const before = JSON.stringify(pkg.exports);
  pkg.exports = rewriteExportsValue(pkg.exports);
  const after = JSON.stringify(pkg.exports);
  if (before === after) {
    return { path: pkgJsonPath, changed: false };
  }
  writeFileSync(pkgJsonPath, JSON.stringify(pkg, null, 2) + '\n');
  return { path: pkgJsonPath, changed: true };
}

const entries = readdirSync(packagesDir);
const results = [];
for (const name of entries) {
  const dir = join(packagesDir, name);
  let s;
  try {
    s = statSync(dir);
  } catch {
    continue;
  }
  if (!s.isDirectory()) continue;
  const pkgJsonPath = join(dir, 'package.json');
  try {
    statSync(pkgJsonPath);
  } catch {
    continue;
  }
  results.push(processPackage(pkgJsonPath));
}

const changed = results.filter((r) => r.changed);
console.log(
  `[rewrite-exports-to-dist] processed ${results.length} packages, ${changed.length} updated`,
);
for (const r of changed) {
  console.log(`  - ${r.path.replace(repoRoot + '/', '')}`);
}
