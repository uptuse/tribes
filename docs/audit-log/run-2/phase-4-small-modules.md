# Phase 4 — T3+T4 Module Audit (Run 2: Validation Pass)

*Adversarial Convergence Review — Run 2, 2026-04-29*
*Expert Panel: Barrett (UI/HUD lead), Muratori, ryg, Ive, Carmack.*
*Mission: Validate, challenge, and deepen Run 1's findings across all 12 small modules.*

---

## Preamble: Run 2 Method

Run 1 gave us a thorough first pass. Run 2 reads every line of source independently and stress-tests each Run 1 claim against the actual code. Where Run 1 was right, we say so briefly and move on. Where Run 1 missed something, or where a verdict deserves challenge, we go deep.

Actual line counts at time of review:
| Module | Run 1 Est. | Actual |
|--------|-----------|--------|
| renderer_combat_fx.js | ~301 | 283 |
| renderer_minimap.js | ~348 | 307 |
| renderer_sky_custom.js | ~396 | 355 |
| renderer_command_map.js | ~601 | 554 |
| renderer_toonify.js | ~210 | 195 |
| renderer_zoom.js | ~206 | 183 |
| renderer_cohesion.js | ~138 | 124 |
| renderer_palette.js | ~92 | 83 |
| renderer_debug_panel.js | ~216 | 188 |
| client/audio.js | ~95 | 84 |
| client/mapeditor.js | ~393 | 373 |
| client/replay.js | ~376 | 351 |

Minor but worth noting: Run 1's line estimates were consistently 10-15% high. Not a problem, but precision matters.

---

## Module 1: renderer_cohesion.js — THE KILL VERDICT (Deep Validation)

This is the headline validation. Run 1 said KILL. Let's verify every claim.

### Source Verification

**Barrett:** "Run 1 says `tick()` is dead code. Let me read it line by line."

```javascript
function tick(t) {
    // R32.25.3 HOTFIX: camera breathing disabled. ...
    return;
    // (preserved for reference)
    // if (typeof t !== 'number') { ...
    // _applyBreathing(t);
}
```

**Barrett:** "Confirmed. `tick()` literally contains `return;` as the first executable statement. Everything below it is commented-out dead code. This function does NOTHING. renderer.js calls `Cohesion.tick(t)` every frame, which immediately returns. That's a wasted function call per frame — trivial cost but pointless."

**Carmack:** "What about `init()`?"

**Barrett:** "Init does two things: stores the camera reference (never used since tick returns immediately) and registers event listeners for `pointerdown`/`keydown` to trigger the mood bed on first user interaction. So init's only real purpose is deferring mood bed startup."

**Muratori:** "And the mood bed itself — how big is it?"

**Barrett:** "The `_startMoodBed()` function is lines 67-109. That's 42 lines of WebAudio code: two detuned sawtooth oscillators at 55Hz/55.42Hz, a lowpass filter with LFO, and a gain ramp from 0 to 0.022. It creates or reuses `window.AE.ctx`. That's the ONLY active code in the entire module."

**ryg:** "Run 1 flagged the dual AudioContext risk. Let me trace the logic."

```javascript
const ctx = (window.AE && window.AE.ctx) ||
            new (window.AudioContext || window.webkitAudioContext)();
```

**ryg:** "If `window.AE` exists and has a `.ctx`, it reuses it. If not, it creates a new one. The risk is real: if AE hasn't initialized yet (race condition during page load), this creates a second context. But in practice, shell.html creates AE synchronously in a script block, so by the time user interaction triggers `_startMoodBed()`, AE should exist. The risk is theoretical, not observed."

**Ive:** "The deeper question: does the mood bed belong here or in audio? It's a low-frequency atmospheric drone. It's audio. It should live with audio. The `renderer_cohesion` name tells you nothing about what this module does. A developer would expect 'cohesion' to be about visual consistency, not a 55Hz drone."

**Carmack:** "Run 1's KILL verdict is correct. Move `_startMoodBed()` into `client/audio.js` or the AE system in shell.html. Delete the module. The camera breathing idea was sound but the implementation was architecturally incompatible — camera rotation is overwritten by WASM sync every frame, so additive rotation offsets drift. If this concept returns, it needs to be a post-process screen-space jitter, not a camera rotation hack."

### Verdict: **KILL — VALIDATED ✅**

Run 1 was exactly right. 42 lines of mood bed code belong in audio.js. The remaining 82 lines are dead code (disabled breathing + boilerplate). The module has no reason to exist.

---

## Module 2: renderer_palette.js — "Nobody Uses It" (Deep Validation)

### Source Verification

**Barrett:** "Run 1 says palette is defined but orphaned — no other module imports or reads it. Let me grep the entire codebase."

Grep results for `PALETTE` or `PaletteUtils` across all `.js` files (excluding renderer_palette.js itself):

```
renderer_palette.js — defines it
editor/buildings.html — uses "PALETTE" as a variable name in its own UI code (unrelated)
index.html L4264 — loads palette script with a comment "load Palette FIRST"
```

