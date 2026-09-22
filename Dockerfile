# syntax=docker/dockerfile:1.7
# Multi-stage. node:24-alpine, not 22 — see Global Constraints.
FROM node:25-alpine AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH
RUN corepack enable && corepack prepare pnpm@12.4.1 --activate
RUN adduser -D -u 10001 appuser
WORKDIR /app

FROM base AS deps
# pnpm-workspace.yaml and .npmrc travel with the lockfile: pnpm 10+ records
# workspace settings (allowBuilds, minimumReleaseAgeExclude) into
# pnpm-lock.yaml, and --frozen-lockfile refuses to install if it can't
# reconcile that recorded config against the workspace file on disk.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
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
CMD ["node", "dist/index.js"]
