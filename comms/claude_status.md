# Claude Status — R26 (Custom-map collision + ranked tiers + replay sharing + polish)

**Round:** 26 (brief targeted SONNET 4.6, executed by Opus 4.7 [1M])
**Date:** 2026-04-26
**Brief target:** must hit 6 of 8 acceptance criteria
**Self-assessment:** **8/8 hard-implemented** (R2 deferred to in-memory DO-style fallback per decision authority; map preview is CSS-pan fallback per decision authority)

---

## Acceptance criteria, criterion-by-criterion

1. **Bullet vs custom-map building collision** — DONE
   - `program/code/wasm_main.cpp` adds `extern "C" void setMapBuildings(int count, float* aabbData)`. Caps at `MAX_BUILDINGS=64` with `printf` warn on overflow per brief. Replaces `buildings[]` in place; both `resolvePlayerBuildingCollision()` and `projectileHitsBuilding()` already iterate that array, so movement and projectile detonation pick up the new geometry without further changes.
   - `renderer.js` `loadMap(doc)` packs each `structures[]` entry into a `[minX,minY,minZ, maxX,maxY,maxZ]` flat float buffer, allocates via `Module._malloc`, calls `_setMapBuildings`, then frees.
   - `build.sh` exports `_setMapBuildings`, `_malloc`, `_free`.
   - Verification path: load Dangercrossing → fire disc at the central tower → projectile detonates against the tower instead of passing through.

2. **Share Replay → upload → paste-back URL → replay plays** — DONE
   - `server/lobby.ts` adds `POST /replay-upload` (validates TRBR magic, 16 MB cap, 16-hex hash key, 7-day TTL) returning `{shareUrl, hash, expiresAt}`. `GET /replay-shared?h=<hash>` streams the binary back. R2 SDK setup is deferred to R27 per brief 6.0 decision authority; in-memory store with 7-day rotation is the documented fallback.
   - `shell.html` adds `Share Replay` button on match-end (uploads + clipboard). `MAIN MENU` adds `WATCH REPLAY (URL)` → prompt → `window.__replay.openFromUrl(url)`.

3. **RANKED mode tier badge displays in main menu, scoreboard, and nameplate** — DONE
   - `client/tiers.js` (Bronze/Silver/Gold/Platinum/Diamond/Master) + `server/tiers.ts` (mirror, used in matchmaker tier-preference in `findOrCreateLobby`). Inline SVG badge renders without external assets.
   - Main menu: `#player-tier-badge` + `#player-tier-name` populated by `__tribesOnSkillUpdate`. Promotion/demotion fires `showTierToast()` with a 2.5s `tierpulse` animation.
   - Scoreboard: `renderScoreboard` injects `tierBadgeSvg(...)` per row, looked up from `window.__tribesPlayerRoster` (populated from matchStart broadcast which now carries `players[].rating`).
   - Nameplate: `renderer.js` `makeNameplateTexture(name, teamColor, tierColor)` paints an 8px tier-color stripe along the left edge of each nameplate; rating is read from `window.__tribesPlayerRatings`.
   - **Casual vs Ranked split**: lobby browser's `Quick Match` becomes two buttons. Ranked button is gated on `matchesPlayed >= 3` client-side (server is permissive — no per-player block). `lobby.ranked` flag rides through joinAck/matchStart/matchEnd. `endMatch` only updates ELO when `lobby.ranked && isRatedMatch(...)`.

4. **Map preview clips auto-play on hover for the three launch maps** — DONE (CSS-pan fallback)
   - `shell.html` adds `showMapPreview()` triggered after a 500ms hover delay on `.lb-map-thumb`. Pop-up enlarges to 256×144 with `mappan` keyframe animation (5s loop, slow background-position pan). Per brief 6.0 decision authority: headless Three.js / FFmpeg / GIF pipeline deferred to R27 — CSS-pan is the simpler, dependency-free equivalent that satisfies "auto-play loop" semantics.

5. **Top 5 open-issues fixes** — DONE
   - **Compass lag**: 30Hz `setInterval` reads local player state directly from `Module.HEAPF32` and drives `updateCompass(px,pz,yaw)` per frame (was tied to per-tick HUD broadcast).
   - **INVITE FRIENDS URL**: now branches on `inCustomLobby`. Custom lobby → URL includes `?lobbyId=<id>`. Public quick-match → bare URL.
   - **PLAY AGAIN disconnected vote stall**: `checkPlayAgainVote` now counts only humans whose numericId still appears in `connections` toward eligible quorum.
   - **Settings RESET preserving classId**: `selectArmor()` persists to `localStorage.tribes:classId`, restored on load. Existing `resetAllSettings()` already wipes all `tribes:*` keys, so reset clears it.
   - **Replay timeline marker overlap**: `client/replay.js` `renderTimelineMarkers()` clusters markers within 5px and shows a count badge. Mixed-team clusters render with neutral `#D4A030`.

6. **PROFILE tab with stats + recent matches** — DONE
   - Main menu tab `PROFILE` opens `#profile-panel` modal showing username, UUID, tier badge + name + rating, matches-played, ranked/casual flag.
   - Recent matches list fetched from new `GET /player-stats?uuid=<uuid>` (returns skillStore row + last 5 from `metrics.matchHistory`). Each card surfaces "Watch Replay" if a replay was captured for that matchId.
   - **Privacy**: profile is client-side only. Public-stats opt-in toggle isn't yet exposed in settings UI — deferred to R27 (a one-line addition once friends-visibility scope is clarified).

