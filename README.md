# Tribes Browser Edition

A clean-room recreation of **Starsiege: Tribes** (Dynamix, 1998) running natively in your browser. Authentic skiing physics, jetpack combat, capture-the-flag — no install, no plugins.

**Live: <https://uptuse.github.io/tribes/>**

## How to play

- **WASD** to move, **Space** to jump (hold mid-air to jet), **Shift** to ski downhill
- **1-5** weapon select, **Mouse1** fire, **F** grab/cap flag
- **Tab** scoreboard, **Esc** menu, **M** mute

## How it works

| Layer | Tech |
|---|---|
| Game simulation | C++ ported from the original Darkstar engine, compiled to **WebAssembly** via Emscripten |
| Renderer | **Three.js r170** — heightmap-displaced terrain, atmospheric sky, PBR materials, shadows, post-processing |
| Multiplayer server | **Bun** locally / **Cloudflare Workers + Durable Objects** in production. Authoritative 30Hz tick. |
| Wire format | Binary `DataView`-packed snapshot (~664B @ 10Hz) + delta (~122B @ 30Hz) + input (12B @ 60Hz) |
| Anti-cheat | Server-side speed/aim-rate/cooldown/divergence checks |

The architecture decision memo lives in [`comms/network_architecture.md`](comms/network_architecture.md).

## Run locally

Requires [Emscripten SDK](https://emscripten.org/) and [Bun](https://bun.sh/) ≥ 1.1.

```bash
# Build the WASM client
./build.sh
python3 -m http.server 8081      # serve repo root on :8081

# In another terminal, run the multiplayer server
cd server && bun install && bun run start

# Open in browser
open 'http://localhost:8081/?multiplayer=local'
```

For single-player only, just `./build.sh` and open `index.html`.

## Production deploy

```bash
cd server/cloudflare && ./deploy.sh
```

See [`server/cloudflare/README_DEPLOY.md`](server/cloudflare/README_DEPLOY.md) for the full Cloudflare Workers + Durable Objects deploy walkthrough, custom-domain mapping, and cost expectations.

## Repo layout

| Path | Purpose |
|------|---------|
| `program/code/wasm_main.cpp` | C++ simulation (player physics, weapons, bots, match flow) |
| `renderer.js` | Three.js renderer (terrain, players, buildings, particles, post-processing) |
| `client/{network,prediction,wire,quant,constants}.js` | Multiplayer client + binary wire format |
| `server/lobby.ts` | Bun WebSocket lobby server (local dev) |
| `server/sim.ts` | Authoritative TS port of player physics + projectiles + flags |
| `server/cloudflare/` | CF Workers + Durable Objects production scaffolding |
| `comms/network_architecture.md` | Architecture decision memo (Opus R16) |
| `comms/master_plan.md` | Project tier plan |
| `comms/CHANGELOG.md` | Per-round change log |

## Contribute

This is a personal project but PRs are welcome. The collaboration model uses two AI agents:
- **Manus** is the art director / QA — pushes round briefs to `comms/manus_feedback.md` with acceptance criteria
- **Claude** (this repo's primary author) is the integrator — implements against the brief, ships in 60-120 min rounds

Open issues + ongoing backlog: [`comms/open_issues.md`](comms/open_issues.md).

## License

MIT — see [`LICENSE`](LICENSE) if present.

## Credits

Asset attribution and acknowledgements: [`assets/CREDITS.md`](assets/CREDITS.md).

This is an independent fan project. Not affiliated with Dynamix, Sierra, or Activision.