**Barrett:** "Run 1 is CONFIRMED. Zero modules consume `window.PALETTE` or `window.PaletteUtils`. The palette is loaded first (index.html says so explicitly) but nobody reads from it. Meanwhile, here's the hardcoded color usage across the codebase:"

| Module | Hardcoded Colors | Palette Equivalent |
|--------|-----------------|-------------------|
| renderer_minimap.js | `#3FA8FF`, `#FF6A4A` | Would be `PALETTE.teamBlue`, `PALETTE.teamRed` — but colors DON'T MATCH |
| renderer_command_map.js | `#3FA8FF`, `#FF6A4A`, `#FFC850` | Team colors don't match palette; accent matches |
| renderer_combat_fx.js | `0xffd070` (tracer/light) | Not in palette at all — this is its own brass variant |
| renderer_zoom.js | `#FFC850` (reticle) | Matches `PALETTE.accent` — but doesn't import it |
| renderer_debug_panel.js | `#FFC850` (title) | Matches `PALETTE.accent` — but doesn't import it |
| client/mapeditor.js | `#C8302C`, `#2C5AC8` | Doesn't match palette at all (palette is `#E84A4A`/`#4A8AE8`) |
| client/replay.js | `#FF6464`, `#6498FF`, `#C8302C`, `#2C5AC8` | Mixed colors, none from palette |

**Ive:** "This is actually WORSE than Run 1 described. Not only does nobody use the palette — the colors that ARE hardcoded across the codebase DON'T EVEN AGREE WITH EACH OTHER. Look at team colors:"

| Module | Team 0 (Red) | Team 1 (Blue) |
|--------|-------------|---------------|
| palette.js | `#E84A4A` | `#4A8AE8` |
| minimap | `#3FA8FF` (?!) | `#FF6A4A` (?!) |
| command_map | `#3FA8FF` | `#FF6A4A` |
| mapeditor | `#C8302C` | `#2C5AC8` |
| replay (dots) | `#FF6464` | `#6498FF` |
| replay (flags) | `#C8302C` | `#2C5AC8` |

**Ive:** "Wait — look at minimap's `TEAM_COLORS = ['#3FA8FF', '#FF6A4A']` with the comment `team 0=blue, team 1=red`. Team 0 is BLUE, team 1 is RED. But the palette says `teamRed` and `teamBlue` without specifying index. And the map editor uses `team 0 = #C8302C` (a RED) for team 0. The minimap has the team mapping INVERTED relative to the editor. This is a latent bug — or at minimum, there's no canonical team-to-color mapping."

**Muratori:** "That's a NEW finding. Run 1 said palette isn't used, which is true. But Run 1 didn't catch that the modules disagree with EACH OTHER about which team is which color. The minimap calls team 0 blue, the editor calls team 0 red. If both are on screen simultaneously, team 0 would be blue on the minimap and red on the map editor."

**Barrett:** "And the palette itself has `teamColor(teamIdx)` which says `teamIdx === 1 ? blue : red` — meaning team 0 = red. That matches mapeditor/replay but CONTRADICTS minimap/command_map."

### Run 1 Challenge

Run 1's finding was correct but incomplete. The palette isn't just unused — the system it was supposed to unify has DIVERGED. The situation is worse than a missing adoption: it's active inconsistency.

### Verdict: **KEEP + EXPAND — VALIDATED ✅, with new severity upgrade**

Run 1 said KEEP + expand. We agree, but the priority is higher than Run 1 implied. This isn't "nice to have." The team color inconsistency between minimap/command_map and mapeditor/replay is a functional bug that will surface the moment a 4-tribe game runs with all these modules active.

---

## Module 3: renderer_sky_custom.js — "Model Module" (Deep Validation)

### Source Verification

**Carmack:** "Run 1 called this the cleanest module in the codebase. Let me verify."

ES module check: `import * as THREE from './vendor/three/r170/three.module.js'` — line 12. ✅
Window globals written: zero. Confirmed via grep. ✅
Window globals read: zero. Confirmed via grep. ✅
Exports: `initCustomSky`, `updateCustomSky`, `removeOldSky` — clean named exports. ✅

**Carmack:** "It IS clean. No window.* pollution. Pure ES module. All data passed via function parameters. Module-scoped state (`_skyDome`, `_cloudDome`, `_starPoints`, `_starOpacity`) is private. This is the gold standard for how every module should look."

**ryg:** "Run 1 flagged the frame-rate-dependent star fade: `_starOpacity += (starTarget - _starOpacity) * 0.05`. That's a per-frame exponential decay with a fixed coefficient. At 60fps it converges in ~60 frames (1 second). At 30fps it converges in ~30 frames (1 second). Wait — actually the TIME is the same because the coefficient scales with frame count, not with dt. Let me think..."

**Carmack:** "No, ryg, it IS frame-rate dependent. At 60fps, each frame applies `*= 0.95` (1 - 0.05). After 1 second (60 frames): `0.95^60 = 0.046`. At 30fps, after 1 second (30 frames): `0.95^30 = 0.215`. The star fade takes visually different amounts of time at different frame rates. The fix is `const k = 1 - Math.exp(-dt / tau)` where tau is the time constant. Run 1 was correct."