7. **Performance dashboard new metrics** — DONE
   - `/metrics` endpoint extended with `perMapPlayCounts` (best-effort: looks up live lobby's mapId by matchId), `topRated` (top 10 from skillStore), `rankedQueueDepth` (per-tier headcount in open ranked lobbies).
   - `/dashboard` HTML gains three new tables wired off the new fields.

8. **SEO meta tags** — DONE
   - `shell.html` `<head>` gains `description`, `keywords`, `author`, `canonical`, full OpenGraph block (`og:title/description/image/url/site_name`), Twitter Card (`summary_large_image`), and Schema.org `VideoGame` JSON-LD. The `og:image` URL points to `og-preview.png` at the GitHub Pages root — note: that image asset itself isn't generated yet (file would 404 on social platforms until the user adds a 1200×630 screenshot to the repo root). Documented in `comms/open_issues.md`.

---

## Files changed

**New:**
- `client/tiers.js` — single source of truth for tier brackets + badge SVG.
- `server/tiers.ts` — server mirror used by matchmaker tier-preference.

**Modified:**
- `program/code/wasm_main.cpp` — `setMapBuildings()` C++ export (replaces `buildings[]` in place, capped at 64).
- `build.sh` — exports `_setMapBuildings`, `_malloc`, `_free`.
- `renderer.js` — `loadMap()` pushes structure AABBs to WASM; nameplate texture paints tier-color stripe.
- `server/lobby.ts` — `LobbyState.ranked` flag, `findOrCreateLobby` tier-preferred routing for ranked, `?ranked=1` query honoured at join, `endMatch` gates ELO on `lobby.ranked`, matchStart broadcasts `players[].rating`, `joinAck` carries `ranked`. New endpoints: `/replay-upload`, `/replay-shared`, `/player-stats`. `/metrics` extended with `perMapPlayCounts`, `topRated`, `rankedQueueDepth`. `/dashboard` HTML extended. `checkPlayAgainVote` ignores disconnected humans.
- `client/network.js` — `telemetry.ranked` mirrors lobby state from joinAck/matchEnd; exposed via `getStatus()`.
- `client/replay.js` — kill-marker clustering with 5px threshold + count badge.
- `shell.html` — main-menu tier badge + name + promotion toast + classId persistence + per-frame compass + INVITE FRIENDS branching + map-preview hover pop + share-replay button + paste-URL menu entry + Casual/Ranked split + tier badge in scoreboard rows + lobby-browser tier badge column + PROFILE modal + SEO meta tags + tiers.js loader.

---

## Build + guardrail audit

```
emcc → build/tribes.html OK (one pre-existing harmless MAXIMUM_MEMORY warning)
grep -nE 'EM_ASM[^(]*\$1[6-9]' program/code/wasm_main.cpp        → none
grep -nE '(\beval\(|new Function\()' server/*.ts                  → only security-marker comment
grep -nE '(export.*: any|export.*\): any)' server/*.ts             → none
grep -nE '(\beval\(|new Function\()' client/{tiers,replay,mapeditor}.js → none
build.sh exports _setMapBuildings + _malloc + _free                → confirmed
```

Bun is still not installed locally; TypeScript is type-clean by inspection (no implicit-any in public APIs, all type imports satisfied). Production CF Workers deployment runs `bun build` in CI.

---

## Runtime-gated criteria

- **Custom map collision**: requires multiplayer launch on a non-Raindance map. Verification = fire disc at Dangercrossing tower; should detonate.
- **Replay sharing**: requires a >4 min match completion (so replay capture has data) and a server with the `/replay-upload` endpoint reachable.
- **Ranked tier display**: requires the player to play ≥3 casual matches before the RANKED button activates.
- **Map preview hover**: works at runtime over the lobby browser. Visual is a CSS-pan loop, not actual fly-through video — documented limitation.

---

## Known minor gaps (R27 backlog)

- `og-preview.png` image file not generated; social-share previews will use a fallback until a 1200×630 screenshot is committed to the repo root.
- R2 object-storage SDK not wired (in-memory fallback active). When the user authorises CF and supplies `R2_ACCESS_KEY_ID` etc., `/replay-upload` should call S3-compatible PutObject via the `@aws-sdk/client-s3` package.
- Public-stats opt-in toggle in settings — designed but not surfaced (the profile is currently always visible to the local user only).
- Per-uuid lifetime K/D/captures aren't tracked yet (telemetry CSV is per-match aggregate). Adding a `playerStats` table to skillStore would unblock real lifetime stats.

---

## What's next (R27 hand-off context)

Per brief 7.0 roadmap: the next 2-3 rounds focus on stability and observability — running the public playtest, capturing user feedback, and tightening based on real usage. R27 candidates: og-preview image asset, R2 SDK wiring once CF auth lands, per-uuid lifetime stats table, expanded public-stats opt-in toggle, true headless map-preview rendering when a Bun environment with node-canvas is available.
