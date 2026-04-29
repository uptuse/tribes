# Tribes Project — Lessons Learned

Read this file every time you're debugging or problem-solving. These are hard-won fixes.

---

## 1. Cache Bust Mismatch (R32.138)
**Issue:** All changes to `renderer_characters.js` were invisible — ski board, jet flames, foot offset, model rotation — none showed up.
**Root cause:** The `?v=XXX` cache bust parameter in the `import` statement in `renderer.js` was stuck at `?v=128` while the file was on version 137. Browser cached the old module.
**Fix:** Always verify the actual cache bust value in `renderer.js` before pushing. The sed replacement must match the CURRENT value, not what you think it is.
**Rule:** After editing `renderer_characters.js`, always `grep 'renderer_characters' renderer.js` to confirm the cache bust updated.

---

## 2. Model-Local vs World Scale (R32.140)
**Issue:** Ski board rendered as a 30m × 80m blue plane across the entire map. Flame cones were positioned 100 units away from the character.
**Root cause:** Meshes added as children of the GLB scene root (which is scale 1.0), but dimensions were written in centimeters (assuming the armature's 0.01 scale applied). The armature scale only affects bones/skinned meshes, not siblings added to the scene root.
**Fix:** Use world-scale meters for any mesh added to the model root: `PlaneGeometry(0.35, 0.9)` not `PlaneGeometry(30, 80)`. Positions in meters, not centimeters.
**Rule:** When adding child meshes to a GLB model, always check what coordinate space the parent is in. The armature's 0.01 scale does NOT propagate to siblings of the armature.

---

## 3. Terrain Poking Through Buildings (R32.139 → R32.140)
**Issue:** Terrain mesh visibly poked through building entrances and lower doorways. Buildings are hobbit-holed into hillsides.
**Root cause:** The heightmap terrain was never carved out under building footprints. Original Tribes sculpted terrain around buildings.
**First attempt (R32.139):** Used WASM building AABBs — too coarse, didn't match actual geometry.
**Fix (R32.140):** Use `interiorShapesGroup` — the actual placed interior meshes. Compute world-space bounding box per shape, depress terrain vertices within XZ footprint + 3m margin below shape's min Y.
**Rule:** Always use the tightest available geometry for spatial queries. Prefer actual mesh bounds over AABB approximations.

---

## 4. Particle System Architecture (R32.134 → R32.136)
**Issue:** Ski particles created in `renderer_characters.js` were never visible, despite being added to the scene.
**Root cause:** Multiple problems: `emitCount = Math.floor(speed / 5)` = 0 at low speeds (no particles emitted), different shader architecture from the proven jet exhaust system, cache bust stale (see #1).
**Fix:** Clone the working jet exhaust system in `renderer.js` — same pool pattern, same shader, same emit loop. Just change color and emission source.
**Rule:** **Clone what works.** When adding a system similar to an existing one, duplicate the working code and modify it. Don't reinvent in a different file with a different pattern.

---

## 5. Dual Physics Convention (R32.130)
**Issue:** Character model sinks through building floors in 3P view.
**Root cause:** Two physics systems write `playerView[o+1]` with different conventions:
- WASM (terrain): `playerY = terrainH + 1.8` (capsule offset baked in)
- Rapier (buildings): `playerY = floorH` (raw floor height, no offset)
The grounding code always subtracted 1.8, correct for terrain but wrong for buildings.
**Fix:** Expose `window._rapierGrounded` from the Rapier collision step. When Rapier-grounded, use `playerY` directly (no offset). When on terrain, subtract 1.8.
**Status:** Partially working — Rapier cuboid colliders don't provide interior floor collision yet. Full fix requires trimesh colliders for interior geometry.

---

## Template for new entries:
```
## N. Short Title (RXXXX)
**Issue:** What was observed
**Root cause:** Why it happened
**Fix:** What was done
**Rule:** What to always do going forward
```


---

## 6. Night Ambient Color Typo (R32.153 audit)
**Issue:** Night terrain is lit with garbage color — wrong RGB values at night.
**Root cause:** `0x3040608` (7 hex digits) should be `0x304060` (6 hex digits). JavaScript parses `0x3040608` as `0x03040608`, which shifts all color channels by 4 bits.
**Fix:** Change to `0x304060` at renderer.js L596.
**Rule:** Always verify hex color literals are exactly 6 digits (3 bytes). JavaScript won't warn you — it silently interprets the wrong value.

---

## 7. HDRI/DayNight Exposure Race (R32.153 audit)
**Issue:** Exposure/environment intensity flickers non-deterministically — sometimes the scene is too bright at night.
**Root cause:** The HDRI load callback sets `renderer.toneMappingExposure = 1.15` and `scene.environmentIntensity = 1.45`. DayNight.update() sets different values based on time of day. Whichever runs last wins. On slow connections, HDRI loads after DayNight has been running, overwriting the exposure.
**Fix:** Remove exposure/environmentIntensity writes from the HDRI callback. Let DayNight own those values exclusively.
**Rule:** Never have two systems write the same uniform/property. Pick one owner.

---

## 8. Remote Players Always Hidden (R32.153 audit)
**Issue:** ALL non-local players are invisible. Multiplayer character rendering appears broken.
**Root cause:** renderer.js L3777: `if (i !== localIdx) { mesh.visible = false; continue; }` — explicitly hides every remote player. This was a single-player test hack that shipped.
**Fix:** Remove the early-continue for remote players. Implement proper visibility (LOD, frustum culling) instead.
**Rule:** Never ship test hacks. If you need a debug flag, use a URL parameter (`?single=true`), not a hardcoded early-return.

---

## 9. tribes.js Is Generated Code (R32.153 audit)
**Issue:** Audit plan incorrectly described tribes.js as containing the game state machine, HUD, settings, and input handling.
**Root cause:** tribes.js is 100% Emscripten-generated WASM bootstrap glue. The actual game bridge (~4,500 lines) lives in index.html.
**Fix:** Updated audit plan. Documented in system-map.md.
**Rule:** Always read the first 50 lines of a file before describing what it does. File names can mislead.

---

## 10. Rapier Dual-Physics Desync (R32.153 audit)
**Issue:** Players jitter at building doorways, sink through floors intermittently.
**Root cause:** WASM tick() moves the player, then Rapier resolves collisions and writes back a corrected position — but WASM's velocity is never updated to match. Next frame, WASM integrates from the corrected position with the old (wrong) velocity, immediately re-penetrating.
**Fix:** Refactor Rapier to collision query oracle (shape casts only). WASM owns all movement and velocity. Rapier reports contacts, not positions.
**Rule:** Never have two physics systems disagree about where something is. One system writes position, others query.

---

## 11. Telemetry Reads Wrong Stride Offsets (R32.153 audit)
**Issue:** F3 telemetry HUD displays wrong speed values.
**Root cause:** renderer_polish.js reads `playerView[o+4]` as velocity X, but offset 4 is actually Yaw. Velocity X is at offset 6. Wrong since R32.7.
**Fix:** Change offsets 4/5/6 to 6/7/8 in `_tickTelemetry()`. Better: import named constants from a shared module.
**Rule:** Never use magic numbers for struct offsets. Create a shared constants file used by all consumers.

---

## 12. Flag Z Dropped in Wire Decode (R32.153 audit)
**Issue:** Flag position Z is always 0 in multiplayer — flags render at ground level regardless of actual 3D position.
**Root cause:** client/wire.js flag decode hardcodes Z to 0. The binary format only transmits 2D flag position (X, Z in world), dropping the Y component.
**Fix:** Add flag Y to wire format, or reconstruct Y from terrain height at (X, Z) on the client.
**Rule:** Every spatial entity needs full 3D position. If bandwidth is tight, reconstruct from terrain, but never silently drop a coordinate.

---

## 13. network.js start() Not Idempotent (R32.153 audit)
**Issue:** Calling `start()` twice creates a ghost WebSocket alongside the active one.
**Root cause:** No guard against double-call. Each call opens a new WebSocket without closing the previous.
**Fix:** Add `if (_ws && _ws.readyState !== WebSocket.CLOSED) return;` guard at top of `start()`.
**Rule:** Network connection functions must be idempotent. Guard against double-init.

---

## 14. Ping = Clock Offset, Not RTT (R32.153 audit)
**Issue:** Displayed ping value is meaningless — shows client/server clock drift, not actual round-trip time.
**Root cause:** `ping = msg.serverTs - msg.clientTs`. Server and client clocks aren't synchronized, so this computes the time zone difference, not latency.
**Fix:** Use proper RTT measurement: `rtt = now - sentTs` where sentTs is recorded when the ping was sent.
**Rule:** RTT requires round-trip measurement from the same clock. Never subtract timestamps from different machines.

---

## 15. Team Color INDEX Inversion (R32.153 audit)
**Issue:** Minimap and command map show team 0 as blue, but every other module shows team 0 as red. Five different hex values for "red" exist across the codebase.
**Root cause:** No single source of truth for team→color mapping. Each module independently defines its own TEAM_COLORS array, and minimap/command_map have them swapped. Plus renderer_palette.js, renderer_combat_fx.js, renderer_characters.js, and renderer.js all use different hex values for the same team color.
**Fix:** Create `client/team_config.js` with a canonical 4-tribe definition and a single team→color mapping. All modules import from this file.
**Rule:** Color constants for gameplay-meaningful values (teams, factions, damage types) must come from ONE shared source. Never define team colors locally in a module.

---

## 16. Disabled Rain Still Allocates Unconditionally (R32.153 audit)
**Issue:** Disabled weather systems still allocate GPU resources at init time. Rain allocates particle buffers even when weather is off. The grass ring system allocates ~213MB GPU memory if accidentally enabled.
**Root cause:** `initRain()` and `initGrassRing()` are called unconditionally during `start()`. They allocate Float32Arrays, BufferGeometries, and ShaderMaterials regardless of whether the feature is active. The disable flag only prevents the update loop, not the allocation.
**Fix:** Guard allocation behind the feature flag, or better: delete disabled systems entirely and restore from git history if needed later.
**Rule:** Disabled code should allocate ZERO resources. If a feature is off, its init should be skipped entirely. Mark with `// @disabled YYYY-MM-DD reason` and delete after 30 days.

---

## 17. Six Particle Systems Instead of One Parameterized (R32.153 audit)
**Issue:** The codebase has 6 separate particle implementations (jet exhaust, ski spray, dust, rain, night fairies, explosions) with duplicated shader code, pool logic, and update loops.
**Root cause:** Each particle system was built independently at different times without consulting the existing implementations. Four of them (jet, ski, dust, rain) share identical architecture but use different variable names and slightly different parameters.
**Fix:** Merge systems 1–4 into a single parameterized `renderer_particles.js` that takes config (color, lifetime, gravity, emission shape). Keep explosions and fairies separate — they're architecturally distinct.
**Rule:** Before building ANY new visual system, grep for existing implementations that do the same thing. If one exists, clone and parameterize it. Never build a 2nd version of the same pattern.

---

## 18. 82 window.* Globals as Inter-Module Communication (R32.153 audit)
**Issue:** 82 globals on `window.*` serve as the only inter-module communication layer. No import graph, no compile-time checking. Any module can read/write any global at any time.
**Root cause:** Organic growth from a single-file prototype. Modules were extracted into IIFEs that communicate via window globals because ES module migration was never done. 37 are API facades, 12 are WASM bridge, 20 are shared data, 8 are debug, 3 are config, 2 are orphaned.
**Fix:** IIFE→ES module migration. Replace `window.ModuleName = {}` with `export` / `import`. Priority: rapier first (10 call sites), then combat_fx, minimap, etc.
**Rule:** New modules MUST use ES `import`/`export`. Never add new `window.*` globals. When touching an IIFE module, migrate it to ES as part of the change.

---

## 19. GPU Memory Leaks — No dispose() Lifecycle (R32.153 audit)
**Issue:** Only 2 of 10 modules have `dispose()` methods. `loadMap()` removes building meshes from the scene but doesn't dispose geometry/materials (~40MB leaked per map change). `applyQuality()` creates a new EffectComposer without disposing the old one (~40MB per quality change). 256 identical SphereGeometries for projectiles prevent batching.
**Root cause:** No module lifecycle contract. Modules have `init()` and `update()` but no `dispose()`. Three.js requires explicit cleanup of GPU resources — `scene.remove()` alone doesn't free GPU memory.
**Fix:** Add mandatory `dispose()` to every module. `loadMap()` must traverse and dispose geometry+materials. `applyQuality()` must dispose the old composer. Share one SphereGeometry across all projectiles.
**Rule:** Every module that creates Three.js objects MUST have a `dispose()` that frees geometry, materials, textures, and render targets. Call dispose before re-init.

---

## 20. No Test Harnesses for Audit Fixes (R32.153 audit)
**Issue:** The audit identified 16+ concrete fixes (telemetry offsets, network idempotency, team color mapping, ping measurement, etc.) but no test infrastructure exists to verify fixes or prevent regressions.
**Root cause:** Rapid single-developer prototyping phase prioritized shipping features over testing infrastructure. No unit tests, no integration tests, no visual regression tests.
**Fix:** For each structural fix, add at minimum a console assertion or a `?test=true` URL-parameter-gated self-test that validates the invariant on boot.
**Rule:** Every bug fix should include a way to verify it worked. At minimum, add a runtime assertion that would catch the original bug if it regressed. Prefer `console.assert()` for invariants that should always hold.
