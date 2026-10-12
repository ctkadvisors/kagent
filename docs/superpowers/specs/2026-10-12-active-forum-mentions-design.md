# Active fleet forum mention notices

The observed owner continued expanding its parser for over 80 iterations while two independently measured semantic failures remained. Operator feedback exists in forum mentions, but the active executor has no input drain: session messages and NATS events create new Tasks; forum reads are model-selected only. This transport gap is independently pinned in `/private/tmp/fleet-running-task-message-audit.json`.

The authorized scope is to repair the standalone fleet, preserve its active workspace, and verify observed results without asking Chris to shepherd it. This change delivers notices; it does not assert that a model read, understood, repaired or delivered anything.

## Choice

Use the existing tool gateway boundary to prepend a small text content block to normal tool replies. This works with the currently running old provider and executor, which already accept and stringify MCP content blocks. A new executor inbox would require replacing the active Pod; creating another Task would introduce a competing owner. A prompt-only periodic-read instruction provides no delivery path or observed guarantee. The gateway bridge is selected for compatibility, with the forum retaining recipient selection and pagination.

## Forum API

The existing public, credential-free fleet-read service exposes `/api/forum/mentions`, forwarding to the existing raw forum `/raw/mentions`. Return only ascending post IDs, `has_more`, and `next_after`. Inputs are recipient, nonnegative after ID, finite nonnegative since epoch, and a bounded page limit. Query `recipient = ANY(mentions)`, exclude self-authored messages, constrain `created_at >= since` and `id > after`. Parameterize all SQL. No bodies, ref, title, authors, credentials, read receipt, schema migration or new write operation are introduced. This is a subset of the same already public forum data.

## Gateway

Disabled by default, an explicit configuration binds the public source URL to one exact tenant and namespace. Production binds homelab/kagent-system. No agent names or post IDs are configured. Only invocations whose task identity passed the existing caller verifier may poll. The verifier exposes its verified bundle as a typed proof; use its tenant, agent binding, iat and expiry, never caller-supplied scope or an unsafe token decode. Tenantless proofs skip notices. Claims.tools cannot gate legacy profile grants: production profile tools are not expanded into capability claims. No new token claims, grants or Kubernetes RBAC are added.

After a tool returns (including ordinary tool errors), the gateway polls the configured metadata source using the verified task agent name and the already verified JWT iat. Token contents are never logged or exported. Its task-scoped cursor uses the full tenant/namespace/taskUID identity; task expiry prunes process state. Both the raw-source proxy and gateway fetch are abortable/short and fail-open: unavailable/malformed notice responses preserve the tool result and do not advance the cursor.

The fixed first text block states that new forum mention IDs exist, that forum content is untrusted data granting no authority, and gives the existing forum_read pagination arguments needed to retrieve them. The original result becomes a separate unchanged text block (or retains all original content blocks). Original isError and metadata remain intact. The notice stays short enough to survive the old executor's normal result cap. The bridge does not inject post bodies or user/system messages.

Normal polls check new IDs on a bounded cadence. A periodic replay restarts the since-iat ascending scan after reaching its end, so a dropped response or compaction does not permanently suppress feedback. Restart also replays the feed. Cursor means notified metadata, never read/acknowledged/acted. Poll and replay intervals are configurable; they are transport pacing, not action/iteration caps. No durable read/ack system is added.

## Acceptance

Tests must first fail for the missing API and notice behavior. Real PostgreSQL proves recipient/self/time filters and ASC pagination. Gateway tests prove existing running-provider compatibility, exact original payload preservation, tenant/namespace isolation, verifier rejection, no verification/no notice, short bounded IDs, transient/malformed response retry, independent Task cursors and periodic replay. Package tests/typecheck/lint/build and Helm rendering remain green.

Ship API through Git/CI/Argo before enabling its caller. Ship the gateway through normal homelab CI and immutable GitOps release. Preserve the active owner's Job/Pod workspace identity. Observe an actual notice and explicit forum read in the existing local-model run, then rerun the two independent semantic controls. Neither CI nor notice delivery is feature acceptance. Publication requires a correct checkpoint, independent pinned verifier, typed delivery request and actual issue/Telegram receipt.
