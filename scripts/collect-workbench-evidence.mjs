#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Chris Knuteson
//
// Collect an Enterprise Pilot RC evidence pack from the Workbench API.
// The script is intentionally transport-only: it does not kubectl, it
// does not infer controller state, and it does not mutate the cluster.
// It snapshots the same read surface the Workbench UI uses.

import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const DEFAULT_BASE_URL = process.env.WORKBENCH_URL ?? 'http://127.0.0.1:18999';
const DEFAULT_USER = process.env.WORKBENCH_USER ?? 'rc-evidence';

function usage() {
  return `Usage:
  node scripts/collect-workbench-evidence.mjs [options]

Options:
  --base-url <url>       Workbench API base URL (default: WORKBENCH_URL or ${DEFAULT_BASE_URL})
  --namespace <ns>       Limit /api/tasks to one namespace
  --task <ns/name>       Capture one task detail; repeatable. If name only, --namespace is used
  --limit <n>            Detail rows to fetch when --task is omitted (default: 25)
  --out <dir>            Output directory (default: evidence/rc-<timestamp>)
  --user <name>          X-Forwarded-User value (default: WORKBENCH_USER or ${DEFAULT_USER})
  --header <k=v>         Extra request header; repeatable
  --help                 Show this help

Examples:
  node scripts/collect-workbench-evidence.mjs --base-url http://127.0.0.1:18999 --namespace kagent-system
  node scripts/collect-workbench-evidence.mjs --task kagent-system/pilot-parent --out evidence/enterprise-pilot-rc1
`;
}

function parseArgs(argv) {
  const opts = {
    baseUrl: DEFAULT_BASE_URL,
    namespace: undefined,
    tasks: [],
    limit: 25,
    outDir: undefined,
    user: DEFAULT_USER,
    headers: {},
    help: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case '--base-url':
        opts.baseUrl = requireValue(argv, ++i, arg);
        break;
      case '--namespace':
        opts.namespace = requireValue(argv, ++i, arg);
        break;
      case '--task':
        opts.tasks.push(requireValue(argv, ++i, arg));
        break;
      case '--limit': {
        const raw = requireValue(argv, ++i, arg);
        const parsed = Number.parseInt(raw, 10);
        if (!Number.isFinite(parsed) || parsed < 1) {
          throw new Error('--limit must be a positive integer');
        }
        opts.limit = parsed;
        break;
      }
      case '--out':
        opts.outDir = requireValue(argv, ++i, arg);
        break;
      case '--user':
        opts.user = requireValue(argv, ++i, arg);
        break;
      case '--header': {
        const raw = requireValue(argv, ++i, arg);
        const splitAt = raw.indexOf('=');
        if (splitAt <= 0) throw new Error('--header must be in key=value form');
        opts.headers[raw.slice(0, splitAt)] = raw.slice(splitAt + 1);
        break;
      }
      case '--help':
      case '-h':
        opts.help = true;
        break;
      default:
        throw new Error(`unknown option: ${arg}`);
    }
  }
  return opts;
}