**ryg:** "Confirmed. And the uTime unbounded growth — cloud UV uses `cloudUv += uTime * vec2(0.008, 0.003)`. After 3 hours (10800s), the UV offset is `(86.4, 32.4)`. Simplex noise at those UV values still works fine — noise is periodic. After 24 hours (86400s), UV offset is `(691, 259)`. Float32 mantissa is 23 bits (~7 decimal digits). At 691.x we still have ~4 decimal digits of precision. Cloud pattern would start showing subtle quantization artifacts after about 100 hours. Real risk? Low. But the fix (modulo) is trivial."

**Ive:** "Run 1's assessment is accurate. The module-level cleanness is real. I'd add one thing Run 1 missed: the THREE.js import path is hardcoded to `./vendor/three/r170/three.module.js`. If the project ever upgrades Three.js to r171+, this path breaks. Not a bug today, but a maintenance hazard. Every other module that uses THREE receives it as a parameter, avoiding this coupling."

### NEW Finding: Hardcoded Three.js vendor path

This is the one blemish on the "model module" claim. The sky module is tightly coupled to a specific Three.js version path, while all other modules receive THREE via dependency injection. If the project establishes a central import map or upgrades Three.js, this module needs manual updating.

### Verdict: **KEEP (model module) — VALIDATED ✅, with minor caveat on THREE import path**

---

## Module 4: renderer_command_map.js — Self-RAF and 2-Team (Validation)

### Self-RAF Verification

**Carmack:** "Run 1 says command_map runs its own RAF loop. Confirmed:"

```javascript
function _startSelfLoop() {
    if (_selfRafActive) return;
    _selfRafActive = true;
    function _raf() {
        if (!STATE.active) { _selfRafActive = false; return; }
        try { update(); } catch (e) { console.warn('[CommandMap] update error:', e); }
        requestAnimationFrame(_raf);
    }
    requestAnimationFrame(_raf);
}
```

**Carmack:** "It's a self-contained RAF loop that runs ONLY when the map is open (`STATE.active`). It self-terminates when closed. This is actually more defensive than Run 1 implied — it's not running continuously, only when the overlay is visible. But the architectural objection stands: it's a second timing domain. If the main loop is at 30fps and the command map RAF runs at 60fps, the map animates smoother than the game. That's weird."

**Muratori:** "Correction to Run 1: the comment says 'R32.17.3: Self-driven render loop — don't depend on renderer.js calling update().' This was a DELIBERATE choice to decouple from the main loop, probably because renderer.js was missing the update call. The fix isn't just 'remove the self-RAF' — it requires ADDING a `CommandMap.update()` call to the main render loop with an `isOpen()` guard."

**Barrett:** "And note that `update()` is called by the RAF loop but renderer.js might ALSO call it if it was wired at some point. Dual-calling update() would draw everything twice per frame. Run 1 didn't flag this potential double-draw."

### 2-Team Verification

Flag loop: `for (let i = 0; i < 2; i++)` — confirmed hard-cap at 2 flags.
Team colors: `teamColors: ['#3FA8FF', '#FF6A4A', '#9DDCFF']` — 2 colors + fallback. Teams 2-3 get pale blue fallback.
Legend text: hardcoded "Friendly soldier" / "Enemy soldier" — binary friend/foe language.

**Barrett:** "But there's something Run 1 missed: the fog-of-war logic is `team !== localTeam && !visible`. This is actually 4-team-compatible — it checks inequality, not binary 0/1. The FOW logic doesn't need fixing for 4 tribes. The COLORS and FLAG LOOP do."

### Hardcoded Map Name

`ctx.fillText('TACTICAL OVERVIEW — RAINDANCE', 28, 54)` — line 539. Confirmed hardcoded.

### NEW Finding: Terrain cache invalidation on resize

**ryg:** "Run 1 mentioned the resize issue but understated it. `_onResize()` sets `STATE.terrainCanvas = null`. The next frame's `update()` calls `_renderTerrainBackground()` which creates a new offscreen canvas and does a FULL per-pixel heightmap render with bilinear sampling, normal estimation, and hillshading. That's `mapSize^2` pixel computations. At 1080p, mapSize ≈ 918px (85% of min(1920,1080)). That's 843K pixels with per-pixel bilinear + normal + lighting. On window resize drag, this fires on EVERY resize event — potentially 60 times per second. There's no debounce."

### Verdict: **KEEP — VALIDATED ✅**

Run 1's assessment was correct. Adding: resize debounce for terrain cache, and the FOW logic is actually 4-team-safe (only colors/flag-loop need fixing).

---

## Module 5: renderer_minimap.js — 2-Team Verification

### 2-Team Check (Detailed)

**Barrett:** "Let me count every 2-team assumption."

1. `TEAM_COLORS = ['#3FA8FF', '#FF6A4A']` — 2-element array. `TEAM_COLORS[pTeam]` for pTeam > 1 → `undefined`.
2. `FLAG_COLORS = ['#4488FF', '#FF5533']` — 2-element array. Same issue.
3. `for (let i = 0; i < 2; i++)` in flag rendering loop — hardcoded to exactly 2 flags.
4. Player dot color: `const color = TEAM_COLORS[pTeam] || '#888'` — has a fallback to grey! Teams 2-3 would render as grey dots. Better than invisible, worse than correct.

