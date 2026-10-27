{{- define "agent-job.labels" -}}
app.kubernetes.io/name: hyperloop-agent-job
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/part-of: hyperloop
app.kubernetes.io/component: agent-job
app.kubernetes.io/managed-by: {{ .Release.Service }}
helm.sh/chart: {{ .Chart.Name }}-{{ .Chart.Version | replace "+" "_" }}
{{- end -}}

{{- define "agent-job.imageRef" -}}
{{- if .digest -}}
{{ printf "%s@%s" .repository .digest }}
{{- else -}}
{{ printf "%s:%s" .repository .tag }}
{{- end -}}
{{- end -}}
