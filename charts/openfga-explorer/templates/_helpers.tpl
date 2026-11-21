{{/*
Nom de base du chart (tronqué à 63 caractères, sans tiret final).
*/}}
{{- define "openfga-explorer.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Nom complet de la release.
*/}}
{{- define "openfga-explorer.fullname" -}}
{{- if .Values.fullnameOverride }}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- $name := default .Chart.Name .Values.nameOverride }}
{{- if contains $name .Release.Name }}
{{- .Release.Name | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" }}
{{- end }}
{{- end }}
{{- end }}

{{/*
Version du chart pour les labels.
*/}}
{{- define "openfga-explorer.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Labels communs.
*/}}
{{- define "openfga-explorer.labels" -}}
helm.sh/chart: {{ include "openfga-explorer.chart" . }}
{{ include "openfga-explorer.selectorLabels" . }}
{{- if .Chart.AppVersion }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
{{- end }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}

{{/*
Labels de sélection.
*/}}
{{- define "openfga-explorer.selectorLabels" -}}
app.kubernetes.io/name: {{ include "openfga-explorer.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{/*
Nom du ServiceAccount.
*/}}
{{- define "openfga-explorer.serviceAccountName" -}}
{{- if .Values.serviceAccount.create }}
{{- default (include "openfga-explorer.fullname" .) .Values.serviceAccount.name }}
{{- else }}
{{- default "default" .Values.serviceAccount.name }}
{{- end }}
{{- end }}

{{/*
Nom du Secret portant le token : Secret existant si fourni, sinon Secret géré.
*/}}
{{- define "openfga-explorer.tokenSecretName" -}}
{{- if .Values.openfga.token.existingSecret }}
{{- .Values.openfga.token.existingSecret }}
{{- else }}
{{- include "openfga-explorer.fullname" . }}
{{- end }}
{{- end }}

{{/*
Clé du token dans le Secret.
*/}}
{{- define "openfga-explorer.tokenSecretKey" -}}
{{- if .Values.openfga.token.existingSecret }}
{{- default "token" .Values.openfga.token.existingSecretKey }}
{{- else }}
{{- "token" }}
{{- end }}
{{- end }}

{{/*
Indique si un token est utilisé (valeur en clair ou Secret existant).
*/}}
{{- define "openfga-explorer.hasToken" -}}
{{- if or .Values.openfga.token.value .Values.openfga.token.existingSecret }}true{{- end }}
{{- end }}

{{/*
Indique si SESSION_SECRET est fourni (valeur en clair ou Secret existant).
Utilisé par le Deployment pour décider d'injecter l'env var.
*/}}
{{- define "openfga-explorer.hasSessionSecret" -}}
{{- if or .Values.auth.secret.sessionSecret.value .Values.auth.secret.sessionSecret.existingSecret }}true{{- end }}
{{- end }}

{{/*
Nom du Secret portant SESSION_SECRET.
*/}}
{{- define "openfga-explorer.sessionSecretName" -}}
{{- if .Values.auth.secret.sessionSecret.existingSecret }}
{{- .Values.auth.secret.sessionSecret.existingSecret }}
{{- else if .Values.auth.secret.sessionSecret.value }}
{{- include "openfga-explorer.fullname" . }}
{{- end }}
{{- end }}

{{/*
Clé SESSION_SECRET dans le Secret.
*/}}
{{- define "openfga-explorer.sessionSecretKey" -}}
{{- default "session-secret" .Values.auth.secret.sessionSecret.existingSecretKey }}
{{- end }}

{{/*
Indique si ADMIN_PASSWORD est fourni (valeur en clair ou Secret existant).
*/}}
{{- define "openfga-explorer.hasAdminPassword" -}}
{{- if or .Values.auth.secret.adminPassword.value .Values.auth.secret.adminPassword.existingSecret }}true{{- end }}
{{- end }}

{{/*
Nom du Secret portant ADMIN_PASSWORD.
*/}}
{{- define "openfga-explorer.adminPasswordSecretName" -}}
{{- if .Values.auth.secret.adminPassword.existingSecret }}
{{- .Values.auth.secret.adminPassword.existingSecret }}
{{- else if .Values.auth.secret.adminPassword.value }}
{{- include "openfga-explorer.fullname" . }}
{{- end }}
{{- end }}

{{/*
Clé ADMIN_PASSWORD dans le Secret.
*/}}
{{- define "openfga-explorer.adminPasswordSecretKey" -}}
{{- default "admin-password" .Values.auth.secret.adminPassword.existingSecretKey }}
{{- end }}

{{/*
Indique si un Secret managé (au moins une valeur en clair) doit être créé.
*/}}
{{- define "openfga-explorer.hasManagedSecret" -}}
{{- if or (and .Values.auth.secret.sessionSecret.value (not .Values.auth.secret.sessionSecret.existingSecret)) (and .Values.auth.secret.adminPassword.value (not .Values.auth.secret.adminPassword.existingSecret)) (and .Values.openfga.token.value (not .Values.openfga.token.existingSecret)) }}true{{- end }}
{{- end }}