**Barrett:** "Wait — Run 1 said 'team index 2 or 3 → undefined → rendered as invisible dot.' But the actual code has `|| '#888'` as fallback on the player dot. Run 1 was WRONG on this specific claim. Teams 2-3 get grey dots, not invisible. The flag rendering has no such fallback and IS broken for 4 teams, but the player dots gracefully degrade."

**Muratori:** "Run 1 also flagged `view[o + 17]` as a potential misread for 'carrying flag.' Let me check: the code says `const carrying = view[o + 17]`. If carrying >= 0, the dot gets a white ring and a larger radius. The comment says offset 17 is undocumented in the stride layout. This is a real concern — if the stride layout changes, this silently breaks. But it's currently working, so the offset must be correct in practice."

### NEW Finding: Minimap team color inconsistency

As noted in the palette section above, `TEAM_COLORS = ['#3FA8FF', '#FF6A4A']` says `team 0=blue, team 1=red`. But the palette and map editor have `team 0=red`. This is either (a) a team index confusion, or (b) the minimap was written for a different team convention. Either way, it's a color consistency bug NOW, not just a 4-tribe future problem.

### Verdict: **KEEP — VALIDATED ✅, with correction (grey fallback exists for player dots)**

---

## Module 6: renderer_zoom.js — Self-RAF Verification

### Self-RAF Verification

```javascript
function _boot() {
    _buildOverlay();
    _bindInput();
    function _raf() {
        try { tick(); } catch (e) { console.warn('[ZoomFX] tick error:', e); }
        requestAnimationFrame(_raf);
    }
    requestAnimationFrame(_raf);
}
```

**Carmack:** "Confirmed — and this one is WORSE than command_map's. The command map's self-RAF terminates when closed. The zoom's RAF runs UNCONDITIONALLY — every single frame, whether zoomed or not, from page load until page close. It's calling `tick()` 60 times per second to smooth a zoom value that's 1.0 (no zoom) 99% of the time."

**ryg:** "The `tick()` function does 3 things every frame: (1) compute dt, (2) smooth rmbZoom, (3) update DOM opacity. When not zoomed, step 2 is a no-op (1.0 → 1.0) and step 3 sets opacity to '0' (already '0'). The cost is ~microseconds, but it's a wasted RAF callback that adds to the browser's frame scheduling overhead."

**Barrett:** "Run 1 flagged the context menu suppression. Confirmed: `window.addEventListener('contextmenu', e => e.preventDefault(), true)` runs with `capture: true` on the window. This suppresses right-click EVERYWHERE, including on text inputs, debug panels, and any future UI that needs a context menu."

### NEW Finding: Z key has no game-state guard

**Barrett:** "Run 1 mentioned this but understated it. The Z handler checks for input/textarea but doesn't check if the game is running. If the user types 'z' in a custom chat widget (non-input element), or if they press Z in the main menu, the zoom cycles. The map editor uses Escape but doesn't consume Z. Pressing Z while in the map editor would change zoom state in the invisible game behind it."

### Verdict: **KEEP — VALIDATED ✅**

---

## Module 7: renderer_toonify.js — Absorption Question

### Run 1 Challenge: Should this absorb into a materials module?

**Ive:** "Run 1 said 'KEEP for now, flag for absorption.' Let me challenge that. The module does ONE thing: walk the scene graph and convert MeshStandardMaterial to MeshToonMaterial with a 4-band gradient ramp. It explicitly SKIPS terrain, grass, interiors — the three most visually important material systems. So what actually gets toonified?"

**Muratori:** "Character models (soldier meshes), basic buildings (Box/Cylinder geometries), weapon models, and any new mesh added without a custom shader. The visual impact is real but narrow. The R32.27.1 skip-list comment is revealing: 'the entire terrain became a uniform billiard-table green tile from R32.26 onward because the splat shader was lost.' The module already caused a major visual regression because it was too aggressive. The skip-list was the fix."

**Carmack:** "The try-catch wrapper around init is another red flag. `try { ... } catch (e) { console.error('[Toonify] init failed, falling back to PBR:', e); }`. This module has ALREADY crashed the game before and they added a catch-all to prevent it. That's defensive programming against a module that's proven dangerous."

**ryg:** "The `?style=pbr` escape hatch is URL-level. There's no in-game quality tier toggle. A player can't switch between toon and PBR without reloading the page with different URL params. That's an anti-pattern for a visual style system."

**Ive:** "My verdict: KEEP but don't absorb yet. The module defines a visual CONTRACT — 'standard materials become toon materials.' That contract is worth having in one place. The skip list is the dangerous part, not the conversion. And the skip list exists because the module is separate — if this were folded into a generic materials module, the skip logic would be harder to find and maintain."

### Run 1 Naming Challenge: `renderer_toonify.js` → `renderer_style.js`?

**Ive:** "No. 'Style' is too vague. The module does one thing: toonify materials. 'Toonify' is descriptive, memorable, and accurate. The function is literally called `toonifyScene`. Keep the name."

### Verdict: **KEEP — VALIDATED ✅, naming kept as-is**

