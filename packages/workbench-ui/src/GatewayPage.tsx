/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * Gateway page — the substrate visibility + control surface.
 *
 * Top section: one card per (model, backend) ModelEndpoint. Shows live
 * AIMD state (currentCap, inFlight) + recent latency p50, plus three
 * sliders for tuning the inflight bounds (`spec.inFlight.seed/max` and
 * `spec.minSafe`). Save → PATCHes the CR; the LLM gateway's K8s informer
 * picks up the new bounds within ~1s.
 *
 * Bottom section: recent gateway requests — the live request stream the
 * user couldn't see before. One row per usage record from the gateway's
 * Postgres. Columns: time, model, backend, status, latency, taskUid.
 *
 * Polling cadence: 2s for both panels. SSE would be cleaner but the
 * gateway's admin surface is HTTP-poll-shaped and the UI's existing
 * `/api/stream` covers cache events, not gateway state. Polling is
 * fine at 2s — both endpoints are O(1) over in-memory state on the
 * gateway side.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  fetchGatewayCapacity,
  fetchGatewayUsage,
  GatewayApiError,
  patchModelEndpointInFlight,
} from './api.js';
import styles from './GatewayPage.module.css';
import type {
  GatewayCapacityResponse,
  GatewayCapacityRow,
  GatewayUsageResponse,
  GatewayUsageRow,
  PatchInFlightRequest,
} from './types.js';

const POLL_INTERVAL_MS = 2_000;
const USAGE_LIMIT = 50;

interface PendingEdits {
  readonly seed?: number;
  readonly max?: number;
  readonly minSafe?: number;
}

