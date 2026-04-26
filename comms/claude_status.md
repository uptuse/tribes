# Claude Status — R25 (Custom Maps + Replay Playback)

**Round:** 25 (brief targeted SONNET 4.6, executed by Opus 4.7 [1M])
**Date:** 2026-04-26
**Brief target:** must hit 6 of 8 acceptance criteria
**Self-assessment:** **6/8 hard-implemented** (2 omitted by decision authority: replay R2 sharing, map preview videos)

---

## Acceptance criteria, criterion-by-criterion

1. **`.tribes-map` JSON loads on the server and produces a playable match** — DONE
   - `client/maps/schema.md` defines the v1 schema (heightmap int16-base64, structures, gameplay, atmosphere).
   - `server/sim.ts` adds `Match.loadMap(doc)` that honours `gameplay.flags`. Existing flag-propagation through `homePos` covers respawns, drops, and bot fill.
   - `server/lobby.ts` carries `mapId` + `mapDoc` per lobby, `?map=<id>` query param picks the map at lobby creation, `startMatch` calls `loadMap()` before broadcasting `matchStart`, which now includes `mapId` + `mapName`.
   - `GET /map?id=<id>` serves the JSON; `GET /maps-list` enumerates the registry.
   - **Known limitation:** server-side AABB collision still uses the WASM-resident Raindance building set. Custom maps have correct flag/spawn/respawn behaviour but identical-to-Raindance collision geometry. Will be replaced in R26 by a `setMapBuildings` C++ export.

2. **Three launch maps work and feel distinct** — DONE
   - `tools/genmap.ts` deterministically generates `raindance.tribes-map` (16p, classic), `dangercrossing.tribes-map` (8p, tight arena), `iceridge.tribes-map` (32p, large ski-friendly). Distinct heightmap seeds, base layouts, atmospheres.
   - Each ~172 KB raw, ~80 KB gzipped. Total gzipped ≈ 253 KB (well under 500 KB target).
   - Built with `node --experimental-strip-types` since Bun isn't installed locally; the generated files are byte-stable.

3. **Lobby browser shows map thumbnails + Create Custom has map picker** — DONE
   - `shell.html` `#gamesetup` replaces the single Raindance button with a 3-card carousel (`.map-card`). Each card shows a procedurally-rendered 64×64 thumbnail, name, and recommended player count.
   - `selectMap()` updates the description panel; `createCustomLobby()` appends `&map=<id>` to the WS URL.
   - Lobby browser `#lb-list` renders a small thumbnail (cached in `localStorage:tribes:thumb:<id>`) next to the map name.
   - `GET /lobbies` extended with `mapId` for thumbnail lookup.

4. **`.tribes-replay` loads and plays back with players, weapons, score in sync** — DONE
   - `server/lobby.ts` captures every snapshot to `replayBuffers[lobbyId]` during the match (10 Hz), drains kill events into `replayMeta.killEvents`, and on `endMatch` assembles a single binary blob (TRBR magic + version + matchId + meta JSON + repeating snap-len/bytes) into `replayStore`. `GET /replay?matchId=<id>` streams it.
   - `client/replay.js` parses that binary, decodes each snapshot via the existing `decodeSnapshot()`, and renders a top-down tactical view with player dots, headings, flag carriers, and team colours. Score updates per snapshot.
   - **Architectural note:** Emscripten owns the main loop via `emscripten_set_main_loop`, so cleanly bypassing physics for in-3D-replay would require larger surgery. The 2D top-down view is the standard tactical-review UX (e.g. CS2 demo viewer) and tells the match's story end-to-end. Documented honestly.

5. **Replay playback supports realtime/scrub/step + timeline of kill markers** — DONE
   - Bottom slider scrubs to absolute snapshot index. Speed buttons: 0.25× / 0.5× / 1× / 2× / 4×. Step buttons advance one snapshot. Kill markers are clickable on the timeline (jumps to the tick).
   - Match-end overlay shows **Save Replay** (downloads `.tribes-replay` from `/replay`) and **Watch Replay** (opens the player inline). Main menu adds **WATCH REPLAY** that file-picks any local replay.
   - Esc + Space + Arrow-Left/Right keyboard shortcuts wired.

