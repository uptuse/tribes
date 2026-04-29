# Phase 4 — T3+T4 Module Audit (Run 1)

*Adversarial Convergence Review — 2026-04-29*
*Expert Panel: Barrett (UI/HUD lead), Muratori, ryg, Ive. Carmack added for sky/command_map.*

---

## Module 1: renderer_combat_fx.js (301 lines)

### Review Level: Pass 1 + Pass 4 + Pass 5 + Pass 6

### Pass 1 — Break It

**Saboteur:**
- `_getFireEndpoints()` allocates two `new THREE.Vector3()` every call. At 10 shots/sec × 4 tracers that's 80 allocations/sec feeding the GC. Not a crash but a GC stutter source in intense firefights.
- `_buildMuzzleSprite` reads `window._weaponMuzzleAnchor` at init time. If CombatFX.init() is called before renderer.js creates the anchor, the fallback `weaponHand.add()` path runs. If the anchor is created LATER, the flash stays parented to the old parent. No re-parenting path exists.
- `flashHit()` stores a timer on `t._r3213Timer` (DOM element). If `#hit-tick` is removed/replaced by HUD update, the timer reference leaks and subsequent clears fail silently.
- Tracer `line.geometry.computeBoundingSphere()` called once at init with zero positions, producing a degenerate bounding sphere. Three.js may skip frustum culling (frustumCulled=false saves it) but the geometry metadata is wrong.

**Wiring Inspector:**
- `CombatFX.init(scene, camera, weaponHand, THREE)` — takes THREE as a parameter but THREE is a module-scope import elsewhere. This is the IIFE pattern passing THREE in because it can't import. Works, but awkward.
- `window._tribesAimPoint3P` read at fire-time: if this object is stale (set from a previous frame), tracer end-point is one frame behind. In practice invisible at 60fps.

**Cartographer:**
- No `dispose()` method. Muzzle sprite, light, and all tracers leak GPU resources if CombatFX is torn down. No cleanup path.
- No team color for tracers — always brass/gold. When 4 tribes exist, you can't tell who's shooting.
- No multi-weapon support — muzzle flash is identical for disc launcher, mortar, chaingun. A mortar should have a bigger flash.

### Pass 4 — System-Level Review

**Dependency Map:**
```
renderer_combat_fx.js (IIFE)
├── READS: window._weaponMuzzleAnchor (Object3D from renderer.js L3329)
│          window._tribesAimPoint3P (Object from renderer.js L4212)
├── WRITES: window.CombatFX (API facade)
│           window.CombatFX.init, .fire, .update, .flashHit
├── CALLED BY: renderer.js (dynamic import L3688, .fire() on weapon fire, .update(dt) per frame)
├── DOM: reads #hit-tick, adds/removes CSS classes r3213-hit, r3213-kill
└── THREE: passed as parameter to init()
```

**Interface Contract:**
- `init(scene, camera, weaponHand, THREE)` — one-time setup
- `fire()` — trigger on each weapon discharge (caller rate-limits)
- `update(dt)` — per-frame fade driver
- `flashHit(strong)` — crosshair hit feedback

**2-Team Check:** Uses `0xffd070` (brass) for all tracers regardless of team. **Needs 4-tribe tracer colors.**

**window.* Globals:**
| Global | Category | Migration |
|---|---|---|
| `window.CombatFX` | API Facade | ES module export when migrated |