function formatLatency(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return '—';
  if (ms < 1000) return `${Math.round(ms).toString()}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

function statusClass(code: number): string {
  if (code >= 200 && code < 300) return styles.status2xx ?? '';
  if (code >= 400 && code < 500) return styles.status4xx ?? '';
  if (code >= 500) return styles.status5xx ?? '';
  return styles.statusOther ?? '';
}

/**
 * Capacity card. Pulled out so each (model, backend) row owns its
 * own pending-edits + save-status state without re-rendering the rest
 * of the grid on every keystroke.
 */
function CapacityCard({
  row,
  onSave,
}: {
  row: GatewayCapacityRow;
  onSave: (model: string, body: PatchInFlightRequest) => Promise<void>;
}): React.JSX.Element {
  const [edits, setEdits] = useState<PendingEdits>({});
  const [saving, setSaving] = useState<boolean>(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saved, setSaved] = useState<boolean>(false);

  const seed = edits.seed ?? row.seed;
  const max = edits.max ?? row.max;
  const minSafe = edits.minSafe ?? row.minSafe;
  const dirty = edits.seed !== undefined || edits.max !== undefined || edits.minSafe !== undefined;

  // Reset pending edits when the upstream row changes (e.g. after the
  // operator informer reconciles a save). Without this the slider would
  // stay stuck at the user's old draft after a successful save.
  useEffect(() => {
    if (saved) {
      setEdits({});
      setSaved(false);
    }
  }, [row.seed, row.max, row.minSafe, saved]);

  const handleSave = async (): Promise<void> => {
    setSaving(true);
    setSaveError(null);
    try {
      const body: PatchInFlightRequest = {
        ...(edits.seed !== undefined && { seed: edits.seed }),
        ...(edits.max !== undefined && { max: edits.max }),
        ...(edits.minSafe !== undefined && { minSafe: edits.minSafe }),
      };
      await onSave(row.model, body);
      setSaved(true);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  // Visual cap fill: how full is in-flight relative to currentCap?
  const fillPct = Math.min(100, row.currentCap > 0 ? (row.inFlight / row.currentCap) * 100 : 0);

  return (
    <div className={styles.card}>
      <div className={styles.cardHeader}>
        <div>
          <div className={styles.cardModel}>{row.model}</div>
          <div className={styles.cardEndpoint}>
            <span className={styles.cardBackend}>{row.backendKind}</span> · {row.endpoint}
          </div>
        </div>
        <div className={styles.cardLatency}>p50 {formatLatency(row.recentP50Ms)}</div>
      </div>

      <div className={styles.gauge}>
        <div className={styles.gaugeNumbers}>
          <span className={styles.gaugeInflight}>{row.inFlight}</span>
          <span className={styles.gaugeSep}>/</span>
          <span className={styles.gaugeCap}>{row.currentCap}</span>
          <span className={styles.gaugeLabel}>in-flight / current cap (AIMD)</span>
        </div>
        <div className={styles.gaugeBar}>
          <div className={styles.gaugeBarFill} style={{ width: `${String(fillPct)}%` }} />
        </div>
      </div>

      <div className={styles.controls}>
        <label className={styles.controlRow}>
          <span className={styles.controlName}>seed</span>
          <input
            type="number"
            min={1}
            max={256}
            value={seed}
            onChange={(e) =>
              setEdits((prev) => ({ ...prev, seed: Number.parseInt(e.target.value, 10) }))
            }
            className={styles.controlInput}
          />
        </label>
        <label className={styles.controlRow}>
          <span className={styles.controlName}>max</span>
          <input
            type="number"
            min={1}
            max={1024}
            value={max}
            onChange={(e) =>
              setEdits((prev) => ({ ...prev, max: Number.parseInt(e.target.value, 10) }))
            }
            className={styles.controlInput}
          />
        </label>
        <label className={styles.controlRow}>
          <span className={styles.controlName}>minSafe</span>
          <input
            type="number"
            min={0}
            max={256}
            value={minSafe}
            onChange={(e) =>
              setEdits((prev) => ({ ...prev, minSafe: Number.parseInt(e.target.value, 10) }))
            }
            className={styles.controlInput}
          />
        </label>
      </div>

      <div className={styles.actionRow}>
        <button
          type="button"
          className={styles.saveButton}
          onClick={() => {
            void handleSave();
          }}
          disabled={!dirty || saving}
        >
          {saving ? 'saving…' : 'save bounds'}
        </button>
        {saveError !== null && <span className={styles.saveError}>{saveError}</span>}
      </div>
    </div>
  );
}

/**
 * Recent requests table. Read-only; clicking a row with a `taskUid`
 * navigates to the corresponding TaskDetail page.
 */
function UsageTable({
  rows,
  loading,
  error,
}: {
  rows: readonly GatewayUsageRow[];
  loading: boolean;
  error: string | null;
}): React.JSX.Element {
  if (error !== null) {
    return <div className={styles.tableError}>could not load recent requests: {error}</div>;
  }
  if (loading && rows.length === 0) {
    return <div className={styles.tableEmpty}>loading…</div>;
  }
  if (rows.length === 0) {
    return <div className={styles.tableEmpty}>no recent requests</div>;
  }
  return (
    <table className={styles.usageTable}>
      <thead>
        <tr>
          <th>time</th>
          <th>model</th>
          <th>backend</th>
          <th className={styles.numeric}>status</th>
          <th className={styles.numeric}>latency</th>
          <th className={styles.numeric}>tokens</th>
          <th>task</th>
          <th>error</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r, i) => (
          <tr key={r.requestId !== '' ? r.requestId : `${String(r.id ?? '')}-${String(i)}`}>
            <td className={styles.mono}>
              {r.recordedAt !== undefined ? new Date(r.recordedAt).toISOString().slice(11, 19) : '—'}
            </td>
            <td className={styles.mono}>{r.model}</td>
            <td>{r.backend}</td>
            <td className={`${styles.numeric} ${statusClass(r.statusCode)}`}>{r.statusCode}</td>
            <td className={styles.numeric}>{formatLatency(r.latencyMs)}</td>
            <td className={styles.numeric}>
              {r.inputTokens > 0 || r.outputTokens > 0
                ? `${String(r.inputTokens)}→${String(r.outputTokens)}`
                : '—'}
            </td>
            <td className={styles.mono}>
              {r.taskUid !== undefined && r.taskUid !== '' ? r.taskUid.slice(0, 8) : '—'}
            </td>
            <td className={styles.errorCell} title={r.errorMessage ?? ''}>
              {r.errorMessage !== undefined && r.errorMessage !== ''
                ? r.errorMessage.slice(0, 60)
                : ''}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export interface GatewayPageProps {
  readonly onBack: () => void;
}

export function GatewayPage(props: GatewayPageProps): React.JSX.Element {
  const [capacity, setCapacity] = useState<GatewayCapacityResponse | null>(null);
  const [capacityError, setCapacityError] = useState<string | null>(null);
  const [usage, setUsage] = useState<GatewayUsageResponse | null>(null);
  const [usageError, setUsageError] = useState<string | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  // Live ref so the polling effect's setInterval callback always sees
  // the freshest "should I keep polling" decision without re-creating
  // the interval each render.
  const pollEnabledRef = useRef<boolean>(true);

  const refresh = useCallback(async (): Promise<void> => {
    const [capRes, usageRes] = await Promise.allSettled([
      fetchGatewayCapacity(),
      fetchGatewayUsage({ limit: USAGE_LIMIT }),
    ]);
    if (capRes.status === 'fulfilled') {
      setCapacity(capRes.value);
      setCapacityError(null);
    } else {
      setCapacityError(
        capRes.reason instanceof GatewayApiError
          ? `(${String(capRes.reason.status)}) ${capRes.reason.message}`
          : String(capRes.reason),
      );
    }
    if (usageRes.status === 'fulfilled') {
      setUsage(usageRes.value);
      setUsageError(null);
    } else {
      setUsageError(
        usageRes.reason instanceof GatewayApiError
          ? `(${String(usageRes.reason.status)}) ${usageRes.reason.message}`
          : String(usageRes.reason),
      );
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    void refresh();
    const id = window.setInterval(() => {
      if (pollEnabledRef.current) void refresh();
    }, POLL_INTERVAL_MS);
    return () => {
      window.clearInterval(id);
    };
  }, [refresh]);

  const handleSave = useCallback(
    async (model: string, body: PatchInFlightRequest): Promise<void> => {
      const row = capacity?.rows.find((r) => r.model === model);
      if (row === undefined) {
        throw new Error(`no capacity row for model ${model}`);
      }
      // Workbench-api joins the K8s API ModelEndpoint list into each
      // capacity row, supplying `crName` + `crNamespace`. When the join
      // failed (RBAC denied, CR missing, etc.) we surface the failure
      // instead of guessing a name.
      if (row.crName === undefined || row.crNamespace === undefined) {
        throw new Error(
          `cannot save: workbench-api could not resolve a ModelEndpoint CR for ${model}. Check workbench-api logs + RBAC.`,
        );
      }
      await patchModelEndpointInFlight(row.crNamespace, row.crName, body);
      void refresh();
    },
    [capacity, refresh],
  );

  // Render
  const rows = capacity?.rows ?? [];
  const usageRows = useMemo(() => usage?.rows ?? [], [usage]);

  return (
    <div className={styles.wrapper}>
      <header className={styles.header}>
        <div>
          <button type="button" className={styles.backButton} onClick={props.onBack}>
            ← tasks
          </button>
          <h1 className={styles.title}>Gateway</h1>
        </div>
        <div className={styles.fetchedAt}>
          {capacity !== null
            ? `updated ${new Date(capacity.fetchedAt).toLocaleTimeString()}`
            : ''}
        </div>
      </header>

      <section className={styles.section}>
        <h2 className={styles.sectionTitle}>Model endpoints</h2>
        {capacityError !== null && (
          <div className={styles.banner}>
            <strong>gateway unavailable</strong>: {capacityError}
          </div>
        )}
        {!capacityError && rows.length === 0 && !loading && (
          <div className={styles.empty}>
            No ModelEndpoints registered. Apply a `ModelEndpoint` CR to the cluster — see{' '}
            <code>docs/SUBSTRATE-V1.md</code> for the schema.
          </div>
        )}
        <div className={styles.cardGrid}>
          {rows.map((row) => (
            <CapacityCard
              key={`${row.model}@@${row.endpoint}`}
              row={row}
              onSave={handleSave}
            />
          ))}
        </div>
      </section>

      <section className={styles.section}>
        <h2 className={styles.sectionTitle}>Recent requests</h2>
        <UsageTable rows={usageRows} loading={loading} error={usageError} />
      </section>
    </div>
  );
}

