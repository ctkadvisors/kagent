{{/*
SPDX-License-Identifier: MIT
Copyright (c) 2026 Chris Knuteson
*/}}

{{/* Chart name + version helpers — standard Helm idiom. */}}
{{- define "llm-gateway.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "llm-gateway.fullname" -}}
{{- if .Values.fullnameOverride -}}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- $name := default .Chart.Name .Values.nameOverride -}}
{{- if contains $name .Release.Name -}}
{{- .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}
{{- end -}}

{{- define "llm-gateway.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{/* Standard label set */}}
{{- define "llm-gateway.labels" -}}
helm.sh/chart: {{ include "llm-gateway.chart" . }}
{{ include "llm-gateway.selectorLabels" . }}
{{- if .Chart.AppVersion }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
{{- end }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
app.kubernetes.io/part-of: kagent
{{- end -}}

{{- define "llm-gateway.selectorLabels" -}}
app.kubernetes.io/name: {{ include "llm-gateway.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{- define "llm-gateway.serviceAccountName" -}}
{{- if .Values.rbac.create -}}
{{- default (include "llm-gateway.fullname" .) .Values.rbac.serviceAccountName -}}
{{- else -}}
{{- default "default" .Values.rbac.serviceAccountName -}}
{{- end -}}
{{- end -}}

{{- define "llm-gateway.image" -}}
{{- $tag := .Values.image.tag | default .Chart.AppVersion -}}
{{- printf "%s:%s" .Values.image.repository $tag -}}
{{- end -}}

{{/*
Migrations image. Inherits the gateway image when `migrations.image` is empty
(the migration runner is bundled into the same gateway image and invoked by
`migrations.command`). Allows override only on the rare case migrations live
in a separate image.
*/}}
{{- define "llm-gateway.migrations.image" -}}
{{- $repo := default .Values.image.repository (default "" .Values.migrations.image.repository) -}}
{{- $tag := default (default .Chart.AppVersion .Values.image.tag) (default "" .Values.migrations.image.tag) -}}
{{- printf "%s:%s" $repo $tag -}}
{{- end -}}

{{/*
Bundled-postgres primary Service hostname. The Bitnami postgresql chart
names its primary Service `<release>-<chart-or-alias>` when installed as
a sub-chart — with alias `bundled-postgres` that resolves to
`<release>-bundled-postgres.<namespace>.svc.cluster.local`. We mirror
that naming so the auto-generated DSN Secret resolves cleanly without
requiring the deployer to override `bundled-postgres.fullnameOverride`.
*/}}
{{- define "llm-gateway.bundledPostgres.host" -}}
{{- printf "%s-bundled-postgres.%s.svc.cluster.local" .Release.Name .Release.Namespace -}}
{{- end -}}

{{/*
Audit B7 — bundled mode uses split-credential Secret keys
(host/port/user/password/database). External-DB (BYO) mode keeps the
legacy DSN-secret-ref path so deployers don't need to migrate.

`llm-gateway.bundledSecretName` returns the Secret name in bundled
mode (synthesized as `<fullname>-db`); the deployment + migration-job
templates read each split key via individual `secretKeyRef` entries.
*/}}
{{- define "llm-gateway.bundledSecretName" -}}
{{- printf "%s-db" (include "llm-gateway.fullname" .) -}}
{{- end -}}

{{/*
SSL mode for the bundled-Postgres path. Default is `verify-ca`
(Bitnami auto-generates a self-signed cert; SANs may not match
the Service hostname so verify-full is too strict by default).
README documents the path to verify-full. `disable` is rejected
explicitly per audit B7 — bundled-Postgres MUST encrypt in transit
since the password rides over the same connection.
*/}}
{{- define "llm-gateway.bundledSslMode" -}}
{{- $mode := default "verify-ca" .Values.database.bundledConfig.sslMode -}}
{{- if eq $mode "disable" -}}
{{- fail "llm-gateway: database.bundledConfig.sslMode=disable is forbidden (audit B7) — Postgres connection MUST encrypt in transit. Use require, verify-ca (default), or verify-full." -}}
{{- end -}}
{{- $mode -}}
{{- end -}}

{{/*
Validate values at template time. Two required gates, mirrored on
all rendered manifests via {{ include "llm-gateway.validateValues" . }}.
Helm's `fail` halts rendering with a clear message — much better UX
than a downstream "secret not found" surfaced only at runtime.

Gated on `.Values.enabled` so the disabled path stays a no-op (the
operator chart can vendor this sub-chart with `enabled: false` and
not be forced to satisfy the dsnSecretRef contract until a deployer
opts in to the gateway).
*/}}
{{- define "llm-gateway.validateValues" -}}
{{- if .Values.enabled -}}
{{- if and (not .Values.database.bundled) (not .Values.database.dsnSecretRef.name) -}}
{{- fail "llm-gateway: database.dsnSecretRef.name is required when database.bundled is false (set dsnSecretRef to point at an existing Secret holding the libpq DSN, OR set database.bundled=true to use the in-cluster Postgres sub-chart)" -}}
{{- end -}}
{{- end -}}
{{- end -}}