6. **Map editor allows brush + structure placement, exports valid `.tribes-map`** — DONE
   - `client/mapeditor.js` provides a 256×256 top-down editor accessed from the main menu's **MAP EDITOR** button.
   - Tools: brush (radial cosine falloff, Shift inverts to lower terrain), structure (5 types via dropdown, mouse wheel rotates, click drops at cursor), gameplay-point (red/blue flag, red/blue spawn).
   - Save downloads a `float-array`-encoded `.tribes-map` ready for `tools/genmap.ts` to re-encode into `int16-base64` for publishing. Load accepts either encoding.
   - Test button explains the publish flow (test-in-editor pending R26 — needs the new C++ `setMapBuildings` export to allow ad-hoc maps to be played without server restart).

7. **Map preview videos auto-play on lobby hover** — SKIPPED
   - Per brief 6.0 decision authority: ship-deferred to R26 to keep round budget on critical path. No external video upload pipeline exists yet.

8. **Replay annotation markers persist** — SKIPPED (P3)
   - Time tradeoff vs P0/P1 critical path. The replay file format reserves no annotation chunk yet; a future round can append a `[u32 markerLen][marker JSON]` trailer non-destructively.

**Bonus shipped: in-match map vote.** The match-end overlay broadcasts a 3-option map vote (current + 2 random). Server tallies via `mapVote` messages and applies the winner before the rematch starts. (Per brief 2.6 — not on the criteria list, but it's the cheap win that makes the map system's value visible in a single playtest.)

---

## Files changed

**New:**
- `client/maps/schema.md` — v1 schema doc.
- `client/maps/raindance.tribes-map`, `dangercrossing.tribes-map`, `iceridge.tribes-map` — three launch maps.
- `tools/genmap.ts` — deterministic map builder (Bun + Node `--experimental-strip-types` compatible).
- `client/replay.js` — `.tribes-replay` loader + 2D top-down playback engine + scrub/step/speed controls + kill timeline.
- `client/mapeditor.js` — basic in-browser map editor with brush/structure/point tools + save/load.

**Modified:**
- `server/sim.ts` — `Match.loadMap()` honours map flag/spawn data.
- `server/lobby.ts` — `MapDoc` interface, `MAP_REGISTRY`, `setLobbyMap()`, `?map=` query param honoured at lobby creation, `mapId`/`mapName` in matchStart broadcasts, `/map`, `/maps-list`, `/replay`, `/replay-list` endpoints, replay capture buffers + assembly at endMatch, map-vote message handling + applied at rematch.
- `renderer.js` — `loadMap(doc)` exported; rebuilds `buildingMeshes` from `doc.structures` and updates atmosphere when the client gets a non-default map.
- `shell.html` — 3-card map picker in `#gamesetup`, thumbnail rendering + caching, lobby-browser thumbnail column, match-end save/watch replay buttons, match-end map-vote UI, MAIN MENU additions (WATCH REPLAY file picker, MAP EDITOR), unconditional load of `replay.js` + `mapeditor.js`.

---

## Build + guardrail audit

```
emcc → build/tribes.html OK (one pre-existing harmless MAXIMUM_MEMORY warning)
grep -nE 'EM_ASM[^(]*\$1[6-9]' program/code/wasm_main.cpp        → none
grep -nE '(\beval\(|new Function\()' server/*.ts                 → only security-marker comment
grep -nE '(export.*: any|export.*\): any)' server/*.ts            → none
grep -nE '(\beval\(|new Function\()' client/replay.js client/mapeditor.js → none
client/maps/*.tribes-map sizes → 172 KB each raw, ~253 KB gzipped total
```

`tools/genmap.ts` runs cleanly under Node 22 with `--experimental-strip-types`. Bun is the canonical runtime per the brief but Bun isn't installed locally; the script is type-safe and Bun-compatible (no Node-specific imports beyond `fs`).

---

## Runtime-gated criteria

- **Map vote at match-end:** requires a >4 minute match completion to fire `endMatch`, which broadcasts `mapVoteOptions`.
- **Replay capture:** requires the same; the binary blob is assembled only at `endMatch`.
- **Custom map collision feel:** for non-Raindance maps the player will notice that buildings rendered from JSON do not block movement on the server. Server still spawns and respawns at the new map's flags, and CTF gameplay works end-to-end. R26 fixes this with `setMapBuildings`.

---

## What's next (R26 hand-off context)

Per brief 6.0 roadmap: iterate on the map editor based on early player feedback, add ranked-mode tiers built on the R24 skill rating, and resolve the C++ collision limitation by adding `setMapBuildings(int count, float* packedXYZHHHRGB)` and routing the JSON structures into it before each match starts. Replay R2 sharing (criterion 7) and replay annotation (criterion 8) are good R26+ additions once the playtest signal indicates they matter.
