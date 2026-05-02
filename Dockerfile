# ============================================================
# Tribes Browser Edition — full-stack Dockerfile
# (game + multiplayer lobby in a single Bun process)
# ============================================================
# Build:    docker build -t tribes .
# Run:      docker run -p 8080:8080 tribes
# Deploy:   fly deploy
#
# At runtime the Bun process:
#   - serves the static game from /app/public at GET /, /tribes.js, ...
#   - upgrades GET /ws to a WebSocket for the multiplayer lobby
#   - exposes /health and /metrics
# ============================================================

FROM oven/bun:1.1.34-alpine

WORKDIR /app

# ---- 1. server deps ----
# Copy the server package manifest first to maximise Docker layer cache hits.
COPY server/package.json server/bun.lock* ./server/
RUN cd server && (bun install --production --frozen-lockfile || bun install --production)

# ---- 2. server source ----
# All TS files the lobby needs: lobby, sim, wire, anticheat, etc.
COPY server/*.ts ./server/

# ---- 3. client/ folder (re-exported by server/wire.ts, server/constants.ts) ----
COPY client ./client

# ---- 4. static game files (the "public" web root) ----
# index.html, the WASM bundle, the renderer, vendor three, the assets the
# game actually fetches. We DO NOT copy program/, anchor_studio/, docs/,
# or the giant tribes_data/ raw mesh dump.
RUN mkdir -p /app/public/assets/textures /app/public/assets/maps /app/public/assets/sfx /app/public/assets/hdri /app/public/vendor

COPY index.html               /app/public/
COPY tribes.js                /app/public/
COPY tribes.wasm              /app/public/
COPY tribes.data              /app/public/
# Glob-style: ship every root-level renderer*.js + server.js
# (renderer.js dynamic-imports renderer_polish, renderer_sky, renderer_characters,
#  renderer_daynight, renderer_buildings, renderer_combat_fx, renderer_command_map,
#  renderer_debug_panel, renderer_kenney_base, renderer_minimap, renderer_palette,
#  renderer_rapier, renderer_toonify, renderer_zoom)
COPY renderer*.js             /app/public/
COPY server.js                /app/public/
COPY vendor/three             /app/public/vendor/three
# Ship the entire assets/ tree minus the obviously huge stuff. Easier than
# cherry-picking and missing things like glb/, models/, weapons/, .DTS files.
COPY assets                   /app/public/assets

# Note: /app/client is duplicated under /app/public/client for the browser too,
# because index.html does dynamic `import('./client/network.js')` etc.
RUN cp -r /app/client /app/public/client

# ---- 4b. server-relative client/ alias ----
# lobby.ts loads maps with paths like 'client/maps/raindance.tribes-map'
# (relative to CWD). Since CWD = /app/server, we symlink so those resolve
# to /app/client/maps/... without changing source code.
RUN ln -s /app/client /app/server/client

# ---- 5. runtime config ----
ENV PORT=8080
ENV STATIC_DIR=/app/public
EXPOSE 8080

# ---- 6. drop privileges ----
RUN addgroup -S app && adduser -S app -G app && chown -R app:app /app
USER app

# Working dir is /app/server because lobby.ts uses relative imports like
# `import './sim.ts'`. The ../client/ re-exports also resolve from there.
WORKDIR /app/server
CMD ["bun", "run", "lobby.ts"]
