# Manus Feedback — Round 26: Custom-map Collision + R2 Replay Sharing + Ranked Tiers + Polish (SONNET)

**MODEL:** **SONNET 4.6** (1M context)
**Severity:** Standard
**Type:** Implementation — close R25's known limitation (C++ collision honors custom maps), ship the deferred R2 replay sharing, layer ranked-mode tiers on R24's ELO foundation, finish map preview videos, and clean up post-launch quality-of-life

---

## 1. Context

R25 delivered the entire custom-map system, replay playback engine, and basic map editor in one round (1915 insertions, 6/8 hard-implemented). Two items were appropriately deferred (R2 replay sharing and map preview videos) to keep the critical path moving. One known limitation surfaced: the C++ WASM physics tick still uses hardcoded Raindance building AABBs for collision detection, so on Dangercrossing or Iceridge or any custom map, players visually see the Three.js-rendered buildings but their bullets pass through and their movement ignores them.

R26 closes that gap, ships the two deferred items, layers ranked-mode tiers on top of R24's skill rating, and addresses the small handful of post-launch QoL findings that have surfaced from synthetic playtesting and code review.

---

## 2. Concrete tasks

### 2.1 P0 — WASM custom-map building collision (~30 min)

The C++ WASM module exports a new function `setMapBuildings(int count, float* aabbData)` where `aabbData` is a flat array of `[minX, minY, minZ, maxX, maxY, maxZ]` per building, packed into 6 floats per AABB. The renderer in `renderer.js` already constructs the building meshes from the map JSON; extend its `loadMap(doc)` to also call `Module._setMapBuildings(count, ptrToHeapF32)` after writing the AABB array into a `Module._malloc`-allocated buffer.

The C++ side stores the array in a global `g_mapBuildings: AABB[64]` (max 64 buildings, gracefully truncate above that with a console warning) and replaces the hardcoded Raindance AABB array used in `playerVsBuildingCollide()` and `projectileVsBuildingCollide()`. The first call to `setMapBuildings()` overrides the default; if no call is made (Raindance default), behavior is unchanged.

Verification: load Dangercrossing, fire a disc at a tower, confirm the disc detonates against the tower instead of passing through. Document in `comms/open_issues.md` that this also fixes any latent bullet-pass-through reports.

### 2.2 P0 — R2 replay sharing (~25 min)

Wire up Cloudflare R2 (S3-compatible object storage) for shared replay storage. Server endpoint `POST /replay-upload` accepts the binary replay blob (Content-Type: `application/octet-stream`) and stores it at key `replays/<random16hex>.tribes-replay` with a 30-day lifetime metadata tag. Returns JSON `{shareUrl: "https://<worker>.workers.dev/replay/<hash>"}`.

GET endpoint `/replay/<hash>` streams the binary back. Client extends the match-end "Save Replay" with a "Share Replay" sibling button that uploads and copies the share URL to clipboard. The MAIN MENU's "WATCH REPLAY" extends to also accept a URL paste (textbox in addition to file picker).

R2 setup uses the standard AWS S3 SDK pinned to the latest stable, configured with R2 endpoint and credentials from environment variables `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET`, `R2_ACCOUNT_ID`. Document setup in `server/cloudflare/README.md`. R2 free tier is 10GB storage and 1M Class A operations per month — sufficient for 1000+ replays.

If R2 setup proves more than 25 minutes of work, fall back to storing replays in the lobby Durable Object's storage with a 7-day rotation. Document the trade-off.

### 2.3 P0 — Ranked-mode tiers (~25 min)

Layer a tier system on R24's ELO. Tiers: Bronze (0-999), Silver (1000-1199), Gold (1200-1399), Platinum (1400-1599), Diamond (1600-1799), Master (1800+). Each tier has a distinctive color (CSS variable) and a small badge icon (procedural SVG, no external assets).

Display: the player's tier badge appears next to their name on the main menu, in the in-match scoreboard, and on nameplates above their head in-game. The end-of-match overlay shows tier promotions/demotions with a brief animation — "Promoted to Gold!" with a 2-second pulse highlight.