---

## Module 8: renderer_combat_fx.js — Validation

### Run 1 Claims Verification

**ryg:** "Run 1 says `_getFireEndpoints()` allocates two `new THREE.Vector3()` per call. Confirmed:"

```javascript
const start = new _THREE.Vector3();
// ... later:
end = new _THREE.Vector3(aim.x, aim.y, aim.z);
```

**ryg:** "Two allocations per fire. At rapid chaingun fire (10 shots/sec), that's 20 Vector3 allocations/sec. Each Vector3 is ~100 bytes including prototype overhead. 2KB/sec of GC pressure. Not catastrophic but the pool pattern (pre-allocated, reused) is trivial to implement."

**Barrett:** "Run 1 says no team color for tracers — always brass/gold `0xffd070`. Confirmed. `_buildTracerPool` uses a single `LineBasicMaterial` with `color: 0xffd070` cloned for each tracer. The muzzle light is also `0xffd070`. No team parameterization."

**Carmack:** "Run 1's biggest miss on this module: the IIFE pattern means `CombatFX` is a singleton. You can only have ONE weapon's FX at a time. In a game with spectator mode or third-person camera, you'd want to see OTHER players' muzzle flashes too. The architecture doesn't support that — there's one muzzle sprite parented to one weapon hand."

### NEW Finding: flashHit() DOM coupling

**Barrett:** "Run 1 mentioned `t._r3213Timer` but understated a bigger issue. `flashHit()` reads `document.getElementById('hit-tick')` on EVERY call — no cache. In a rapid-fire scenario with hit registration, that's a DOM query per hit. Should cache the element reference at init."

### Verdict: **KEEP — VALIDATED ✅**

---

## Module 9: renderer_debug_panel.js — Validation

### Run 1 Claims Verification

**Muratori:** "Run 1 says THREE is referenced but never imported. Let me check... The module creates `new THREE.MeshStandardMaterial`, `new THREE.MeshBasicMaterial`, etc. inside `rebuildMaterials()`. But `THREE` is never declared, never imported, and never passed as a parameter. It relies on THREE being a global."

**ryg:** "This actually works in the current build because shell.html loads Three.js as a UMD bundle that sets `window.THREE`. But if the project moves to pure ES modules (as the dual-module-system plan suggests), this breaks. The debug panel would crash."

**Barrett:** "The `?debugPanel` gate means this only loads in debug mode. Crashing in debug mode is bad but not production-impacting. Run 1's assessment is proportionate."

### Verdict: **KEEP (debug tool) — VALIDATED ✅**

---

## Module 10: client/audio.js — Validation

### Run 1 Claims Verification

**Barrett:** "Run 1 says `fireSoundForWeapon(0)` falls through to `SOUND.IMPACT`. Confirmed — `case 0` is not in the switch, so weapon index 0 (blaster) hits the `default` case. That's wrong — blaster should have its own sound."

**Muratori:** "Run 1 says `isReady()` lies about suspended context. Confirmed: `return !!(window.AE && window.AE.ctx)` returns true even if `ctx.state === 'suspended'`. But is this actually a problem? If audio is played while suspended, the call to `playSoundUI` goes through to `window.playSoundUI` which internally checks AE state. The 'lie' only matters if someone uses `isReady()` as a gate before playing audio — and no current code does that."

**Carmack:** "The module is 84 lines. 17 sound IDs, 6 convenience functions, 1 weapon-to-sound mapper. It's a typed enum + thin proxy. Run 1 called it a 'thin facade' — correct. The real question: should the mood bed from cohesion.js move HERE or into shell.html's AE? I'd say here. This module is the canonical audio surface. The mood bed is audio."

### Verdict: **KEEP — VALIDATED ✅**

---

## Module 11: client/mapeditor.js — Validation

### 2-Team Verification

**Barrett:** "Run 1 says hard 2-team. Let me count:"

1. `flags: [{ team: 0, ... }, { team: 1, ... }]` — exactly 2 flags in `newState()`.
2. `spawns: [{ team: 0, ... }, { team: 1, ... }]` — exactly 2 spawns.
3. `f.team === 0 ? '#C8302C' : '#2C5AC8'` — binary ternary for flag colors.
4. `s.team === 0 ? '#C8302C' : '#2C5AC8'` — binary ternary for spawn colors.
5. Point type dropdown: `flag0 | flag1 | spawn0 | spawn1` — hard 2-team options.
6. `_state.flags.find(f => f.team === team)` — finds ONE flag per team. With 4 teams, each team needs a flag, but the code only has entries for 0 and 1.

**Barrett:** "6 hardcoded 2-team sites. Run 1 counted 5 (they missed the find/filter logic that assumes team 0 or 1). All confirmed."

### NEW Finding: No validation on structure placement

**Muratori:** "Run 1 focused on 2-team issues but missed something practical: structures can be placed at any canvas position, including overlapping each other. There's no collision check. You can stack 50 generators on the same pixel. The `test()` function is a stub (shows an alert). The `clearStructures()` only clears ALL structures — no individual delete or undo."

### Verdict: **KEEP (scaffolding) — VALIDATED ✅**

