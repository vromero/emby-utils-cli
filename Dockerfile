# ─────────────────────────────────────────────────────────────────────────────
# Multi-stage Dockerfile for @emby-utils/cli
#
# Produces a minimal image that can:
#   • Run any `emby` CLI command (e.g. emby system info, emby libraries list)
#   • Initialize an Emby server from a JSON config (emby init --config /config/init.json)
#
# Usage examples:
#   docker run --rm -e EMBY_HOST=http://emby:8096 -e EMBY_API_KEY=xxx emby-utils system info
#   docker run --rm -e EMBY_HOST=http://emby:8096 -v ./init.json:/config/init.json emby-utils init --config /config/init.json
# ─────────────────────────────────────────────────────────────────────────────

# ── Build stage ──────────────────────────────────────────────────────────────
FROM node:22-slim AS build

WORKDIR /app

# Install all dependencies (including devDependencies for TypeScript build).
# The prepare script will fail on husky (no .git), so we skip scripts and
# run the build explicitly.
COPY package.json ./
RUN npm install --ignore-scripts --no-audit --no-fund

# Copy source and compile
COPY tsconfig.json tsconfig.build.json ./
COPY src/ ./src/
RUN npx tsc -p tsconfig.build.json

# ── Production stage ─────────────────────────────────────────────────────────
FROM node:22-slim AS runtime

LABEL org.opencontainers.image.source="https://github.com/vromero/emby-utils-cli"
LABEL org.opencontainers.image.description="CLI and init tool for Emby Media Server"
LABEL org.opencontainers.image.licenses="MIT"

WORKDIR /app

# Install only production dependencies
COPY package.json ./
RUN npm install --omit=dev --ignore-scripts --no-audit --no-fund && \
    npm cache clean --force

# Copy compiled output from build stage
COPY --from=build /app/dist ./dist/

# Create config directory for mounting init files
RUN mkdir -p /config

# The entrypoint delegates to the emby CLI binary
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

ENV NODE_ENV=production

ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["--help"]
