# ── Stage 1: build ────────────────────────────────────────────────────────────
FROM node:20-alpine AS builder
WORKDIR /app

# Copy workspace manifests first so npm install is cached independently of src
COPY package.json package-lock.json ./
COPY apps/server/package.json        ./apps/server/
COPY apps/web/package.json           ./apps/web/
COPY packages/cryptorefills-client/package.json ./packages/cryptorefills-client/
COPY packages/swap-router/package.json           ./packages/swap-router/

RUN npm ci --ignore-scripts

# Copy all source and build
COPY tsconfig.base.json ./
COPY packages/ ./packages/
COPY apps/     ./apps/

RUN npm run build

# ── Stage 2: server runtime ───────────────────────────────────────────────────
FROM node:20-alpine AS server
WORKDIR /app
ENV NODE_ENV=production

# Only copy what the server needs at runtime
COPY --from=builder /app/package.json             ./
COPY --from=builder /app/package-lock.json        ./
COPY --from=builder /app/node_modules             ./node_modules/
COPY --from=builder /app/apps/server/dist         ./apps/server/dist/
COPY --from=builder /app/apps/server/package.json ./apps/server/
COPY --from=builder /app/packages/cryptorefills-client/dist ./packages/cryptorefills-client/dist/
COPY --from=builder /app/packages/cryptorefills-client/package.json ./packages/cryptorefills-client/
COPY --from=builder /app/packages/swap-router/dist     ./packages/swap-router/dist/
COPY --from=builder /app/packages/swap-router/package.json ./packages/swap-router/

# Reduce node_modules to production-only dependencies to avoid shipping dev deps
RUN npm prune --production --no-audit --no-fund || true

# Create a non-privileged user and drop root before running the app
RUN addgroup -S app && adduser -S app -G app && chown -R app:app /app
USER app

EXPOSE 3001
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:3001/health || exit 1

CMD ["node", "apps/server/dist/index.js"]

# ── Stage 3: web static files (built by vite) ─────────────────────────────────
FROM nginx:alpine AS web
COPY --from=builder /app/apps/web/dist /usr/share/nginx/html
# nginx config is mounted at runtime via docker-compose