---

## Module 12: client/replay.js — Validation

### 2-Team Verification

**Barrett:** "Run 1 says hard 2-team. Confirmed:"

1. Player dots: `p.team === 0 ? '#FF6464' : '#6498FF'` — binary, no fallback for teams 2-3.
2. Flag positions: `f.team === 0 ? '#C8302C' : '#2C5AC8'` — binary.
3. Score display: `${snap.teamScore[0]} : ${snap.teamScore[1]}` — only 2 scores rendered.
4. Kill markers: `c.killerTeam === 0 ? '#C8302C' : c.killerTeam === 1 ? '#2C5AC8' : '#D4A030'` — has a 3rd fallback. Slightly more resilient than binary.
5. Flag carrier ring: `p.carryingFlag === 0 ? '#C8302C' : '#2C5AC8'` — binary.

**Barrett:** "5 sites. Run 1 found all of them. The kill marker color has a 3-way check (team 0, team 1, or fallback gold) which is the closest any of these modules get to handling team > 1. But it's still not 4-tribe-ready."

### RAF Loop Verification

**Carmack:** "Run 1 didn't call out replay's RAF loop as a problem. Let me check..."

```javascript
function loop(ts) {
    if (!_state) return;
    // ... playback logic ...
    render();
    renderHud();
    _rafId = requestAnimationFrame(loop);
}
```

**Carmack:** "The replay has its own RAF loop, BUT this is correct for replay. The replay viewer runs INSTEAD OF the game renderer — it's a completely separate screen (the #replay-overlay covers everything). It's not a second loop running alongside the game; it's the ONLY loop active when replays are open. This is the right pattern for a modal full-screen view. Command_map and zoom are wrong because they run ALONGSIDE the game loop."

### NEW Finding: Memory leak on repeated open/close

**ryg:** "Each call to `show()` calls `_rafId = requestAnimationFrame(loop)` after `cancelAnimationFrame(_rafId)`. But `buildOverlay()` is called lazily on first show. The overlay DOM stays in the document after `close()` — it's just `display:none`. That's fine. But `_state = null` in `close()` means the next `openFromArrayBuffer` re-parses and re-allocates everything. For large replays, this is a lot of work. There's no reuse of the previous parse."

### Verdict: **KEEP — VALIDATED ✅**

---

## Cross-Cutting Validations

### 2-Team Hardcoding Count

Run 1 claimed: "7 of 12 modules fail."

| Module | Run 1 | Run 2 Verified | Details |
|--------|-------|----------------|---------|
| minimap | ❌ | ❌ CONFIRMED | 2 color arrays, flag loop `< 2`, BUT player dots have `\|\| '#888'` grey fallback |
| command_map | ❌ | ❌ CONFIRMED | 2 team colors + fallback, flag loop `< 2`, legend text binary |
| palette | ❌ | ❌ CONFIRMED | Binary `teamColor()` logic, only teamRed/teamBlue defined |
| combat_fx | ❌ | ❌ CONFIRMED | Single tracer color `0xffd070`, no team parameter |
| mapeditor | ❌ | ❌ CONFIRMED | 2 flags, 2 spawns, binary color ternaries |
| replay | ❌ | ❌ CONFIRMED | Binary player/flag/carrier colors, 2-score display |
| sky_custom | ✅ | ✅ CONFIRMED | No team references |
| toonify | ✅ | ✅ CONFIRMED | No team references |
| zoom | ✅ | ✅ CONFIRMED | No team references |
| cohesion | ✅ | ✅ CONFIRMED | No team references |
| debug_panel | ✅ | ✅ CONFIRMED | Not applicable |
| audio | ✅ | ✅ CONFIRMED | No team references |

**Verdict: Run 1's count of 7/12 is WRONG. It's 6/12.**

