{{/*
SPDX-License-Identifier: MIT
Copyright (c) 2026 Chris Knuteson

Helpers for the kagent SPIRE sub-chart. Mirrors the parent chart's
naming convention so resources are co-located in the kagent namespace
under `<release>-spire-*`.
*/}}

{{/* Whether the sub-chart's identity surface is enabled at all.
The parent chart gates the sub-chart with `condition: identity.enabled`
in Chart.yaml, so reaching this helper at all means the parent flipped
identity on. We still defensively check global.identity.enabled (the
parent's `global:` block is automatically passed in) — but if the
global flag isn't explicitly set we ASSUME the parent's condition has
already gated us in. Returns the literal "true" / "false" string for
direct use in `eq` comparisons. */}}
{{- define "kagent-spire.enabled" -}}
{{- $g := .Values.global | default dict -}}
{{- $i := $g.identity | default dict -}}
{{- if hasKey $i "enabled" -}}
{{- if $i.enabled -}}true{{- else -}}false{{- end -}}
{{- else -}}
true
{{- end -}}
{{- end -}}

{{/* Trust domain — falls back to sub-chart default. */}}
{{- define "kagent-spire.trustDomain" -}}
{{- $g := .Values.global | default dict -}}
{{- $i := $g.identity | default dict -}}
{{- $i.trustDomain | default .Values.trustDomain -}}
{{- end -}}

{{/* Whether the sub-chart should render the mock-mode ConfigMap
in place of real SPIRE workloads. Used by dev clusters that want the
operator-side audit emission path lit up without bringing real SPIRE.
*/}}
{{- define "kagent-spire.mockMode" -}}
{{- $g := .Values.global | default dict -}}
{{- $i := $g.identity | default dict -}}
{{- $m := $i.mock | default dict -}}
{{- $m.enabled | default false -}}
{{- end -}}

{{/* Standard labels stamped on every resource. */}}
{{- define "kagent-spire.labels" -}}
app.kubernetes.io/name: kagent-spire
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
app.kubernetes.io/part-of: kagent
{{- end -}}

{{- define "kagent-spire.serverName" -}}
{{ .Release.Name }}-spire-server
{{- end -}}

{{- define "kagent-spire.agentName" -}}
{{ .Release.Name }}-spire-agent
{{- end -}}