Mode segregation: the lobby browser splits Quick Match into "CASUAL" (no rating change, anyone can join) and "RANKED" (rating updates apply, requires player has played ≥3 casual matches first as a sanity gate). Casual matches don't update ratings even if the rated-match criteria are met — explicit opt-in required for rating changes via choosing the RANKED button.

Tier-restricted matchmaking: the existing 200-point window from R24 still applies, but additionally for ranked mode, the matchmaker prefers same-tier matches when the queue size allows. Cross-tier matches still happen if no same-tier opponent is available within 30 seconds of queueing.

### 2.4 P1 — Map preview videos (deferred from R25) (~20 min)

When a player hovers over a lobby in the lobby browser for >500ms, the lobby's map thumbnail enlarges and a 5-second autoplay loop renders. Implementation: precompute these videos at map publish time. For each launch map, run a script `tools/genpreview.ts` that loads the map in a headless Three.js context (using the `three` npm package + `node-canvas` or similar), captures 150 frames at 30 FPS along a predefined fly-through camera path, encodes via FFmpeg to H.264 mp4 at 480×270 ~150KB per clip.

Pre-rendered clips ship in `client/maps/preview/<mapId>.mp4`. The lobby browser hover-preview reads from `/maps/<mapId>.mp4` (served by the static file CDN, not the worker). Custom user-uploaded maps don't get auto-generated previews in R26 — that's an R27+ scope item.

If headless Three.js rendering is too brittle (Node + Three.js + node-canvas is a known-fragile stack), generate the previews as animated GIFs from a top-down 2D rendering using the same path the replay engine uses for its top-down view. Smaller (~80KB) and dead-simple to produce. Acceptable trade-off.

### 2.5 P1 — Open-issues triage + fix-up (~25 min)

Several low-severity items have accumulated in `comms/open_issues.md` (or similar). Triage and fix the top 5 by user-impact:

1. The compass UI element shows "N/NE/E/SE/S/SW/W/NW" but the player's actual facing direction is reflected with a small lag of ~3 frames due to the snapshot interpolation. Read the local prediction state for the compass (no network round-trip), syncing only the corrections from server snapshots.

2. The "INVITE FRIENDS" button copies the wrong URL when the player is in a custom lobby vs the public quick-match queue. Fix: when in a custom lobby, the URL includes `?lobby=<id>`; when in quick-match, just the bare URL.

3. The match-end overlay's "PLAY AGAIN" vote sometimes stalls if a player has disconnected. Server: ignore disconnected players in the vote-quorum calculation.

4. The settings modal's "RESET" button doesn't restore the per-class loadout selection (Light/Medium/Heavy). Fix: include `tribes:classId` in the keys cleared by reset.

5. The replay timeline's kill-event markers can overlap when many kills happen within ~1 tick of each other. Cluster-render: when two markers are within 5px on the timeline, show a single marker with a count indicator ("3 kills").

If the open-issues list is shorter than 5 items, fix what's there and use the remaining time to write a quick `CONTRIBUTING.md` covering how a player could submit a custom map for inclusion in the official map registry.

### 2.6 P2 — Stats & profile page (~20 min)

The main menu adds a "PROFILE" tab next to the existing tabs. The profile page shows the player's username (set in settings), their UUID, their current tier badge + rating, lifetime stats from the per-match telemetry CSV (total matches, K/D, captures, win rate, time played, favorite class, favorite map), and a recent-matches list with per-match summary cards (5 most recent).

Click a recent-match card to open the replay (if the replay was saved or shared). The profile is fully client-side with no new server endpoints — the data is queried from the existing `/maps-list` and `/replay-list` endpoints plus a new `/player-stats?uuid=<uuid>` endpoint that aggregates from the telemetry CSV.

Privacy: profiles are only visible to the player themselves and to friends in the friends list (R24). Public-stats opt-in toggle in settings.

### 2.7 P2 — Performance dashboard (~15 min)