Run 1 listed: minimap, command_map, palette, mapeditor, replay, combat_fx, and "all flag-related code." But combat_fx has no 2-team HARDCODING per se — it uses a single brass color for ALL teams (it doesn't distinguish teams at all). The issue is MISSING team differentiation, not wrong team hardcoding. That's a semantic distinction but an important one:
- **Hardcoded to 2 teams** (broken for 4): minimap, command_map, palette, mapeditor, replay — **5 modules**
- **Team-agnostic but SHOULD differentiate** (missing feature): combat_fx — **1 module**

Total modules with team-related issues: still 6. But the nature differs. Run 1 conflated "hardcoded to 2" with "missing team support."

### Self-RAF Loop Count

Run 1 claimed: "2 modules (command_map, zoom) run their own RAF loops."

**Verified: CORRECT — but incomplete.** Three modules use RAF:

| Module | Own RAF? | Justified? |
|--------|---------|-----------|
| command_map | ✅ Yes (conditional on open) | ❌ Should use main loop |
| zoom | ✅ Yes (unconditional, always running) | ❌ Should use main loop |
| replay | ✅ Yes (full-screen modal) | ✅ Correct — replay IS the rendering context |

Run 1 correctly flagged 2 as problems and correctly didn't flag replay (though it didn't explain why replay's was OK).

### Palette Adoption

Run 1 said "nobody uses it." **CONFIRMED — and it's worse.** Not only is palette unused, the modules that hardcode colors use DIFFERENT colors from each other AND from the palette. There's a team 0 = blue vs team 0 = red inconsistency between minimap/command_map and mapeditor/replay/palette.

---

## Design Intent Validation

### Core Feeling Assignments (Run 1 → Run 2)

| Module | Run 1 Assignment | Run 2 Challenge |
|--------|-----------------|----------------|
| combat_fx | Scale + Aliveness | **VALIDATED.** Tracers visible at distance = Scale. Muzzle flash/hit feedback = Aliveness. Both correct. |
| minimap | Belonging + Scale | **VALIDATED.** Seeing team positions = Belonging. Spatial awareness = Scale. |
| sky_custom | Scale + Aliveness | **VALIDATED.** Sky is 80% of view while jetting = Scale. Day/night cycle = Aliveness. |
| command_map | Scale + Belonging | **VALIDATED.** Whole-map overview = Scale. Team formation awareness = Belonging. |
| toonify | Visual Identity | **CHALLENGE: Run 1 mapped this to 'Visual Identity (supports readability, which supports Scale).' But the toon shader makes things LESS readable at distance — flat shading removes depth cues. It serves Aesthetic Cohesion (the game looks intentional), not Scale. Corrected.** |
| zoom | Scale | **VALIDATED.** Collapsing distance = Scale. |
| cohesion | Aliveness (mood bed) | **VALIDATED.** Atmospheric drone = environmental Aliveness. |
| palette | Visual Identity | **VALIDATED.** Color system = identity foundation. |
| debug_panel | N/A | **VALIDATED.** Developer tool. |
| audio | Aliveness | **VALIDATED.** Sound = environmental Aliveness. |
| mapeditor | N/A (creator tool) | **VALIDATED.** |
| replay | Mastery + Belonging | **VALIDATED.** Review for improvement = Mastery. Watching team play = Belonging. |

### Naming Verdicts

| Module | Current Name | Run 1/Phase 6 Proposed | Run 2 Verdict | Rationale |
|--------|-------------|----------------------|--------------|-----------|
| renderer_toonify.js | toonify | `renderer_style.js` | **KEEP `renderer_toonify.js`** | "Style" is vague. The module toonifies. The name says so. Don't rename for abstraction's sake. |
| renderer_palette.js | palette | `renderer_team_colors.js` or fold into team_config.js | **KEEP `renderer_palette.js`** | The palette is MORE than team colors — it defines accent, danger, safe, bg, fg, sky. "Team colors" would be reductive. When the module becomes an ES module, the filename stays palette. |
| renderer_sky_custom.js | sky_custom | `renderer_sky.js` | **RENAME to `renderer_sky.js`** | There's no "default" sky to distinguish from. `_custom` suffix implies an alternative exists; it doesn't. The module IS the sky system. Drop `_custom`. |
| renderer_cohesion.js | cohesion | (killed) | **KILL — no rename needed** | Dead module. |
| renderer_combat_fx.js | combat_fx | (no proposal) | **KEEP `renderer_combat_fx.js`** | Accurate. Combat effects. |
| renderer_minimap.js | minimap | (no proposal) | **KEEP `renderer_minimap.js`** | Accurate. Classic FPS term. |
| renderer_command_map.js | command_map | (no proposal) | **KEEP `renderer_command_map.js`** | Accurate. Tribes terminology. |
| renderer_zoom.js | zoom | (no proposal) | **KEEP `renderer_zoom.js`** | Accurate. |
| renderer_debug_panel.js | debug_panel | (no proposal) | **KEEP `renderer_debug_panel.js`** | Accurate. |
| client/audio.js | audio | (no proposal) | **KEEP `client/audio.js`** | Accurate. |
| client/mapeditor.js | mapeditor | (no proposal) | **KEEP `client/mapeditor.js`** | Accurate. |
| client/replay.js | replay | (no proposal) | **KEEP `client/replay.js`** | Accurate. |

### Absorption Candidates

**Muratori:** "Run 1 flagged toonify as a potential absorption into a future `renderer_materials.js`. Let me evaluate other candidates."

| Candidate | Absorb Into | Verdict |
|-----------|------------|---------|
| palette + toonify | `renderer_visual_identity.js` | **NO.** Palette is data (color values). Toonify is behavior (material conversion). Different concerns. Keep separate. |
| cohesion mood bed → audio.js | `client/audio.js` | **YES.** 42 lines of WebAudio code. Audio module is the canonical home. |
| combat_fx absorbing polish from renderer.js | (from renderer.js) | **MAYBE.** If renderer.js has scattered weapon FX (recoil, shell casings), those should move to combat_fx. But this requires reading renderer.js to verify — out of scope for Phase 4. |
| minimap + command_map shared tactical renderer | `renderer_tactical_utils.js` | **DEFERRED.** Muratori's observation from Run 1 is correct — they share coordinate transforms and drawing patterns. But the ROI is low (60 lines of shared code) and the abstraction adds complexity. Revisit during renderer.js decomposition. |
| palette folding into team_config | N/A | **NO.** Palette is broader than team config. It includes accent, status, neutral, and sky colors. Team config doesn't exist yet. |

---

## Run 1 Verdicts: Validated / Challenged / Changed

| Module | Run 1 Verdict | Run 2 Status | Notes |
|--------|--------------|-------------|-------|
| renderer_combat_fx.js | KEEP | **VALIDATED ✅** | Added: singleton limits spectator mode; flashHit uncached DOM query |
| renderer_minimap.js | KEEP | **VALIDATED ✅** | Corrected: player dots DO have grey fallback (`\|\| '#888'`), not invisible. Team color inconsistency with palette newly identified. |
| renderer_sky_custom.js | KEEP (model) | **VALIDATED ✅** | Added: hardcoded THREE import path is the one blemish on "model module" claim |
| renderer_command_map.js | KEEP | **VALIDATED ✅** | Added: FOW logic IS 4-team-safe; resize debounce needed; potential double-draw if renderer.js also calls update() |
| renderer_toonify.js | KEEP (flag absorption) | **VALIDATED ✅** | Challenge: absorption into materials module rejected — keep separate for skip-list visibility |
| renderer_zoom.js | KEEP | **VALIDATED ✅** | Added: RAF loop is WORSE than command_map's (unconditional, always running) |
| renderer_cohesion.js | KILL | **VALIDATED ✅** | Fully confirmed. 42 lines of mood bed → audio.js. Everything else is dead code. |
| renderer_palette.js | KEEP + expand | **VALIDATED ✅ + SEVERITY UPGRADED** | NEW: team color inconsistency across codebase. Not just unused — actively contradicted. |
| renderer_debug_panel.js | KEEP (debug) | **VALIDATED ✅** | No changes |
| client/audio.js | KEEP | **VALIDATED ✅** | isReady() 'lie' is harmless in practice (nothing uses it as a gate) |
| client/mapeditor.js | KEEP (scaffolding) | **VALIDATED ✅** | Added: no structure overlap detection, no individual delete |
| client/replay.js | KEEP | **VALIDATED ✅** | Added: replay RAF is CORRECT (modal context, not alongside game). Memory: no parse reuse on re-open. |

---

## New Findings Not in Run 1

1. **Team Color Inconsistency Across Codebase (P1 bug):** Minimap/command_map use team 0 = blue (`#3FA8FF`), team 1 = red (`#FF6A4A`). Mapeditor/replay use team 0 = red (`#C8302C`), team 1 = blue (`#2C5AC8`). Palette itself says team 0 = red (`#E84A4A`). The minimap has the team mapping INVERTED. This is a latent visual bug.

2. **Palette color values don't match ANY consumer:** Palette defines `teamRed: '#E84A4A'` and `teamBlue: '#4A8AE8'`. No module uses these exact hex values. Everyone hardcodes their own variants. The palette isn't just unused — it's irrelevant to the actual rendered colors.

3. **renderer_zoom.js RAF is unconditional:** Unlike command_map (which only RAFs when open), zoom's RAF runs EVERY frame from page load, even when zoom = 1.0. This is the worst self-RAF offender.

4. **renderer_command_map.js FOW logic is 4-team-safe:** The `team !== localTeam` check works for any number of teams. Only the color arrays and flag loop need 4-tribe fixes, not the visibility logic.

5. **client/replay.js RAF is correctly self-contained:** Unlike command_map/zoom, replay's RAF is the correct pattern — it's a full-screen modal replacing the game renderer, not running alongside it.

6. **renderer_minimap.js player dots have grey fallback:** Run 1 claimed teams 2-3 would be invisible. They'd actually be grey (#888). The fallback exists in the code.

7. **renderer_command_map.js terrain rebuild on resize has no debounce:** Window resize drag triggers dozens of full per-pixel heightmap renders per second.

8. **`#FFC850` accent color IS used consistently (just not via palette):** The accent color appears in command_map (7 sites), zoom (3 sites), debug_panel (1 site), and renderer.js (3 sites). Everyone agrees on the accent color. They just don't import it from palette — they hardcode the same hex.

9. **renderer_sky_custom.js hardcodes Three.js vendor path:** Only sky module uses `import * as THREE from './vendor/three/r170/three.module.js'` directly. All others receive THREE via parameter injection or rely on the global. This coupling is unique.

10. **renderer_combat_fx.js is a singleton — no spectator/multi-player FX:** The IIFE produces one CombatFX object parented to one weapon hand. Can't render muzzle flashes for other players in spectator mode or third-person view.

---

## Naming Verdict (Final)

| Module | Keep / Rename |
|--------|--------------|
| renderer_combat_fx.js | **KEEP** |
| renderer_minimap.js | **KEEP** |
| renderer_sky_custom.js | **RENAME → `renderer_sky.js`** |
| renderer_command_map.js | **KEEP** |
| renderer_toonify.js | **KEEP** |
| renderer_zoom.js | **KEEP** |
| renderer_cohesion.js | **KILL** (no rename needed) |
| renderer_palette.js | **KEEP** |
| renderer_debug_panel.js | **KEEP** |
| client/audio.js | **KEEP** |
| client/mapeditor.js | **KEEP** |
| client/replay.js | **KEEP** |
