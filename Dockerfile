# syntax=docker/dockerfile:1
# Multi-stage build for the PulseGate monorepo (ADR-0029).
# Targets: "gateway" and "mock-upstreams". Build with e.g. `docker build --target gateway .`

ARG NODE_VERSION=26.4.0

FROM node:${NODE_VERSION}-slim AS build
# Node 25+ no longer ships corepack, so pnpm is installed from npm at the pinned version.
RUN npm install -g pnpm@11.9.0
WORKDIR /repo

# Install dependencies from manifests only, so source edits don't invalidate this layer.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/gateway/package.json apps/gateway/
COPY packages/admin-contract/package.json packages/admin-contract/
COPY packages/cache/package.json packages/cache/
COPY packages/config/package.json packages/config/
COPY packages/observability/package.json packages/observability/
COPY packages/rate-limiter/package.json packages/rate-limiter/
COPY packages/reliability/package.json packages/reliability/
COPY packages/testing/package.json packages/testing/
COPY packages/shared/package.json packages/shared/
COPY examples/mock-upstreams/package.json examples/mock-upstreams/
RUN pnpm install --frozen-lockfile

COPY tsconfig.base.json ./
COPY packages packages
COPY apps apps
COPY examples examples
RUN pnpm build

# Standalone production bundles: dist + prod node_modules (workspace deps copied as dist only).
RUN pnpm --filter @pulsegate/gateway deploy --prod --legacy /out/gateway \
 && pnpm --filter @pulsegate/mock-upstreams deploy --prod --legacy /out/mock-upstreams

FROM node:${NODE_VERSION}-slim AS gateway
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /out/gateway ./
USER node
# 8080 public listener; 9091 operations listener (bound to 127.0.0.1 by default, ADR-0022).
EXPOSE 8080
CMD ["node", "dist/main.js"]

FROM node:${NODE_VERSION}-slim AS mock-upstreams
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /out/mock-upstreams ./
USER node
CMD ["node", "dist/main.js"]