The existing `/dashboard` from R21 currently shows real-time CCU and tick latency. Extend with: per-region average ping (assuming CF Workers edge latency hints), per-map play counts last 24h, top 10 players by rating, current ranked queue depth per tier. Token-auth gate stays as configured in R21.

This is operationally useful for monitoring health during the public playtest phase — lets you see at a glance if the server's healthy and players are engaging.

### 2.8 P3 — Discoverability: web crawler/SEO meta tags (~10 min)

Add proper SEO meta tags to `shell.html` and `index.html`: `<meta name="description">`, OpenGraph tags for social-share previews (Twitter/Discord/LinkedIn), Canonical URL, Schema.org VideoGame markup. Target: when someone shares the URL on Twitter/Discord, the preview shows a screenshot of the game with a compelling description, not the raw URL.

Bonus: register the project at `https://search.google.com/search-console` (manual user step, document in README) so Google indexes the public playtest URL within 24-48 hours.

---

## 3. Acceptance criteria (must hit 6 of 8)

The first six lines below capture what must function end-to-end. The last two are nice-to-have polish.

A bullet fired at a custom-map building (Dangercrossing tower, Iceridge bunker) detonates against the building rather than passing through. The match-end "Share Replay" button uploads the binary file to R2, returns a share URL, and pasting that URL into the main menu's "WATCH REPLAY" successfully retrieves and plays the replay. A player choosing RANKED mode in the lobby browser has their rating updated after each match and the appropriate tier badge displays consistently in all three locations (main menu, scoreboard, in-game nameplate). Map preview clips auto-play on hover for the three launch maps. The top 5 open-issues fixes verifiably function as described. The PROFILE tab shows the player's lifetime stats and at least 1 recent-match card. The performance dashboard shows the new metrics. SEO meta tags pass a basic Twitter Card validator preview.

---

## 4. Compile/grep guardrails

Standard guardrails: no `EM_ASM \$1[6-9]`, all new server files in `server/*.ts` typed without `:any`, all new client files as ES modules, dependencies pinned. R2 client should use the standard AWS S3 SDK pinned version. Bun build clean. The new `setMapBuildings()` C++ export must not be called with count > 64 — graceful truncation with `printf` warning.

---

## 5. Time budget

A reasonable Sonnet round at 150-180 minutes covers all P0 and P1 items. The C++ collision wiring is small but precise; the R2 setup is mostly boilerplate; ranked tiers are mostly UI-side. Map previews are the biggest unknown — fall back to GIFs if headless 3D doesn't pan out. Stats and dashboard are mostly client-side aggregation with one new endpoint each.

---

## 6. Decision authority for ambiguities

If R2 SDK setup proves brittle on Cloudflare Workers (the R2 SDK has occasionally had Workers-runtime compatibility issues), fall back to storing replays in the lobby DO storage with 7-day rotation; document this in `comms/open_issues.md` for R27 to revisit. If the headless Three.js stack for map preview videos proves brittle, ship animated GIFs from the top-down 2D replay-engine view instead — smaller and simpler, accept the lower visual fidelity. If the ranked queue is empty for a tier and matchmaking would block forever, drop the tier-preference within 30 seconds of queueing and accept a cross-tier match. If the player's tier demotion would put them below Bronze, clamp at Bronze and note "rating floor reached" in the match-end overlay. If `setMapBuildings()` reveals collision bugs in non-Raindance maps (e.g., AABBs misaligned with mesh visuals), document the issue in `comms/open_issues.md` and fix in R27 — don't block R26.

---

## 7. Roadmap context

R26 closes the loop on R25's deferred items and elevates the matchmaking and social experience to ranked-mode-quality. After R26, the player experience is feature-complete for a public v1.0. R27+ enters mod-loader, tournament/event infrastructure, and content-creation tools that distinguish a sustainable hobby project from a one-off demo.

The next 2-3 rounds (R26-R28) should focus exclusively on stability and observability — running the public playtest, capturing user feedback, fixing the issues that surface, and tightening the experience based on real usage. R28+ can resume feature additions once the foundation is proven.
