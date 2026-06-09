{{/*
SPDX-License-Identifier: MIT
Copyright (c) 2026 Chris Knuteson
*/}}

{{/* Chart name + version helpers — standard Helm idiom. */}}
{{- define "kagent-operator.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "kagent-operator.fullname" -}}
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

{{- define "kagent-operator.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{/* Standard label set */}}
{{- define "kagent-operator.labels" -}}
helm.sh/chart: {{ include "kagent-operator.chart" . }}
{{ include "kagent-operator.selectorLabels" . }}
{{- if .Chart.AppVersion }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
{{- end }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end -}}

{{- define "kagent-operator.selectorLabels" -}}
app.kubernetes.io/name: {{ include "kagent-operator.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{- define "kagent-operator.serviceAccountName" -}}
{{- if .Values.serviceAccount.create -}}
{{- default (include "kagent-operator.fullname" .) .Values.serviceAccount.name -}}
{{- else -}}
{{- default "default" .Values.serviceAccount.name -}}
{{- end -}}
{{- end -}}

{{- define "kagent-operator.image" -}}
{{- $tag := .Values.image.tag | default .Chart.AppVersion -}}
{{- printf "%s:%s" .Values.image.repository $tag -}}
{{- end -}}

{{- define "kagent-operator.agentPod.image" -}}
{{- $tag := .Values.agentPod.image.tag | default .Chart.AppVersion -}}
{{- printf "%s:%s" .Values.agentPod.image.repository $tag -}}
{{- end -}}

{{- define "kagent-operator.toolGateway.image" -}}
{{- $tag := .Values.toolRuntime.gateway.image.tag | default .Chart.AppVersion -}}
{{- printf "%s:%s" .Values.toolRuntime.gateway.image.repository $tag -}}
{{- end -}}

{{- define "kagent-operator.steelBrowser.image" -}}
{{- printf "%s:%s" .Values.toolRuntime.browser.steel.image.repository .Values.toolRuntime.browser.steel.image.tag -}}
{{- end -}}

{{- define "kagent-operator.codeRunner.image" -}}
{{- $tag := .Values.toolRuntime.code.agentSandbox.image.tag | default .Chart.AppVersion -}}
{{- printf "%s:%s" .Values.toolRuntime.code.agentSandbox.image.repository $tag -}}
{{- end -}}

{{/*
Validate values at template time. Currently guards two trapdoors:

  Audit rev2 NH3 — context-window threshold misconfiguration.

  `agentPod.contextSafetyThreshold` and `agentPod.contextPressureThreshold`
  are forwarded verbatim onto every spawned agent-pod's env as
  `KAGENT_CONTEXT_SAFETY_THRESHOLD` / `KAGENT_CONTEXT_PRESSURE_THRESHOLD`.
  The runner's parseContextSafetyThreshold / parseContextPressureThreshold
  silently fall through to defaults (0.95 / 0.7) if the chart value is
  out of range — so an operator who sets `0` to "disable" the safety-net
  gets the opposite of what they expect (safety-net still fires at 95%).

  Catch the misconfig at chart-render time before the env is ever stamped
  onto a pod. Per docs/CONTEXT-AWARENESS.md §4.1 + §7:

    * contextSafetyThreshold MUST be in (0, 1].
        - >0  : 0 disables nothing; the runner re-defaults silently.
        - <=1 : >1 means "fire above 100%" which is unreachable, but
                also re-defaults silently in the runner.
    * contextPressureThreshold MUST be in (0, 1).
        - The detector trips at this fraction; 1.0 means "never fire"
          which is a foot-gun shaped exactly like NH3's silent-disable.

  Both thresholds are no-ops when the resolved class entry doesn't
  declare contextWindowTokens (preserves v0.1.8 behavior); but the
  range check still runs so an upgrade to a class with contextWindowTokens
  doesn't suddenly surface a previously-silent misconfig as a runtime
  default-fallback.

  See evidence/audit-rev2/C1.md §3 NH1 (= NH3 here) for the full rationale.
*/}}
{{- define "kagent-operator.validateValues" -}}
{{- $safety := .Values.agentPod.contextSafetyThreshold -}}
{{- if or (kindIs "invalid" $safety) (not (or (kindIs "float64" $safety) (kindIs "int" $safety) (kindIs "int64" $safety))) -}}
{{- fail (printf "kagent-operator: agentPod.contextSafetyThreshold must be a number in (0, 1] (got %v of type %s) — see docs/CONTEXT-AWARENESS.md §4.1 and evidence/audit-rev2/C1.md NH1" $safety (kindOf $safety)) -}}
{{- end -}}
{{- $safetyF := $safety | float64 -}}
{{- if or (le $safetyF 0.0) (gt $safetyF 1.0) -}}
{{- fail (printf "kagent-operator: agentPod.contextSafetyThreshold must be in (0, 1] (got %v) — values <=0 or >1 silently re-default to 0.95 in the agent-pod runner, masking the misconfig. See docs/CONTEXT-AWARENESS.md §4.1 and evidence/audit-rev2/C1.md NH1" $safety) -}}
{{- end -}}
{{- $pressure := .Values.agentPod.contextPressureThreshold -}}
{{- if or (kindIs "invalid" $pressure) (not (or (kindIs "float64" $pressure) (kindIs "int" $pressure) (kindIs "int64" $pressure))) -}}
{{- fail (printf "kagent-operator: agentPod.contextPressureThreshold must be a number in (0, 1) (got %v of type %s) — see docs/CONTEXT-AWARENESS.md §4.1 and evidence/audit-rev2/C1.md NH1" $pressure (kindOf $pressure)) -}}
{{- end -}}
{{- $pressureF := $pressure | float64 -}}
{{- if or (le $pressureF 0.0) (ge $pressureF 1.0) -}}
{{- fail (printf "kagent-operator: agentPod.contextPressureThreshold must be in (0, 1) (got %v) — values <=0 or >=1 silently re-default to 0.7 in the agent-pod runner, masking the misconfig. See docs/CONTEXT-AWARENESS.md §4.1 and evidence/audit-rev2/C1.md NH1" $pressure) -}}
{{- end -}}
{{/*
  Audit-rev2 M12 follow-up — blackboard fail-open requires explicit
  acknowledgement.

  `agentPod.blackboard.failOpen=true` flips every spawned agent-pod's
  blackboard cap-claim default to {read: ['*'], write: ['*']} —
  cluster-wide unrestricted read+write. This is intentional for
  bootstrap / dev clusters but a foot-gun shaped exactly like the
  capability-mount silent-disable that NH3 closed: an operator who
  flips it without realizing the consequence has no way to know
  before the pod boots.

  Refuse to render when failOpen=true without acknowledgeUnsafe=true.
  The pod-side WARN in agent-pod/src/main.ts:539-549 is defense-in-
  depth (catches non-chart-mediated env injection); this gate catches
  the chart-mediated path before the env is ever stamped. See
  packages/operator/charts/kagent-operator/values.yaml agentPod.blackboard
  for the user-facing prose.
*/}}
{{- $bb := .Values.agentPod.blackboard -}}
{{- if $bb -}}
{{- if and (eq (default false $bb.failOpen) true) (ne (default false $bb.acknowledgeUnsafe) true) -}}
{{- fail "kagent-operator: agentPod.blackboard.failOpen=true requires agentPod.blackboard.acknowledgeUnsafe=true. The fail-open posture grants every spawned agent-pod cluster-wide blackboard read+write (claims.blackboard = {read: ['*'], write: ['*']}). Refusing to render — set acknowledgeUnsafe=true ONLY as a deliberate, time-boxed escape hatch (e.g. bootstrap / dev clusters with no cap-issuer wired). See packages/operator/charts/kagent-operator/values.yaml agentPod.blackboard and evidence/audit-rev2/W3-Pod-REPORT.md §5 'M12 follow-up'." -}}
{{- end -}}
{{- end -}}
{{/*
  Audit-rev3 C1-CONFIG — supervision.maxEscalationDepth chart-level guard.

  `supervision.maxEscalationDepth` is forwarded onto the operator deployment
  as `KAGENT_SUPERVISION_MAX_ESCALATION_DEPTH`. The operator's
  `resolveMaxEscalationDepth` rejects negative / zero / non-integer values
  with a warn-log AND falls back to the substrate default (8). The fallback
  is a foot-gun shaped exactly like NH3's silent-disable: an operator who
  sets `0` to "disable" the cap (or `-1` to mean "no limit") gets the
  opposite of what they expect (cap silently re-defaults to 8).

  Catch the misconfig at chart-render time before the env is stamped onto
  the operator. Per supervision-router.ts:resolveMaxEscalationDepth:

    * maxEscalationDepth MUST be a positive integer.
        - <=0 silently re-defaults to 8 in the operator (masks the misconfig).
        - non-integer / NaN re-defaults to 8 in the operator.
        - "no limit" is NOT supported — express a high cap (e.g. 2147483647)
          if a deep tree is intentional.

  Same pattern as the contextSafetyThreshold / contextPressureThreshold
  validators above. See evidence/audit-rev3/C1.md C1-CONFIG for rationale.
*/}}
{{- if hasKey .Values "supervision" -}}
{{- $sup := .Values.supervision -}}
{{- if hasKey $sup "maxEscalationDepth" -}}
{{- $depth := $sup.maxEscalationDepth -}}
{{/* Helm/YAML parses unquoted integers as float64; accept any numeric and
   verify it's a whole positive number. Reject strings, bools, nil. */}}
{{- if or (kindIs "invalid" $depth) (not (or (kindIs "float64" $depth) (kindIs "int" $depth) (kindIs "int64" $depth))) -}}
{{- fail (printf "kagent-operator: supervision.maxEscalationDepth must be a positive integer (got %v of type %s) — non-numeric values silently re-default to 8 in the operator, masking the misconfig. See evidence/audit-rev3/C1.md C1-CONFIG" $depth (kindOf $depth)) -}}
{{- end -}}
{{- $depthF := $depth | float64 -}}
{{- if le $depthF 0.0 -}}
{{- fail (printf "kagent-operator: supervision.maxEscalationDepth must be a positive integer (got %v) — values <=0 silently re-default to 8 in the operator, masking the misconfig. \"No limit\" is NOT supported; use a high sentinel (e.g. 2147483647) if a deep tree is intentional. See evidence/audit-rev3/C1.md C1-CONFIG" $depth) -}}
{{- end -}}
{{- $depthI := $depth | int -}}
{{- if ne (printf "%v" $depthF) (printf "%v" (float64 $depthI)) -}}
{{- fail (printf "kagent-operator: supervision.maxEscalationDepth must be an integer (got %v) — fractional values silently re-default to 8 in the operator, masking the misconfig. See evidence/audit-rev3/C1.md C1-CONFIG" $depth) -}}
{{- end -}}
{{- end -}}
{{- end -}}
{{- end -}}
