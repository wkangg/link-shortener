# syntax=docker/dockerfile:1
ARG BUN_VERSION=1.4.4

# ---- dependencies (production only) ----
FROM oven/bun:${BUN_VERSION}-slim AS deps
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

# ---- runtime ----
FROM oven/bun:${BUN_VERSION}-slim
WORKDIR /app

ENV NODE_ENV=production \
    SHORT_PORT=3000 \
    DASH_PORT=3001 \
    DB_PATH=/data/links.db

COPY --from=deps /app/node_modules ./node_modules
COPY package.json tsconfig.json ./
COPY src ./src
COPY scripts ./scripts

# /data is the SQLite volume. Creating it here (owned by the non-root `bun`
# user) means a fresh named volume inherits that ownership.
RUN mkdir -p /data && chown -R bun:bun /data
VOLUME ["/data"]
USER bun

EXPOSE 3000 3001

HEALTHCHECK --interval=15s --timeout=3s --start-period=10s --retries=3 \
  CMD ["bun", "-e", "fetch('http://127.0.0.1:3001/healthz').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"]

CMD ["bun", "src/index.ts"]
