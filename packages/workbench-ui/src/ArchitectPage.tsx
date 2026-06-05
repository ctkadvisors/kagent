/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * `#/architect` — kagent Studio "chat to create" (Phase 1).
 *
 * Describe an agent in natural language → the Architect (gateway-backed)
 * returns a validated AgentTemplate candidate → "Try it" instantiates it
 * into the kagent-draft namespace, where it traces in Langfuse.
 *
 * Inline styles only (no CSS module) to keep this Phase-1 page a leaf;
 * it can adopt the shared styles module when the operate surface lands.
 * All dynamic text renders via JSX text nodes — React's auto-escaping is
 * the XSS defense, consistent with ReviewPage.
 */
import { useState } from 'react';

import { architectDraft, architectTry, type ArchitectDraftResult } from './api.js';

export interface ArchitectPageProps {
  readonly onBack: () => void;
}

export function ArchitectPage({ onBack }: ArchitectPageProps): React.JSX.Element {
  const [goal, setGoal] = useState('');
  const [draft, setDraft] = useState<ArchitectDraftResult | null>(null);
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);

  const onDraft = (): void => {
    setBusy(true);
    setStatus('Architecting…');
    setDraft(null);
    architectDraft(goal)
      .then((r) => {
        setDraft(r);
        setStatus('');
      })
      .catch((e: unknown) => {
        setStatus(`Draft failed: ${e instanceof Error ? e.message : String(e)}`);
      })
      .finally(() => {
        setBusy(false);
      });
  };

  const onTry = (): void => {
    if (draft === null) return;
    setBusy(true);
    setStatus('Instantiating in kagent-draft…');
    architectTry(draft.candidateYaml)
      .then((r) => {
        const lf = r._links?.langfuse;
        setStatus(`Created ${r.namespace}/${r.name}.${lf !== undefined ? ` Watch it in Langfuse: ${lf}` : ''}`);
      })
      .catch((e: unknown) => {
        setStatus(`Try failed: ${e instanceof Error ? e.message : String(e)}`);
      })
      .finally(() => {
        setBusy(false);
      });
  };

  return (
    <div style={{ padding: '1.5rem', maxWidth: 880, margin: '0 auto' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h1>Architect — chat to create</h1>
        <button type="button" onClick={onBack}>
          ← Back
        </button>
      </div>
      <p>Describe the agent you want. The Architect drafts a validated AgentTemplate you can try live in the draft namespace.</p>

      <textarea
        value={goal}
        onChange={(e) => {
          setGoal(e.target.value);
        }}
        placeholder="e.g. a summarizer agent that condenses long docs into 5 bullet points"
        rows={3}
        style={{ width: '100%', fontFamily: 'inherit', padding: '0.5rem' }}
      />

      <div style={{ marginTop: '0.5rem' }}>
        <button type="button" disabled={busy || goal.trim() === ''} onClick={onDraft}>
          Draft
        </button>
      </div>

      {draft !== null && (
        <div style={{ marginTop: '1rem' }}>
          <h2>Candidate</h2>
          <pre
            style={{
              background: '#1113',
              padding: '1rem',
              overflowX: 'auto',
              borderRadius: 6,
              whiteSpace: 'pre-wrap',
            }}
          >
            {draft.candidateYaml}
          </pre>
          <button type="button" disabled={busy} onClick={onTry}>
            Try it in kagent-draft
          </button>
        </div>
      )}

      {status !== '' && <p style={{ marginTop: '1rem' }}>{status}</p>}
    </div>
  );
}
