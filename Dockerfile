# syntax=docker/dockerfile:1.7
# Multi-stage build on node:24-alpine, the Node line .nvmrc and engines require.
# Pinned by digest, as in the client images, so a rebuild never picks up a
# different base silently; Renovate proposes each new digest.
FROM node:24-alpine@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1 AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH
# Corepack is installed explicitly because Node 25+ does not bundle it. The pnpm
# version comes from package.json's packageManager field (`corepack install` in deps).
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
# `pnpm prune --prod`, not `pnpm install --prod`: the install only unlinks
# devDependencies and leaves them in node_modules/.pnpm, while prune removes
# them, so the runtime image carries neither tsc nor drizzle-kit. Migrations
# run via dist/database/migrate.js.
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm prune --prod --ignore-scripts

FROM base AS runner
# NODE_ENV is what Express reads. APP_ENV (dev/qa/prod) is required and set
# by the deployment, never here: a missing APP_ENV must fail boot.
ENV NODE_ENV=production
COPY --from=build --chown=10001:10001 /app/node_modules ./node_modules
COPY --from=build --chown=10001:10001 /app/dist ./dist
COPY --from=build --chown=10001:10001 /app/package.json ./package.json

# The image's git sha, passed by deploy.yml's image job; /health and error
# tracking report it as the release. Late in the stage, so a new sha
# rebuilds no earlier layer. Local builds get `dev`.
ARG GIT_SHA=dev
ENV APP_VERSION=$GIT_SHA

# The orchestrator owns liveness and readiness via /health and /health/ready;
# a Docker HEALTHCHECK would be a second signal that can disagree under load.
HEALTHCHECK NONE

USER appuser
EXPOSE 4040
# Like `pnpm start` without --env-file-if-exists: the image has no .env
# (.dockerignore) and the orchestrator supplies the environment. tracing.js
# loads via --import, before the app, or OpenTelemetry never starts.
# --enable-source-maps maps stack traces to the .ts lines (tsconfig.json's sourceMap).
CMD ["node", "--enable-source-maps", "--import", "./dist/observability/tracing.js", "dist/index.js"]
