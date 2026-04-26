# Tribes Lobby Server — Dockerfile for Fly.io / Render / Railway
# Pinned base image. Single-stage build — no compile step needed for TS+Bun.

FROM oven/bun:1.1.34-alpine

WORKDIR /app

# Install deps first for layer caching
COPY package.json ./
RUN bun install --production --frozen-lockfile || bun install --production

# Copy source
COPY lobby.ts ./

# Bun runs TS directly; no build step
EXPOSE 8080
ENV PORT=8080

# Run as non-root for safety
RUN addgroup -S app && adduser -S app -G app
USER app

CMD ["bun", "run", "lobby.ts"]
