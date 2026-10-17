# KFin production runtime.
#
# One process serves the compiled client and the API on the same origin, which is
# what the no-CORS/same-origin-only design requires. The image carries the built
# artifact and a production-only dependency tree: no `tsx`, no TypeScript, no
# devDependencies, no `tools/dev-server.mjs`.
#
# Build:
#   docker build --build-arg GIT_COMMIT="$(git rev-parse HEAD)" -t kfin-runtime .
# Run:
#   docker run --env-file /run/kfin.env -p 3000:3000 kfin-runtime
#
# TLS, the public hostname, the secret store and log shipping belong to the host
# in front of this container; see docs/operations/PRODUCTION-RUNTIME.md.

# syntax=docker/dockerfile:1

FROM node:22.22.3-bookworm-slim AS build
WORKDIR /src
ENV CI=true
RUN corepack enable

# Manifests first so dependency installation is cached across source changes.
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/config/package.json packages/config/package.json
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/database/package.json packages/database/package.json
COPY packages/domain/package.json packages/domain/package.json
RUN corepack pnpm install --frozen-lockfile

COPY tsconfig.base.json tsconfig.json tsconfig.tests.json vitest.config.ts ./
COPY packages ./packages
COPY apps ./apps
COPY scripts ./scripts
ARG GIT_COMMIT=unknown
RUN BUILD_COMMIT="${GIT_COMMIT}" corepack pnpm run build

# The runtime install is resolved from the artifact's own manifest.
FROM node:22.22.3-bookworm-slim AS runtime
ENV NODE_ENV=production \
    NODE_OPTIONS=--enable-source-maps \
    HOST=0.0.0.0 \
    PORT=3000
WORKDIR /app
COPY --from=build /src/apps/api/dist/runtime-package.json ./package.json
RUN npm install --omit=dev --no-audit --no-fund --loglevel=error \
    && npm cache clean --force
COPY --from=build /src/apps/api/dist ./
USER node
EXPOSE 3000
STOPSIGNAL SIGTERM
# The image has no curl; the probe uses Node's built-in fetch.
HEALTHCHECK --interval=30s --timeout=3s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 3000) + '/health/ready').then((response) => process.exit(response.ok ? 0 : 1)).catch(() => process.exit(1))"
CMD ["node", "server.bundle.mjs"]
