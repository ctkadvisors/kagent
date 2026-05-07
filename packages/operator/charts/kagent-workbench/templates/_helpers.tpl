{{/*
SPDX-License-Identifier: MIT
Copyright (c) 2026 Chris Knuteson
*/}}

{{/* Chart name + version helpers — standard Helm idiom. */}}
{{- define "kagent-workbench.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "kagent-workbench.fullname" -}}
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

{{- define "kagent-workbench.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{/* Standard label set */}}
{{- define "kagent-workbench.labels" -}}
helm.sh/chart: {{ include "kagent-workbench.chart" . }}
{{ include "kagent-workbench.selectorLabels" . }}
{{- if .Chart.AppVersion }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
{{- end }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
app.kubernetes.io/component: workbench
app.kubernetes.io/part-of: kagent
{{- end -}}

{{- define "kagent-workbench.selectorLabels" -}}
app.kubernetes.io/name: {{ include "kagent-workbench.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{- define "kagent-workbench.serviceAccountName" -}}
{{- if .Values.serviceAccount.create -}}
{{- default (include "kagent-workbench.fullname" .) .Values.serviceAccount.name -}}
{{- else -}}
{{- default "default" .Values.serviceAccount.name -}}
{{- end -}}
{{- end -}}

{{/* Compose api / ui image refs — tag falls back to .Chart.AppVersion. */}}
{{- define "kagent-workbench.api.image" -}}
{{- $tag := .Values.api.image.tag | default .Chart.AppVersion -}}
{{- printf "%s:%s" .Values.api.image.repository $tag -}}
{{- end -}}

{{- define "kagent-workbench.ui.image" -}}
{{- $tag := .Values.ui.image.tag | default .Chart.AppVersion -}}
{{- printf "%s:%s" .Values.ui.image.repository $tag -}}
{{- end -}}

{{/*
Validate values at template time. Currently guards one trapdoor:

  Audit B6 — default fail-open auth on flannel K3s.

  The workbench-api trusts the upstream `X-Forwarded-User` header
  (api.authRequired='true' is the fail-CLOSED default for the
  middleware itself). The cluster-side defense for the spoofing
  vector is a NetworkPolicy that restricts ingress to the
  ingress-controller pods — but the homelab K3s ships with flannel,
  which silently ignores NetworkPolicy. On flannel + plain Ingress,
  ANY in-cluster pod can craft an HTTP request with a forged
  X-Forwarded-User and walk past the auth check.

  When `ingress.enabled=true` AND `ingress.authMiddleware` is empty
  (i.e. the chart renders a vanilla Ingress with no middleware
  authentication chained in front) AND `api.authRequired='true'`
  (the workbench is going to trust X-Forwarded-User), refuse to
  install unless the operator opts in via
  `acknowledgeUnauthenticated=true`. This converts a silent
  trapdoor into a loud, actionable failure.

  Acknowledgement path is the escape hatch: the homelab path is
  to provide a Traefik Middleware (basicAuth, forwardAuth) via
  `ingress.authMiddleware`, in which case the IngressRoute is the
  enforcement point and the trapdoor closes naturally.

  See docs/AGENT-SELF-SERVICE.md §3.5 (auth-design intent: header-
  trust gate, deferred per-user ACLs) and rev2 audit C3.
*/}}
{{- define "kagent-workbench.validateValues" -}}
{{- if and .Values.ingress.enabled (not .Values.ingress.authMiddleware) (eq (.Values.api.authRequired | toString) "true") (not .Values.acknowledgeUnauthenticated) -}}
{{- fail "kagent-workbench: ingress.enabled=true with ingress.authMiddleware empty AND api.authRequired='true' is a default fail-OPEN posture on CNIs that don't enforce NetworkPolicy (e.g. K3s default flannel) — anyone in-cluster can spoof X-Forwarded-User. Either (a) set ingress.authMiddleware to a Traefik Middleware that authenticates the request (recommended; see docs/AGENT-SELF-SERVICE.md §3.5), or (b) deploy a CNI that enforces NetworkPolicy (Calico/Cilium/Weave) AND set acknowledgeUnauthenticated=true to confirm you understand the cluster-level enforcement is what stops X-Forwarded-User spoofing. See evidence/audit-rev2/C3.md (B6) for the full rationale." -}}
{{- end -}}
{{- end -}}
