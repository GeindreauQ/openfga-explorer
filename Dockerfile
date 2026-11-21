# ── Stage 1 : build du binaire Go ─────────────────────────────────────────────
FROM golang:1.25-alpine AS build

WORKDIR /src

COPY src/server/go.mod src/server/go.sum* ./
RUN go mod download

# Code source du serveur.
COPY src/server/ ./

# Build statique (CGO désactivé) pour fonctionner sur une image distroless static.
ARG TARGETOS=linux
ARG TARGETARCH=amd64
RUN CGO_ENABLED=0 GOOS=${TARGETOS} GOARCH=${TARGETARCH} \
    go build -trimpath -ldflags="-s -w" -o /out/openfga-explorer .

# ── Stage 2 : image finale distroless ─────────────────────────────────────────
FROM gcr.io/distroless/static-debian12:nonroot

WORKDIR /app

# Binaire serveur.
COPY --from=build /out/openfga-explorer /app/openfga-explorer

# Frontend statique servi par le binaire.
COPY src/web/ /app/web/

COPY src/server/views/ /app/views/


ENV WEB_DIR=/app/web \
    ADDR=:8000 \
    VIEWS_DIR=/app/views

# Utilisateur non-root de l'image distroless:nonroot, en UID numérique :
# Kubernetes ne peut vérifier runAsNonRoot que sur un UID.
USER 65532:65532

EXPOSE 8000

ENTRYPOINT ["/app/openfga-explorer"]
