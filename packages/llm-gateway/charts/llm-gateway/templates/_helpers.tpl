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
Bundled-postgres Service hostname. The Bitnami postgresql chart exposes its
primary Service as `<release>-bundled-postgres-postgresql.<namespace>.svc...`
when installed as a sub-chart with alias `bundled-postgres`. We mirror that
naming so the auto-generated DSN Secret resolves cleanly.
*/}}
{{- define "llm-gateway.bundledPostgres.host" -}}
{{- printf "%s-bundled-postgres-postgresql.%s.svc.cluster.local" .Release.Name .Release.Namespace -}}
{{- end -}}

{{/*
Name of the Secret holding the gateway's DSN. When `database.bundled=true`,
the chart auto-creates this Secret via `secret-bundled.yaml`. When
`database.bundled=false`, the deployer provides this Secret out-of-band and
points `database.dsnSecretRef.name` at it.
*/}}
{{- define "llm-gateway.dsnSecretName" -}}
{{- if .Values.database.bundled -}}
{{- printf "%s-db" (include "llm-gateway.fullname" .) -}}
{{- else -}}
{{- .Values.database.dsnSecretRef.name -}}
{{- end -}}
{{- end -}}

{{/*
Name of the Secret key holding the DSN. The bundled Secret uses key `dsn`;
external Secrets honour whatever the deployer set in `dsnSecretRef.key`.
*/}}
{{- define "llm-gateway.dsnSecretKey" -}}
{{- if .Values.database.bundled -}}
dsn
{{- else -}}
{{- .Values.database.dsnSecretRef.key -}}
{{- end -}}
{{- end -}}

{{/*
Validate values at template time. Two required gates, mirrored on
all rendered manifests via {{ include "llm-gateway.validateValues" . }}.
Helm's `fail` halts rendering with a clear message — much better UX
than a downstream "secret not found" surfaced only at runtime.
*/}}
{{- define "llm-gateway.validateValues" -}}
{{- if and (not .Values.database.bundled) (not .Values.database.dsnSecretRef.name) -}}
{{- fail "llm-gateway: database.dsnSecretRef.name is required when database.bundled is false (set dsnSecretRef to point at an existing Secret holding the libpq DSN, OR set database.bundled=true to use the in-cluster Postgres sub-chart)" -}}
{{- end -}}
{{- end -}}
