# syntax=docker/dockerfile:1.7
# Multi-stage. node:24-alpine, not 22 — see Global Constraints.
FROM node:24-alpine AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH
# Corepack is installed explicitly: Node 25+ no longer bundles it, and doing it
# now makes the Node 26 move a version bump only. The pnpm version itself comes
# from package.json's packageManager field (see `corepack install` in deps).
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN npm i -g corepack@0.36.0 && corepack enable
RUN adduser -D -u 10001 appuser
WORKDIR /app

FROM base AS deps
# pnpm-workspace.yaml and .npmrc travel with the lockfile: pnpm reads
# allowBuilds, minimumReleaseAge and minimumReleaseAgeExclude from
# pnpm-workspace.yaml at install time (the lockfile doesn't record them), and
# --frozen-lockfile enforces the release-age gate, so the install needs the
# file on disk to allow bcrypt's build and apply the excludes.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
RUN corepack install
# Cache mount keeps the store between builds without baking it into a layer.
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile

FROM deps AS build
COPY . .
RUN pnpm build
# `pnpm install --prod` alone unlinks devDependencies from node_modules but
# leaves their content behind in node_modules/.pnpm (the content-addressable
# virtual store) — verified empirically: after `install --frozen-lockfile
# --prod --ignore-scripts`, node_modules/.pnpm/typescript@6.0.3 and
# .../drizzle-kit@0.31.10 were both still present, full tsc binary included.
# `pnpm prune --prod` is the command that actually removes them from the
# virtual store, so the runtime image carries neither the compiler nor
# drizzle-kit. Migrations run via dist/database/migrate.js.
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm prune --prod --ignore-scripts

FROM base AS runner
# NODE_ENV is what Express reads. APP_ENV (dev/qa/prod) is required and set
# by the deployment, never here: a missing APP_ENV must fail boot.
ENV NODE_ENV=production
COPY --from=build --chown=10001:10001 /app/node_modules ./node_modules
COPY --from=build --chown=10001:10001 /app/dist ./dist
COPY --from=build --chown=10001:10001 /app/package.json ./package.json

# The orchestrator owns liveness and readiness via /health and /health/ready.
# A Docker HEALTHCHECK would be a second, competing signal that disagrees with
# the first under load — one signal is better than two.
HEALTHCHECK NONE

USER appuser
EXPOSE 4040
# Like `pnpm start`, minus --env-file-if-exists (the image has no .env, see
# .dockerignore; the orchestrator supplies the environment) and plus
# --enable-source-maps: tracing.js must load via --import, before the app, or
# OpenTelemetry (traces AND logs) never starts; --enable-source-maps makes a
# thrown stack trace point at the original .ts line, since the build emits
# .map files (tsconfig.json's sourceMap: true) alongside the .js it ships.
CMD ["node", "--enable-source-maps", "--import", "./dist/observability/tracing.js", "dist/index.js"]
