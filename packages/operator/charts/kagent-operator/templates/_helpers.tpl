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
