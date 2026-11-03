# ============================================================================
# Stage 1: Builder (Compile TypeScript & resolve bundled @opencode/cli binary)
# ============================================================================
FROM node:20-bookworm-slim AS builder

WORKDIR /app
COPY package.json package-lock.json .npmrc tsconfig.json ./
RUN npm ci

COPY src ./src
RUN npm run build

# ============================================================================
# Stage 2: Runtime (Aster Hub & Aster Node with nsenter host bridge)
# ============================================================================
FROM node:20-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    util-linux \
    procps \
    iproute2 \
  && rm -rf /var/lib/apt/lists/* \
  && mkdir -p /var/lib/aster-hub /var/lib/aster-node \
  && chmod 700 /var/lib/aster-hub /var/lib/aster-node

WORKDIR /opt/aster-fleet
COPY --from=builder /app/package.json /app/package-lock.json /app/.npmrc ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist

ENV NODE_ENV=production
ENV HOST_NSENTER=auto

# Default entrypoint menjalankan Hub; untuk Node override command menjadi:
# ["node", "dist/node/index.js"]
CMD ["node", "dist/hub/index.js"]