function requireValue(argv, index, flag) {
  const value = argv[index];
  if (value === undefined || value.startsWith('--')) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

function buildHeaders(opts) {
  const headers = { accept: 'application/json', ...opts.headers };
  if (opts.user.length > 0 && headers['X-Forwarded-User'] === undefined) {
    headers['X-Forwarded-User'] = opts.user;
  }
  return headers;
}

async function fetchJson(opts, path) {
  const url = new URL(path, normalizeBaseUrl(opts.baseUrl));
  const res = await fetch(url, { headers: buildHeaders(opts) });
  const text = await res.text();
  let body = null;
  if (text.length > 0) {
    try {
      body = JSON.parse(text);
    } catch {
      body = { raw: text };
    }
  }
  if (!res.ok) {
    throw new Error(`${url.href} returned ${res.status} ${res.statusText}: ${text.slice(0, 240)}`);
  }
  return body;
}

function normalizeBaseUrl(value) {
  return value.endsWith('/') ? value : `${value}/`;
}

function defaultOutDir() {
  return join('evidence', `rc-${new Date().toISOString().replace(/[:.]/g, '-')}`);
}

function taskPath(namespace, name) {
  return `/api/tasks/${encodeURIComponent(namespace)}/${encodeURIComponent(name)}`;
}

function splitTaskSelector(raw, defaultNamespace) {
  const slash = raw.indexOf('/');
  if (slash > 0) {
    return { namespace: raw.slice(0, slash), name: raw.slice(slash + 1) };
  }
  return { namespace: defaultNamespace ?? 'default', name: raw };
}

function sanitizeFilePart(value) {
  return value.replace(/[^a-zA-Z0-9._-]+/g, '_');
}

async function writeJson(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function phaseCounts(items) {
  const out = {};
  for (const item of items) {
    const phase = typeof item.phase === 'string' ? item.phase : 'Unknown';
    out[phase] = (out[phase] ?? 0) + 1;
  }
  return out;
}

function evidenceState(detail) {
  const evidence = detail.pilotEvidence ?? {};
  const verification = evidence.verification;
  const suspicious = evidence.structuralVerdict?.suspicious ?? detail.suspicious;
  return {
    verification:
      verification === undefined ? 'not set' : verification.passed ? 'passed' : 'failed',
    structural:
      suspicious === undefined
        ? 'pending'
        : suspicious.length === 0
          ? 'clean'
          : suspicious.join(', '),
    trace:
      detail.traceLink?.url !== undefined
        ? 'linked'
        : detail.traceLink?.runId !== undefined
          ? 'run id'
          : 'not linked',
    artifacts: countLabel(evidence.artifacts?.count ?? detail.artifactCount, 'ref'),
    graph: graphLabel(detail),
    audit: auditLabel(evidence),
  };
}

function countLabel(count, noun) {
  if (typeof count !== 'number') return 'pending';
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

function graphLabel(detail) {
  const evidence = detail.pilotEvidence ?? {};
  const graph = evidence.taskGraph ?? {};
  const childCount = graph.childCount ?? detail.childCount;
  const aggregate = graph.aggregatePhase ?? detail.aggregatePhase;
  if (aggregate !== undefined) return `${aggregate} (${childCount ?? 0} children)`;
  if (typeof childCount === 'number') return `${childCount} children`;
  if (detail.parentTask !== undefined || graph.parentTask !== undefined) return 'child task';
  return 'none';
}

function auditLabel(evidence) {
  const audit = evidence.audit;
  if (audit === undefined) return 'missing';
  const labels = Object.keys(audit.labels ?? {}).length;
  const annotations = Object.keys(audit.annotations ?? {}).length;
  const tenant = typeof audit.tenant === 'string' ? `tenant=${audit.tenant}, ` : '';
  return `${tenant}${labels} labels, ${annotations} annotations`;
}

function renderSummary({ generatedAt, baseUrl, tasks, details }) {
  const rows = details.map((detail) => {
    const state = evidenceState(detail);
    return [
      `${detail.namespace}/${detail.name}`,
      detail.phase ?? 'Unknown',
      state.verification,
      state.structural,
      state.trace,
      state.artifacts,
      state.graph,
      state.audit,
    ];
  });

  return `# kagent RC Evidence Summary

Generated: ${generatedAt}
Workbench: ${baseUrl}

## Task Snapshot

- Task rows: ${tasks.length}
- Detail rows: ${details.length}
- Phase counts: ${JSON.stringify(phaseCounts(tasks))}

## Detail Evidence

| Task | Phase | Verification | Structural | Trace | Artifacts | Graph | Audit |
| --- | --- | --- | --- | --- | --- | --- | --- |
${rows.map((row) => `| ${row.map(escapeCell).join(' | ')} |`).join('\n')}
`;
}

function escapeCell(value) {
  return String(value).replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    process.stdout.write(usage());
    return;
  }

  const generatedAt = new Date().toISOString();
  const outDir = resolve(opts.outDir ?? defaultOutDir());
  const detailDir = join(outDir, 'task-details');
  await mkdir(detailDir, { recursive: true });

  const healthz = await fetchJson(opts, '/healthz');
  const readyz = await fetchJson(opts, '/readyz');
  const taskListPath =
    opts.namespace === undefined
      ? '/api/tasks'
      : `/api/tasks?namespace=${encodeURIComponent(opts.namespace)}`;
  const taskList = await fetchJson(opts, taskListPath);
  const tasks = Array.isArray(taskList?.items) ? taskList.items : [];

  const selectors =
    opts.tasks.length > 0
      ? opts.tasks.map((raw) => splitTaskSelector(raw, opts.namespace))
      : tasks.slice(0, opts.limit).map((task) => ({
          namespace: typeof task.namespace === 'string' ? task.namespace : 'default',
          name: typeof task.name === 'string' ? task.name : '',
        }));

  const details = [];
  const detailFiles = [];
  for (const selector of selectors) {
    if (selector.name.length === 0) continue;
    const detail = await fetchJson(opts, taskPath(selector.namespace, selector.name));
    details.push(detail);
    const file = join(
      detailDir,
      `${sanitizeFilePart(selector.namespace)}__${sanitizeFilePart(selector.name)}.json`,
    );
    await writeJson(file, detail);
    detailFiles.push(file);
  }

  const manifest = {
    generatedAt,
    baseUrl: opts.baseUrl,
    namespace: opts.namespace ?? null,
    taskSelectors: selectors,
    taskCount: tasks.length,
    detailCount: details.length,
    files: {
      healthz: 'healthz.json',
      readyz: 'readyz.json',
      tasks: 'tasks.json',
      summary: 'summary.md',
      taskDetails: detailFiles.map((file) => file.replace(`${outDir}/`, '')),
    },
  };

  await writeJson(join(outDir, 'healthz.json'), healthz);
  await writeJson(join(outDir, 'readyz.json'), readyz);
  await writeJson(join(outDir, 'tasks.json'), taskList);
  await writeJson(join(outDir, 'manifest.json'), manifest);
  await writeFile(
    join(outDir, 'summary.md'),
    renderSummary({ generatedAt, baseUrl: opts.baseUrl, tasks, details }),
    'utf8',
  );

  console.log(`[collect-workbench-evidence] wrote ${outDir}`);
  console.log(`[collect-workbench-evidence] tasks=${tasks.length} details=${details.length}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