**Contradiction Flags:**
- IIFE pattern (legacy). Should be ES module per dual-module-system decision.
- Allocates Vector3 per-fire rather than pooling (contradicts Pattern #1 particle pooling).

**Should This Module Exist?** YES.
- Clean single-responsibility: weapon fire visual feedback
- Well-scoped: muzzle flash + tracer + hit crosshair
- Low coupling: only reads 2 window globals

**Recommendation: KEEP. Migrate IIFE → ES module. Pool Vector3s. Add dispose(). Add per-weapon flash variants. Add 4-tribe tracer colors.**

### Pass 5 — AI Rules

```javascript
// @ai-contract renderer_combat_fx.js
// PURPOSE: Weapon fire visual feedback (muzzle flash, tracers, crosshair hit)
// SERVES: Scale (combat reads at distance), Aliveness (kinetic feel)
// DEPENDS_ON: window._weaponMuzzleAnchor (renderer.js), window._tribesAimPoint3P (renderer.js)
// EXPOSES: window.CombatFX { init, fire, update, flashHit }
// PATTERN: IIFE + window.* (legacy — migrate to ES module)
// PERF_BUDGET: 1 draw call (muzzle sprite) + 0-4 draw calls (tracer lines) = max 5 per frame
// QUALITY_TIERS: low=flash only (no tracers), mid+=all
// NEVER: allocate Vector3 per fire() call — pool them
// ALWAYS: add dispose() if adding GPU resources
// @end-ai-contract
```

### Pass 6 — Design Intent (Ive)

> **Ive:** "This module serves two Core Feelings directly. **Scale** — you see tracers from across the map, which tells you where combat is happening and gives the world a sense of activity. **Aliveness** — the muzzle flash, the hit confirmation flash, these are the micro-moments that make combat feel visceral. But the flash is weapon-agnostic — a mortar and a chaingun produce the same 0.45-unit plane? That's a missed opportunity. The flash should communicate the weapon's character. A mortar flash should be massive and orange. A chaingun should be rapid, small, and white-hot. The tracer being brass-gold for everyone is also a problem — when four tribes are fighting, you need to read the battlefield at a glance. Tracer color = tribe color. That's free information density."

**Core Feelings Served:** Scale ✅, Aliveness ✅
**Verdict:** Keep. Enhance per-weapon personality and 4-tribe coloring.

---

## Module 2: renderer_minimap.js (348 lines)

### Review Level: Pass 1 + Pass 4 + Pass 5 + Pass 6

### Pass 1 — Break It

**Saboteur:**
- **2-team hardcoding throughout:**
  - `TEAM_COLORS = ['#3FA8FF', '#FF6A4A']` — only 2 entries. Team index 2 or 3 → `undefined` → rendered as invisible dot.
  - `FLAG_COLORS = ['#4488FF', '#FF5533']` — only 2 flags.
  - Flag loop: `for (let i = 0; i < 2; i++)` — hard-caps to 2 flags.
  - Player dot: `TEAM_COLORS[pTeam]` with no fallback to a default color for pTeam > 1.
- `w2r()` creates a new object `{ x, y }` on every call. In a 64-player game with buildings, that's 64 + ~40 buildings = ~100 allocations per frame × 60fps = 6,000/sec. GC pressure.
- No bounds-check on `localIdx`: if `S.hooks.getLocalIdx()` returns -1 or >= count before the explicit check, the `lo = localIdx * stride` read at `view[lo + 0]` could read garbage.
- Canvas created at fixed 72px CSS radius. On 4K displays with dpr=2, the physical canvas is 288px — acceptable. But no way to resize the radar for accessibility or preference.

**Wiring Inspector:**
- `S.hooks.getPlayerView()` returns `{view, stride, count}`. The minimap assumes `view[o + 17]` is "carrying flag" but the system map shows offset 17 is NOT documented in the stride layout (offsets documented: 0-6, 11-15, 18, 20). **Potential misread.**
- `S.hooks.getBuildings()` expects `b.mesh.userData.halfExtents` — this is set by renderer.js building creation but NOT by renderer_buildings.js (the new ES module). If buildings switch to the new module, minimap gets no half-extents and defaults to 5m squares.
- Building footprint rotation not accounted for — footprints are always axis-aligned rectangles even if the building is rotated.

**Cartographer:**
- No phase-reactive behavior. During Dense Fog phase, the minimap should arguably show reduced range or fog overlay. Currently shows full 200m regardless.
- No vehicle support. Vehicles should appear as distinct symbols.
- No projectile display (some tactical maps show mortar arcs).

### Pass 4 — System-Level Review

**Dependency Map:**
```
renderer_minimap.js (IIFE)
├── READS: hooks.getPlayerView(), hooks.getLocalIdx(), hooks.getFlagView(), hooks.getBuildings()
│          (all injected via init(hooks) from renderer.js)
│          document.getElementById('hud')
├── WRITES: window.Minimap { init, update }
├── DOM: creates #minimap-canvas, appends to #hud or body
└── CALLED BY: renderer.js (Minimap.init(hooks), Minimap.update() per frame)
```

**2-Team Check:** ❌ FAILS. Hard 2-team everywhere.

**window.* Globals:**
| Global | Category | Migration |
|---|---|---|
| `window.Minimap` | API Facade | ES module export |

**Should This Module Exist?** YES.
- Radar HUD is a core Tribes feature
- Self-contained Canvas 2D rendering — no Three.js coupling
- Clean hook-based data injection

**Recommendation: KEEP. Fix 2→4 team support. Pool w2r() allocations. Add phase-reactive range/fog. Add vehicle symbols.**

### Pass 5 — AI Rules

```javascript
// @ai-contract renderer_minimap.js
// PURPOSE: Circular radar HUD showing players, flags, buildings in 200m range
// SERVES: Scale (sense of where you are on the vast map), Belonging (see your team)
// DEPENDS_ON: hooks from renderer.js (playerView, localIdx, flagView, buildings)
// EXPOSES: window.Minimap { init, update }
// PATTERN: IIFE + window.* (legacy — migrate to ES module)
// PERF_BUDGET: 1 Canvas 2D drawImage per frame, ~100 arc/fillRect calls
// QUALITY_TIERS: low=off or reduced update rate, mid+=every frame
// NEVER: hardcode team count — use TEAM_COLORS array sized to actual tribe count
// ALWAYS: validate localIdx bounds before reading playerView
// @end-ai-contract
```

### Pass 6 — Design Intent (Ive)

> **Ive:** "The minimap is one of the strongest **Belonging** tools in the game. When you glance at it and see four team-colored clusters of dots, you instantly know where your tribe is, where the enemy is, and where the fight is happening. It tells you 'your team is over there, they need you.' That's the core feeling. But right now it only works for 2 teams, which means it's fundamentally broken for the game we're building. The 200m fixed range also doesn't adapt to the phase — during fog, should the minimap show fog? I'd argue no — the minimap is abstract, tactical information. It should stay clear. But range could shrink during fog to match sensor range limitations. That would reinforce the Adaptation feeling. This module absolutely exists for good reason."

**Core Feelings Served:** Belonging ✅, Scale ✅, (potential) Adaptation
**Verdict:** Keep. 4-tribe colors are critical-path.

---

## Module 3: renderer_sky_custom.js (396 lines)

### Review Level: Full 6-pass (>200 lines, render pipeline critical, Carmack added)

### Pass 1 — Break It

**Saboteur:**
- Sky dome radius is 950, cloud dome 900, stars 880. Camera position is copied each frame. If camera moves 1000+ units from origin (possible on large maps), floating-point precision in the shader degrades — the sky dome center tracks the camera but the vertex positions use `modelMatrix * vec4(position, 1.0)` which can lose precision at large world-space offsets.
- `_starOpacity += (starTarget - _starOpacity) * 0.05` — this is frame-rate dependent. At 30fps the lerp is slower than at 60fps. Stars fade differently on slow machines.
- `removeOldSky()` disposes material and geometry but doesn't null out the references. If called while another module still holds a reference, the disposed objects become use-after-free zombies.
- Moon crater positions are hardcoded pixel offsets (`cx - 2.0, cy + 1.5` etc.) — these look correct at the shader's scale but are magic numbers with no documentation.

**Wiring Inspector:**
- ES module: `import * as THREE from './vendor/three/r170/three.module.js'` — hardcoded path with no cache bust. If Three.js is updated, this import must be manually changed.
- `updateCustomSky(t, dayMix, sunDir, cameraPos)` — called from renderer.js. The `sunDir` parameter must be normalized. If renderer.js passes an un-normalized vector, sun disc calculations break silently (smoothstep thresholds assume unit vector dot products).
- Cloud drift: `cloudUv += uTime * vec2(0.008, 0.003)` — uTime grows without bound. After ~7 hours (25000 seconds), floating-point precision in the shader causes visible UV jitter/swimming. Should modulo time.

**Cartographer:**
- No phase-reactive sky. The game design doc specifies each phase has its own atmospheric personality. Currently the sky only responds to day/night cycle (dayMix). No fog, no storm, no lava glow in the sky.
- No quality tier behavior. Sky always renders all three layers (dome + clouds + stars) regardless of GPU capability.
- No dispose() — sky dome, cloud dome, and star field leak if removed.

### Pass 2 — Challenge Architecture (Independent Reviews)

**Carmack:** "The shader is reasonable for a browser game. Three nested spheres at different radii tracking the camera — that works. The moon crater approach is clever — projecting into moon-face local space and doing distance checks. But the cloud noise is computed per-fragment with 3 octaves of simplex noise. That's expensive on mobile/integrated GPUs. Should have a bake option or a quality tier that disables clouds. Also, `gl_Position = pos.xyww` for infinite projection is correct but the depth test interaction with terrain needs verification — if terrain ever reaches the sky dome's depth, you get z-fighting."

**ryg:** "Three draw calls for the sky — dome, clouds, stars. Stars are Points with 4000 vertices — fine. But the cloud sphere is full hemisphere geometry rendered with a transparent shader and discard. That's a fragment-heavy pass. At 1080p that's up to 2M fragments testing noise. On Low quality this should just not render. The star fade being frame-rate dependent (`*= 0.05`) is a classic bug — needs `1 - exp(-dt / tau)` like Pattern #14."

**Ive:** "The sky is one of the most important visual elements. It sets the mood for the entire game. A Tribes player spends half their time in the air — the sky IS the environment. The three-layer approach (gradient dome + clouds + stars) is architecturally sound. But it needs phase reactivity. During lava flood, the sky should glow orange. During fog, clouds should thicken and lower. During mech wave, the sky should darken. Right now it's just a day/night cycle. That's not enough for a phase-based game."

### Pass 3 — Debate to Consensus

**Carmack:** "Cloud noise performance — ryg's right. Add a quality tier gate. Low = no clouds. Medium = 1 octave. High = 3 octaves."

**ryg:** "Agreed. Also the star fade rate — easy fix: `const k = 1 - Math.exp(-dt / 0.3)` instead of `0.05`. Needs dt passed into updateCustomSky or computed internally."

**Carmack:** "The uTime unbounded growth is a real problem. In a long play session the cloud UVs will swim. Modulo by a large period — `uTime % 10000.0` would give 10000 seconds before repeat. Invisible repeat on noise."

**Ive:** "Phase reactivity is the big architectural gap. The function signature should accept phase state: `updateCustomSky(t, dayMix, sunDir, cameraPos, phaseState)`. Phase state drives cloud density, horizon color, emissive sky glow. This is the Adaptation feeling — the sky TELLS you the phase changed before you even read the HUD."

**Consensus:**
1. Add dt parameter or compute internally for frame-rate-independent star fade
2. Modulo uTime to prevent UV precision loss
3. Add quality tiers (Low: dome only, Medium: dome + clouds 1 octave, High: all 3 layers)
4. Add phase state input (deferred to phase system implementation)
5. Add dispose() method

### Pass 4 — System-Level Review

**Dependency Map:**
```
renderer_sky_custom.js (ES module)
├── IMPORTS: three.module.js (hardcoded vendor path)
├── READS: nothing from window.* (receives all data as function parameters)
├── WRITES: nothing to window.*
├── EXPORTS: initCustomSky(scene), updateCustomSky(t, dayMix, sunDir, cameraPos), removeOldSky(scene, oldSky)
└── CALLED BY: renderer.js (import at top, called in start() and render loop)
```

**2-Team Check:** ✅ No team references. Sky is team-agnostic.

**window.* Globals:** None. Clean ES module. 👍

**Should This Module Exist?** YES.
- Sky is a first-class visual system
- Clean module boundaries, no global state
- ES module (canonical pattern)
- Well-isolated: receives all input via parameters

**Recommendation: KEEP. Add quality tiers, fix frame-rate-dependent fade, modulo uTime, prepare for phase input.**

### Pass 5 — AI Rules

```javascript
// @ai-contract renderer_sky_custom.js
// PURPOSE: Procedural sky system (gradient dome + twinkling stars + simplex-noise clouds)
// SERVES: Scale (vast sky, you're always looking at it while skiing/jetting), Aliveness (day/night, clouds drift)
// DEPENDS_ON: three.module.js (hardcoded vendor path)
// EXPOSES: ES exports: initCustomSky, updateCustomSky, removeOldSky
// PATTERN: ES module (canonical)
// PERF_BUDGET: 3 draw calls (dome + cloud hemisphere + star points). Cloud is fragment-heavy.
// QUALITY_TIERS: low=dome only, mid=dome+clouds(1 octave), high=all 3 layers + 3 octave noise
// NEVER: let uTime grow unbounded — modulo by large period to prevent UV precision loss
// ALWAYS: pass dt or compute delta for frame-rate-independent lerps
// COORDINATE_SPACE: sky domes centered on cameraPos each frame (no world-origin dependency)
// @end-ai-contract
```

### Pass 6 — Design Intent (Ive, Carmack)

> **Ive:** "The sky is Scale incarnate. When a player jets to peak altitude and looks around, the sky dome is 80% of their visual field. It IS the atmosphere. This module is absolutely essential and architecturally correct — clean ES module, no globals, parameterized input. It just needs to grow into the phase system. The sky should be the first thing that changes when a phase transition starts — before the HUD announces it, the sky color should shift. That's the Aliveness feeling: the world breathes, and the sky is its breath."

> **Carmack:** "Good module. Cloud noise is the performance risk. Gate it. The rest is fine."

**Core Feelings Served:** Scale ✅, Aliveness ✅, (future) Adaptation
**Verdict:** Keep as-is. Model module — clean ES module pattern.

---

## Module 4: renderer_command_map.js (601 lines)

### Review Level: Full 6-pass (>500 lines)

### Pass 1 — Break It

**Saboteur:**
- **2-team hardcoding:**
  - `teamColors: ['#3FA8FF', '#FF6A4A', '#9DDCFF']` — 2 team colors + 1 fallback. Teams 2-3 get the fallback blue.
  - Flag loop: `for (let i = 0; i < 2; i++)` — only renders 2 flags.
  - Soldier fog-of-war: `team !== localTeam && !visible` — binary friend/foe. With 4 tribes, you have 3 enemy teams.
- `_earlyBootstrap()` binds `keydown` with `capture: true` on the window. This intercepts ALL 'C' keypresses site-wide — including typing 'c' in chat input. The input/textarea check exists but won't catch custom chat elements that aren't `<input>` or `<textarea>`.
- `_renderTerrainBackground()` creates a new offscreen canvas and ImageData every time it's called (only invalidated on resize). But `_onResize()` sets `STATE.terrainCanvas = null`, so every window resize triggers a full heightmap re-render. On resize drag, that's potentially dozens of full-grid pixel-by-pixel recomputes.
- `_startSelfLoop()` uses its own `requestAnimationFrame` loop independent of the main render loop. Two RAF loops means the command map update is not synchronized with the main frame — could cause visual tearing or one frame of stale data.
- The `backdrop-filter: blur(3px)` is extremely expensive on some GPU/browser combos. No quality tier check.
- Legend text references 2-team terminology: "Friendly soldier" / "Enemy soldier (visible)" — no multi-team language.

**Wiring Inspector:**
- `_worldToMap(wx, wz)` uses `STATE.worldHalfExtent` which is set in `_renderTerrainBackground()`. If `update()` is called before terrain is rendered (hooks exist but heightmap not loaded yet), the default `worldHalfExtent = 1024` may be wildly wrong, producing a distorted map.
- Building team detection: reads `b.mesh.userData.team`. This is set by renderer.js building enhancement, but only for CANONICAL buildings. Fallback buildings don't have this field — their team is unknown.
- `getHeightmap()` hook returns `{data, size, scale}`. The terrain background renders north-up by flipping Y. If the heightmap coordinate convention changes (e.g., for a new map format), the flip breaks.

**Cartographer:**
- No dispose or cleanup. Canvas stays in DOM forever, keydown listener persists even if map is closed.
- No map legend for 4 tribes.
- "TACTICAL OVERVIEW — RAINDANCE" is hardcoded to one map name.
- No scalable zoom — fixed to 85% of screen.
- No phase overlay (lava zones, fog zones) despite game design specifying zone painting in map editor.

### Pass 2 — Challenge Architecture

**Carmack:** "Self-driven RAF loop is wrong. It should be updated from the main render loop like everything else. Two RAF loops means two completely independent timing domains. If the main loop drops to 30fps, the command map still runs at full speed — inconsistent data. Call update() from the main loop like Minimap."

**Barrett:** "The hillshade terrain rendering is well-done technically. Bilinear sampling, normal estimation, elevation banding — that's a proper tactical map. But it should be cached as an ImageBitmap or OffscreenCanvas and only re-rendered on map load, not on resize. The resize should just scale the cached bitmap."

**Muratori:** "601 lines for a toggle overlay. The building symbol drawing, flag drawing, soldier drawing, HUD text — those are all doing what the minimap already does, just bigger and with different projections. There's a shared 'tactical renderer' concept here that should be a utility both minimap and command map consume. The w2r/project functions are the same coordinate transform in two places."

**ryg:** "The backdrop-filter blur is a known GPU bomb on Intel integrated graphics — it composites every pixel behind the canvas through a Gaussian kernel. On Low quality, skip it. Use `background: rgba(2,8,16,0.92)` instead — slightly more opaque, no blur, looks 90% the same."

### Pass 3 — Debate to Consensus

**Carmack:** "Kill the self-driven RAF. Add update() to the main loop's render pass, behind an `if (CommandMap.isOpen())` check."

**Barrett:** "Agreed. On the shared tactical renderer — Muratori's right conceptually but the ROI is low. These are 2D canvas drawing functions, not complex abstractions. The duplication is ~60 lines of trivial canvas draw calls. I'd tag it as a future cleanup, not a blocker."

**Muratori:** "Fair. The real problem is the 2-team hardcoding and the hardcoded map name. Those are functional bugs."

**Ive:** "The backdrop blur is a design choice — it creates depth between the map overlay and the game. But if it costs performance, use a solid dark background. The feeling of 'tactical pause' comes from the overlay existing at all, not from the blur. Function over flourish."

**Consensus:**
1. Remove self-driven RAF loop — integrate into main render loop
2. Fix 2→4 team colors and flag rendering
3. Remove hardcoded "RAINDANCE" map name — read from game state
4. Quality tier: no backdrop-filter on Low, opaque bg instead
5. Cache terrain bitmap on map load, not on resize
6. Shared tactical utility is a deferred cleanup

### Pass 4 — System-Level Review

**Dependency Map:**
```
renderer_command_map.js (IIFE)
├── READS: hooks.getHeightmap(), hooks.getPlayerView(), hooks.getLocalIdx(),
│          hooks.getFlagView(), hooks.getBuildings()
│          (all injected via init(hooks) from renderer.js)
│          document.getElementById('hud') (for HUD active check? — actually no, it doesn't check)
├── WRITES: window.CommandMap { init, update, toggle, open, close, isOpen }
├── DOM: creates #cmd-map-canvas (fixed overlay), binds keydown (C key)
├── EVENT LISTENERS: window keydown (C/Escape), window resize
└── CALLED BY: renderer.js (CommandMap.init(hooks), CommandMap.update() per frame)
    Also self-driven via own RAF loop (should be removed)
```

**2-Team Check:** ❌ FAILS. Hard 2-team throughout.

**window.* Globals:**
| Global | Category | Migration |
|---|---|---|
| `window.CommandMap` | API Facade | ES module export |

**Should This Module Exist?** YES.
- Command map is a signature Tribes feature (the "Commander" role)
- Tactically essential for 64-player games
- v2 will add click-to-order for AI bots

**Recommendation: KEEP. Fix 2→4 teams. Remove self-RAF. Add quality tiers. Cache terrain. Dynamic map name.**

### Pass 5 — AI Rules

```javascript
// @ai-contract renderer_command_map.js
// PURPOSE: Full-screen tactical overlay (C key toggle) with hillshaded terrain, soldiers, flags, buildings
// SERVES: Scale (see the entire battlefield), Belonging (see your tribe's positions)
// DEPENDS_ON: hooks from renderer.js (heightmap, playerView, localIdx, flagView, buildings)
// EXPOSES: window.CommandMap { init, update, toggle, open, close, isOpen }
// PATTERN: IIFE + window.* (legacy — migrate to ES module)
// PERF_BUDGET: 1 Canvas 2D drawImage (cached terrain) + ~200 draw calls when open. 0 when closed.
// QUALITY_TIERS: low=no backdrop-filter (opaque bg), mid+=blur
// NEVER: run a self-driven RAF loop — always call from main render loop
// NEVER: hardcode map names or team counts
// ALWAYS: cache terrain hillshade on map load, not on resize
// @end-ai-contract
```

### Pass 6 — Design Intent (Ive, Carmack)

> **Ive:** "The command map is **Scale** distilled into a single keystroke. You press C and suddenly you see the entire world — every player, every flag, every structure. In a 64-player game this is how you understand what's happening. It's also **Belonging** — you see your tribe's formation and know where you're needed. The hillshade terrain rendering is genuinely beautiful for a 2D tactical view. The problem is it's stuck in a 2-team, single-map world. This module needs to grow with the game. But it absolutely earns its place."

> **Carmack:** "Good module, wrong loop architecture. Fix the RAF issue and it's solid. The terrain hillshade is clever — offscreen canvas with per-pixel normal estimation and lighting. Could be done as a GPU compute shader someday, but for the current scope, Canvas 2D is fine."

**Core Feelings Served:** Scale ✅, Belonging ✅
**Verdict:** Keep. Fix 2-team, fix RAF, cache terrain.

---

## Module 5: renderer_toonify.js (210 lines)

### Review Level: Pass 1 + Pass 4 + Pass 6

### Pass 1 — Break It

**Saboteur:**
- `_convertMaterial()` creates a NEW MeshToonMaterial for every mesh. If the scene has 500 meshes sharing 20 unique materials, it creates 500 materials instead of 20 (the WeakMap `seen` in `_toonifyScene` handles this — BUT `reapply()` creates a fresh WeakMap each time, so previously-converted materials lose their identity link).
- `_convertMaterial` checks `mat.onBeforeCompile.length > 0` to detect shader injection. Arrow functions with no params have `.length === 0` even if they modify the shader. A shader injection using `mat.onBeforeCompile = (shader) => { ... }` has length 1, but `mat.onBeforeCompile = () => { ... }` has length 0 and would be MISSED.
- `reapply()` converts materials that are ALREADY MeshToonMaterial — the check `!mat.isMeshStandardMaterial` should catch this, but after toonification the original material is gone. If a module creates a new MeshStandardMaterial and adds it to the scene between `init()` and `reapply()`, it gets converted. That's correct. But the function does a full scene traversal every time — O(N) for N meshes.

**Wiring Inspector:**
- Reads `window.location.search` at IIFE parse time. If the module is loaded before the URL is fully resolved (theoretical edge case with dynamic imports), the URL params might be incomplete.
- `init(THREE, scene)` — THREE passed as param (IIFE pattern). If scene hasn't finished populating (async GLB loads still pending), those meshes won't be converted until `reapply()` is called.
- No integration with quality tiers. Toonify is either on or off via URL param. Should be a quality tier option.

### Pass 4 — System-Level Review

**Dependency Map:**
```
renderer_toonify.js (IIFE)
├── READS: window.location.search (URL params)
├── WRITES: window.Toonify { enabled, init, reapply, convertMaterial, gradientMap }
├── THREE: passed as parameter to init()
└── CALLED BY: renderer.js (Toonify.init(THREE, scene) at L290, .reapply() after new mesh loads)
```

**2-Team Check:** ✅ No team references.

**window.* Globals:**
| Global | Category | Migration |
|---|---|---|
| `window.Toonify` | API Facade | ES module export |

**Should This Module Exist?** CONDITIONAL.
- The toon shader is the visual identity. That's important.
- BUT: the skip logic for shader-injected materials (terrain, grass, interiors) means only character models and basic buildings actually get toonified. That's a narrow scope.
- The module is really a "material conversion utility" — could be 40 lines as a function in a materials module.

**Recommendation: KEEP for now, but flag for absorption into a future `renderer_materials.js` utility module during renderer.js decomposition.**

### Pass 6 — Design Intent (Ive)

> **Ive:** "Toonify's purpose is to enforce the visual identity — 'procedural boldness, readable silhouettes.' The 4-band gradient ramp flattens lighting into clear, readable steps. That serves the game's identity directly. But the skip list is revealing: terrain, grass, interiors all bypass it because they have custom shaders. So the module's actual impact is: character models and basic buildings get toon shading. Is that worth a dedicated module? It's borderline. I'd keep it because it defines the visual contract — 'MeshStandardMaterial becomes MeshToonMaterial' — and that contract is worth having in one place. But it should be a utility, not a system."

**Core Feelings Served:** Visual Identity (supports readability, which supports Scale)
**Verdict:** Keep as utility. Flag for potential absorption.

---

## Module 6: renderer_zoom.js (206 lines)

### Review Level: Pass 1 + Pass 4 + Pass 6

### Pass 1 — Break It

**Saboteur:**
- Self-driven RAF loop (`requestAnimationFrame(_raf)` in `_boot`) — same issue as command map. Runs independently of main render loop. Zoom smoothing and main camera FOV application are in different timing domains.
- `window.addEventListener('contextmenu', e => e.preventDefault(), true)` — globally suppresses right-click context menu on the ENTIRE page, not just during gameplay. This breaks right-click in chat, settings panels, debug tools, etc.
- Z key handler doesn't check if game is actually running. Player could be in main menu, replay viewer, or map editor and Z still cycles zoom. No game-state guard.
- RMB handler: `mousedown button === 2` sets held state, but if mouse leaves the browser window while held, `mouseup` never fires. `rmbHeld` stays true. Zoom stays engaged until the next mouseup inside the window.

**Wiring Inspector:**
- `getFovMultiplier()` returns `1.0 / STATE.effective`. renderer.js reads this and multiplies the C++ FOV. If ZoomFX hasn't been initialized yet (scripts loading), `STATE.effective = 1.0` so the multiplier is 1.0 — safe default.
- `getSensitivityScale()` exposed but it's unclear if anything reads it. renderer.js FOV logic is the only documented consumer. Mouse sensitivity reduction during zoom would need to be wired into the input layer.

### Pass 4 — System-Level Review

**Dependency Map:**
```
renderer_zoom.js (IIFE)
├── READS: nothing from window.* (self-contained state)
├── WRITES: window.ZoomFX { getFovMultiplier, isActive, getEffectiveZoom, tick, getSensitivityScale }
├── DOM: creates #zoom-reticle (SVG overlay), #zoom-level-label
├── EVENT LISTENERS: window mousedown/mouseup (RMB), window contextmenu (suppressed), window keydown (Z)
└── CALLED BY: renderer.js reads ZoomFX.getFovMultiplier() at L4234
    Also self-driven via own RAF loop (should be removed)
```

**2-Team Check:** ✅ No team references.

**window.* Globals:**
| Global | Category | Migration |
|---|---|---|
| `window.ZoomFX` | API Facade | ES module export |

**Should This Module Exist?** YES.
- Zoom/scope is a core Tribes mechanic (sniper rifles, weapon zoom)
- Reticle SVG is specific enough to warrant isolation
- Clean API surface

**Recommendation: KEEP. Remove self-RAF. Fix context menu suppression scope. Add game-state guard. Handle window-leave for RMB.**

### Pass 6 — Design Intent (Ive)

> **Ive:** "Zoom serves **Scale** — it collapses the vast distance and lets you read the battlefield from afar. It also serves future **Mastery** — the sniper scope is a skill tool. The reticle design is clean: thin crosshair, mil-dot range markings, corner brackets. It reads 'scope' without being cluttered. The implementation is mostly right. The self-driven RAF is the architectural issue. Fix that and this module earns its place."

**Core Feelings Served:** Scale ✅
**Verdict:** Keep. Fix RAF, fix context menu scope.

---

## Module 7: renderer_cohesion.js (138 lines)

### Review Level: Pass 1 + Pass 4 + Pass 6 (lightweight — <200 lines)

### Pass 1 — Break It

**Saboteur:**
- `tick()` function contains `return;` as the FIRST statement. The entire tick function is dead code. Camera breathing is disabled per the R32.25.3 hotfix comment.
- The mood bed audio creates oscillators and a filter but never disconnects or stops them. On tab close or navigation, WebAudio nodes are cleaned up by the browser, but during the session they run continuously with no volume control beyond the initial gain of 0.022.
- `_startMoodBed()` creates a NEW AudioContext if `window.AE` doesn't exist. This means the game could have TWO AudioContexts running simultaneously (the main one from shell.html and this one). Browsers limit concurrent AudioContexts.
- The `pointerdown` and `keydown` listeners added for autoplay resumption remove themselves after first trigger, but only for their own handler. If the main AE context is already running, the listener fires, creates a SECOND context (if AE doesn't exist), and the listener removal succeeds but the extra context lives forever.

**Wiring Inspector:**
- Reads `window.AE && window.AE.ctx` to reuse existing context. If AE exists but AE.ctx is null (context creation failed), it creates a new one.
- Camera reference stored but never used (tick() returns immediately).

### Pass 4 — System-Level Review

**Dependency Map:**
```
renderer_cohesion.js (IIFE)
├── READS: window.AE (audio engine from shell.html)
├── WRITES: window.Cohesion { init, tick }
├── Creates: AudioContext (if AE not available), 2 OscillatorNodes, BiquadFilter, GainNode, LFO
└── CALLED BY: renderer.js (Cohesion.init(THREE, camera), Cohesion.tick(t) per frame)
```

**2-Team Check:** ✅ No team references.

**window.* Globals:**
| Global | Category | Migration |
|---|---|---|
| `window.Cohesion` | API Facade | Should be absorbed |

**Should This Module Exist?** NO — in its current form.
- Camera breathing is disabled (dead code)
- Mood bed is a 40-line WebAudio snippet that should live in the audio system
- 138 lines for a module that executes `return;` on tick

**Recommendation: KILL.**
- Move mood bed code into `client/audio.js` (or shell.html AE system)
- Delete camera breathing dead code
- Delete the module

### Pass 6 — Design Intent (Ive)

> **Ive:** "The CONCEPT is sound — sub-perceptual micro-jitter and ambient audio beds are real techniques used in film and games to prevent sterility. But the execution is broken. Camera breathing was disabled because it fought the WASM camera sync. The mood bed is the only active code, and it's 40 lines that belong in the audio system, not a standalone module. The name 'cohesion' is also opaque — what does it cohese? A new developer would have no idea. Kill it. Move the mood bed. If camera breathing is revisited, it should be implemented as a post-process effect (a tiny random offset in screen space), not a camera rotation hack."

**Core Feelings Served:** Aliveness (mood bed only — and that code should move to audio)
**Verdict:** KILL. Absorb mood bed into audio system.

---

## Module 8: renderer_palette.js (92 lines)

### Review Level: Pass 1 + Pass 4 + Pass 6 (lightweight)

### Pass 1 — Break It

**Saboteur:**
- **2-team hardcoding:**
  - `teamColor(teamIdx)` — binary: `teamIdx === 1 ? blue : red`. Teams 2-3 return red.
  - `teamColorInt(teamIdx)` — same binary logic.
  - Only `teamRed` and `teamBlue` defined. No teamGold or teamGreen for Phoenix and Starwolf.
- `Object.freeze(PALETTE)` — correct for preventing accidental mutation. But the freeze is shallow — if any value were an object (none currently are), its internals would be mutable.
- `PaletteUtils` is NOT frozen. Any module could overwrite `PaletteUtils.teamColor` with a broken function.

**Wiring Inspector:**
- `window.PALETTE` and `window.PaletteUtils` — two separate globals for one module. Should be unified.
- Nothing enforces that other modules USE the palette. The minimap hardcodes `'#3FA8FF'`, the command map hardcodes `'#3FA8FF'`. The palette exists but isn't actually the source of truth in practice.

### Pass 4 — System-Level Review

**Dependency Map:**
```
renderer_palette.js (IIFE)
├── READS: nothing
├── WRITES: window.PALETTE (frozen object), window.PaletteUtils { hexToRgb, rgba, teamColor, teamColorInt }
└── CALLED BY: renderer.js (implicitly), renderer_combat_fx.js (implicitly — should use it but doesn't)
    Actually: NO MODULE IMPORTS OR READS PALETTE. It's defined but orphaned.
```

**2-Team Check:** ❌ FAILS. Binary team logic.

**window.* Globals:**
| Global | Category | Migration |
|---|---|---|
| `window.PALETTE` | Shared Data | ES module export |
| `window.PaletteUtils` | API Facade | ES module export |

**Should This Module Exist?** YES — but it needs to be USED.
- A single source of truth for colors is architecturally correct
- The problem is adoption: no other module actually imports from it
- Serves as a design contract: "these are the game's colors"

**Recommendation: KEEP. Expand to 4 tribes. Migrate to ES module. Actually wire other modules to use it (minimap, command map, combat FX all hardcode colors instead).**

### Pass 6 — Design Intent (Ive)

> **Ive:** "A locked color palette is one of the most important design decisions a visual system can have. Every professional design system has one. This module IS the visual identity in numerical form. The problem is it's a palace with no residents — nobody actually uses it. The brass-amber accent color (#FFC850) is beautiful and consistent. The team colors are readable. But it needs 4 tribes, and it needs to be the ENFORCED source of truth, not an optional reference. When I see the minimap hardcoding '#3FA8FF' instead of importing from the palette, that's a broken design system. This module's biggest value will be realized when it's an ES module that other modules import from directly."

**Core Feelings Served:** Visual Identity (foundational)
**Verdict:** Keep and expand. Migration to ES module is high priority.

---

## Module 9: renderer_debug_panel.js (216 lines)

### Review Level: Pass 1 + Pass 4 + Pass 6

### Pass 1 — Break It

**Saboteur:**
- Gated behind `?debugPanel` URL param — only loads in debug mode. Low risk to production.
- `waitForScene()` uses recursive `setTimeout(check, 200)` with no timeout limit. If `_tribesDebug` never appears, this polls forever (200ms intervals, ~5 checks/sec, forever).
- `rebuildMaterials()` creates new material instances on every checkbox change. No disposal of old materials. Toggling checkboxes rapidly accumulates GPU-side material objects.
- `buildingMeshes` detection: checks `c.userData.canon !== undefined` OR `c.isMesh && c.geometry.type === 'BoxGeometry'`. The BoxGeometry heuristic could match non-building meshes.
- Normal negation: flips ALL normal components in-place. If the user toggles negate on, then changes material type, then toggles negate off — the normals go back to original. But if they close the panel and reopen, `_normalsNegated` state is lost.

**Wiring Inspector:**
- `THREE` referenced but never imported or passed — relies on THREE being a global (which it isn't in ES module builds). This would crash if THREE isn't on window. Currently works because shell.html loads THREE as a global in the non-module path.

### Pass 4 — System-Level Review

**Dependency Map:**
```
renderer_debug_panel.js (IIFE, gated by ?debugPanel)
├── READS: window._tribesDebug { scene, renderer, composer, setComposerEnabled }
│          window.DayNight (optional: .freeze, .unfreeze)
│          THREE (assumed global)
├── WRITES: nothing to window.*
├── DOM: creates #debug-panel div with checkboxes, binds F8
└── CALLED BY: self-bootstrapping (IIFE waits for _tribesDebug)
```

**2-Team Check:** ✅ Not applicable (debug only).

**window.* Globals:** None written.

**Should This Module Exist?** YES — as a debug tool.
- Valuable for visual debugging (the interior shapes black rectangle bug it was built for)
- Gated behind URL param — zero production cost
- Self-contained: doesn't affect other modules

**Recommendation: KEEP as debug tool. Add THREE import guard. Add setTimeout limit for waitForScene. Clean up material disposal.**

### Pass 6 — Design Intent (Ive)

> **Ive:** "This is a tool, not a feature. It serves the BUILDER, not the player. That's fine — tools deserve good design too. The checkbox-driven isolation approach is genuinely useful for visual debugging. Keep it. The F8 toggle is unobtrusive. No design concerns — it's behind a debug flag and invisible to players."

**Core Feelings Served:** N/A (developer tool)
**Verdict:** Keep as debug utility.

---

## Module 10: client/audio.js (95 lines)

### Review Level: Pass 1 + Pass 4 + Pass 6 (lightweight)

### Pass 1 — Break It

**Saboteur:**
- `playUI(soundId)` delegates to `window.playSoundUI`. If `playSoundUI` doesn't exist (AE not initialized), the call silently does nothing. No error, no queue for later playback. Audio is simply lost.
- `setMuted(v)` sets `AE.master.gain.value = 0` — this is an abrupt cut. Should use `linearRampToValueAtTime` for a smooth fade to avoid audio clicks.
- `fireSoundForWeapon(0)` (blaster) falls through to `default: return SOUND.IMPACT` — blaster has no unique sound ID, plays the impact sound instead. That's wrong.
- The file is an ES module (`export const SOUND = ...`) but calls `window.playSoundUI` and `window.playSoundAt` — mixing module system with window globals.

**Wiring Inspector:**
- 17 sound IDs defined (0-16) but the actual synthesizers in shell.html may not match. No validation that the sound bank matches the constants.
- `isReady()` checks `window.AE && window.AE.ctx` but AE.ctx could be in 'suspended' state (autoplay policy). `isReady()` returns true even when audio can't actually play.

### Pass 4 — System-Level Review

**Dependency Map:**
```
client/audio.js (ES module)
├── READS: window.AE (audio engine object from shell.html)
│          window.playSoundUI (function from shell.html)
│          window.playSoundAt (function from shell.html)
├── WRITES: window.AE.muted, window.AE.master.gain.value
├── EXPORTS: SOUND (enum), isReady, muted, setMuted, playUI, playAt, playMatchStartHorn,
│            playMatchEndHorn, playRespawn, playDamageGive, fireSoundForWeapon
└── CALLED BY: network.js (remote player fire sounds), renderer.js (various game events)
```

**2-Team Check:** ✅ No team references. Audio is team-agnostic.

**Should This Module Exist?** YES — but it's a thin facade.
- The real audio engine lives in shell.html as window.AE
- This module provides typed constants and convenience helpers
- It SHOULD eventually absorb AE entirely (move audio engine out of shell.html)

**Recommendation: KEEP. Add blaster sound (weapon 0). Fix isReady() to check context state. Plan to absorb AE from shell.html in a future pass.**

### Pass 6 — Design Intent (Ive)

> **Ive:** "Audio is **Aliveness**. The fact that the audio engine lives in shell.html and this module is just a thin proxy is an architectural smell — audio deserves to be a first-class module, not a retrofit. But the typed sound constants (SOUND.DISC_FIRE, SOUND.CHAINGUN_FIRE, etc.) are exactly right — they make audio intent readable in code. The module earns its place as a stepping stone toward a proper audio system."

**Core Feelings Served:** Aliveness ✅
**Verdict:** Keep. Grow into full audio module.

---

## Module 11: client/mapeditor.js (393 lines)

### Review Level: Pass 1 + Pass 4 + Pass 5 + Pass 6

### Pass 1 — Break It

**Saboteur:**
- **2-team hardcoding:**
  - `flags: [{ team: 0, ... }, { team: 1, ... }]` — only 2 flags.
  - `spawns: [{ team: 0, ... }, { team: 1, ... }]` — only 2 spawns.
  - Flag colors: `f.team === 0 ? '#C8302C' : '#2C5AC8'` — binary.
  - Spawn colors: `s.team === 0 ? '#C8302C' : '#2C5AC8'` — binary.
  - Point type dropdown: only flag0/flag1/spawn0/spawn1.
- `schemaVersion: 1` — game design doc specifies `schemaVersion: 2` with zone painting, 4 teams, water/lava placement. The editor only supports v1.
- `test()` just shows an alert saying "Save then run genmap.ts". No actual test-in-editor flow.
- `SIZE = 256` hardcoded — game design allows 257/512/1024.
- `WORLD_SCALE = 8` hardcoded — game design allows 16-32.
- `_state` is module-scope singleton — can't have two editors open simultaneously (not a real problem, but architecturally limiting).
- No undo/redo. Brush strokes are permanent until reload.

**Wiring Inspector:**
- The editor is an ES module (`export function save()`, `export function open()`) but ALSO sets `window.__editor` and `window.openMapEditor`. Dual exposure.
- `buildMapDoc()` saves structures with `type` as a number (0-4) but no mapping to the canonical building datablocks that renderer_buildings.js uses. The type numbers are local to the editor.
- `loadFromFile()` reads `doc.terrain.encoding === 'float-array'` — correct for files saved by this editor. But `int16-base64` decode path has no endianness handling — `charCodeAt` reads bytes, assumes little-endian implicitly.

### Pass 4 — System-Level Review

**Dependency Map:**
```
client/mapeditor.js (ES module + window.* hybrid)
├── READS: nothing from window.* (self-contained state)
├── WRITES: window.__editor { open, close, save, loadFromFile, clearStructures, test }
│           window.openMapEditor (alias for open)
├── DOM: creates #editor-overlay with full UI
├── EXPORTS: save, loadFromFile, open, close, clearStructures, test
└── CALLED BY: shell.html menu buttons (via window.__editor or window.openMapEditor)
```

**2-Team Check:** ❌ FAILS. Hard 2-team everywhere.

**Should This Module Exist?** YES — needs massive upgrade.
- Map editor is essential for the game (Levi is the map creator)
- Current version is minimal but functional for v1 maps
- Needs to become the Map Editor v2 from game-design.md

**Recommendation: KEEP. This is the starting point for Map Editor v2. Needs: 4 teams, zone painting, 3D preview, variable terrain size, v2 format, undo/redo.**

### Pass 5 — AI Rules

```javascript
// @ai-contract client/mapeditor.js
// PURPOSE: 2D heightmap map editor with brush, structure, and gameplay point tools
// SERVES: (Creator tool — serves Levi's ability to build maps)
// DEPENDS_ON: nothing (self-contained)
// EXPOSES: ES exports: open, close, save, loadFromFile, clearStructures, test
//          window.__editor (legacy alias), window.openMapEditor (legacy alias)
// PATTERN: ES module + window.* hybrid (should be pure ES module)
// PERF_BUDGET: N/A (not running during gameplay)
// QUALITY_TIERS: N/A
// NEVER: hardcode terrain size or world scale — read from map format
// ALWAYS: support all 4 tribes for flags/spawns
// @end-ai-contract
```

### Pass 6 — Design Intent (Ive)

> **Ive:** "The map editor is for the CREATOR — that's Levi. It needs to be simple, not powerful. The game design doc says 'for the map creator, not for pro-level designers.' The current 2D heightmap paint is a reasonable v1. But it's stuck in a 2-team, 256×256, v1-schema world. The 3D preview from game-design.md's Map Editor v2 spec is the real goal. This module is scaffolding — it works, it'll be replaced, and that's fine. Keep it functional until v2 replaces it."

**Core Feelings Served:** N/A (creator tool)
**Verdict:** Keep as scaffolding for v2.

---

## Module 12: client/replay.js (376 lines)

### Review Level: Pass 1 + Pass 4 + Pass 6

### Pass 1 — Break It

**Saboteur:**
- **2-team hardcoding:**
  - Player dots: `p.team === 0 ? '#FF6464' : '#6498FF'` — binary.
  - Flag positions: `f.team === 0 ? '#C8302C' : '#2C5AC8'` — binary.
  - Score display: `snap.teamScore[0] : snap.teamScore[1]` — only 2 scores.
  - Kill marker colors: `c.killerTeam === 0 ? '#C8302C' : c.killerTeam === 1 ? '#2C5AC8' : '#D4A030'` — handles 2 + fallback.
- `parseReplay()` reads the entire file into memory at once. Large replay files (long matches with 64 players) could be tens of MB. No streaming parse.
- `_rafId` not checked before `requestAnimationFrame` in `show()` — if show() is called twice, two RAF loops stack.
- `_accum` can accumulate large values if tab is backgrounded (browser throttles RAF to 1fps or less). On resume, the loop fast-forwards through many ticks instantly, potentially skipping interesting events.
- Kill event clustering: `Math.round(k.tick / 3)` — divides tick by 3 with no comment explaining why. Is this converting from 30Hz server tick to 10Hz snapshot rate? Magic number.

**Wiring Inspector:**
- `import { decodeSnapshot } from './wire.js'` — uses the same wire.js decoder that has the flag posZ bug (Z hardcoded to 0). Replays also lose flag Z position.
- `_state.meta.snapshotHz` used as tick rate but defaults to 10 if missing. If server records at 30Hz but says snapshotHz=10, playback speed is wrong by 3x.
- `follow(id)` stores a player ID but the highlight uses `p.id === view.followId`. If player IDs are not sequential integers, the lookup works. If they're UUIDs, it works. But the UI never exposes a way to click-to-follow a player.

### Pass 4 — System-Level Review

**Dependency Map:**
```
client/replay.js (ES module)
├── IMPORTS: wire.js (decodeSnapshot)
├── READS: nothing from window.*
├── WRITES: window.__replay { openFromFile, openFromUrl, openFromArrayBuffer, close, play, pause, setSpeed, seek, step, follow }
├── DOM: creates #replay-overlay with full UI (canvas + timeline + controls)
├── EXPORTS: close, openFromArrayBuffer, openFromFile, openFromUrl, play, pause, setSpeed, seek, step, follow, pan, zoom
└── CALLED BY: shell.html menu (via window.__replay)
```

**2-Team Check:** ❌ FAILS. Hard 2-team throughout.

**Should This Module Exist?** YES.
- Replay viewing is a standard competitive game feature
- 2D tactical view is the right v1 approach (Carmack-approved in prior passes: "a 2D top-down view tells the match's story clearly")
- Clean separation from game renderer

**Recommendation: KEEP. Fix 2→4 teams. Cap _accum to prevent tab-background fast-forward. Add click-to-follow. Fix magic number (tick/3).**

### Pass 6 — Design Intent (Ive)

> **Ive:** "Replays serve **Mastery** — players review their matches to improve. They also serve **Belonging** — watching your tribe's coordinated flag run from overhead is a powerful shared experience. The 2D tactical view with kill markers on the timeline is genuinely well-designed. The clustering for dense fights is a nice touch. But it only works for 2 teams. In a 4-tribe match, you need 4 colors, 4 score columns, and the timeline markers need to show inter-tribe kills distinctly. This module earns its place."

**Core Feelings Served:** (future) Mastery, Belonging
**Verdict:** Keep. Fix 2-team.

---

# Summary: Phase 4 Verdicts

| Module | Lines | Verdict | Key Issues |
|---|---|---|---|
| renderer_combat_fx.js | 301 | **KEEP** | GC allocs per-fire, no dispose, needs 4-tribe tracers |
| renderer_minimap.js | 348 | **KEEP** | ❌ 2-team hardcoded, GC allocs, no phase reactivity |
| renderer_sky_custom.js | 396 | **KEEP** (model module) | Frame-rate-dependent fade, unbounded uTime, no quality tiers, no phase input |
| renderer_command_map.js | 601 | **KEEP** | ❌ 2-team, self-RAF loop, expensive backdrop-filter, hardcoded map name |
| renderer_toonify.js | 210 | **KEEP** (flag for absorption) | Narrow actual impact, material disposal on reapply |
| renderer_zoom.js | 206 | **KEEP** | Self-RAF loop, context menu suppression too broad, no game-state guard |
| renderer_cohesion.js | 138 | **KILL** | tick() is dead code, mood bed should move to audio.js |
| renderer_palette.js | 92 | **KEEP + expand** | ❌ 2-team, nobody actually uses it |
| renderer_debug_panel.js | 216 | **KEEP** (debug tool) | THREE not imported, infinite waitForScene poll |
| client/audio.js | 95 | **KEEP** | Thin facade, blaster has no sound, isReady() lies about suspended context |
| client/mapeditor.js | 393 | **KEEP** (scaffolding) | ❌ 2-team, v1 schema only, no undo, scaffolding for v2 |
| client/replay.js | 376 | **KEEP** | ❌ 2-team, tab-background fast-forward, flag posZ lost (wire.js bug) |

### Critical Cross-Cutting Issues

1. **2-Team Hardcoding: 7 of 12 modules fail.** Minimap, command map, palette, mapeditor, replay, combat_fx (tracers), and all flag-related code assume exactly 2 teams. This is the #1 blocker for 4-tribe support.

2. **Self-Driven RAF Loops: 2 modules** (command_map, zoom) run their own requestAnimationFrame loops independent of the main renderer. These should be called from the main loop.

3. **Palette Not Used:** renderer_palette.js defines the color system but minimap, command_map, and combat_fx all hardcode their own colors. The palette is architecturally correct but not adopted.

4. **IIFE Pattern:** 8 of 12 modules use the IIFE + window.* pattern. Only sky, audio, mapeditor, and replay are ES modules. Migration should happen during renderer.js decomposition.

5. **Dead Module:** renderer_cohesion.js is 138 lines where the only active code is a 40-line mood bed that belongs in the audio system.

