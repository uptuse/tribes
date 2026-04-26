# R31 — Visible playtest bugs (Claude Sonnet, please own this round)

**Status:** Manus has been doing direct surgical edits for R29-R30.2 to unblock the black-canvas bug. We got the canvas alive and made real visual progress — but I (Manus) have hit the limit of what I can fix without your full design context on `renderer.js` and the C++ render bridge. Handing back to you.

This brief is **honest and complete**: what's working, what I tried, what I broke, and what's still wrong. Please absorb the full picture before patching, then push **one comprehensive R31** that addresses the visible bugs the user reported during today's playtest.

---

## TL;DR — what user sees right now (after R30.2)

- Canvas is alive at 60fps; Three.js renders; HUD is gorgeous; movement responds
- Sky is now a blue gradient (no longer banded white wall)
- Terrain is properly lit and visible
- **Buildings render as floating yellow/black unlit cubes** instead of proper PBR turrets/stations
- **Soldiers render as solid black silhouettes** (visSoldiers=4/16 per console, but they're black)
- **Player clips through terrain and buildings** (camera goes UNDER the map)
- **Movement direction does not match camera direction** (press W, slide sideways)
- **NPCs stuck in static T-pose**, some floating in sky
- **`renderer.info` reports `1 draw call, 1 tri` continuously** — likely an EffectComposer artifact (render passes report only the last pass) but should be confirmed
- **Weapon viewmodel** is small + barely visible + not in expected lower-right hand position
- Buildings spawn floating in the air (positions don't account for terrain height)

User quote: "Movement is all weird... when I hit left I expect to move left, right right, etc. but it's awkward."

---

## What I (Manus) did across R29-R30.2 — full audit trail

Every commit is on `origin/master`. Read `comms/CHANGELOG.md` for the one-line audit log.

| Round | Hash | What I changed | Status |
|---|---|---|---|
| R29 | `20e6b6c` (you) | shader precision highp + Three.js init in onRuntimeInitialized + vendored Three.js r170 | Landed |
| R29.1 | `b7b7424` | vendored 5 missing transitive Three.js addon deps + map fetch path GitHub-Pages-friendly | Landed |
| R29.2 | `cabf922` | swapped `initStateViews()` ↔ `initPostProcessing()` order in `renderer.js` start() so camera exists before RenderPass captures it | Landed; was a real bug |
| R29.3 | `65009a3` | added `Module.calledRun` guard on 5 unguarded WASM call sites (compass poll + 4 others) so ASSERTIONS-mode build doesn't spam Aborted | Landed; cosmetic but real |
| R30.0 | `cca2992` | added one-shot `scene.traverse()` diagnostic dump on first frame to see ground truth | Diagnostic only |
| R30.1 | `6a0e97e` | hardened `syncCamera`: bail on invalid localIdx OR finite-but-zero player position; raised initial cam to (0,200,0) lookAt(-300,30,-300); set `scene.background = #9bb5d6` fallback; bumped HemisphereLight intensity 0.55→1.1 | Landed |
| R30.2 | `c40eac5` | rebalanced THREE.Sky uniforms (turbidity 8→2, rayleigh 2.0→1.0, mieG 0.7→0.8); ACESFilmic tone mapping exposure=0.5; PMREM env from Sky → `scene.environment`; positioned sun at boot in initStateViews; resized weapon viewmodel; explicit SRGBColorSpace | Landed; partial fix |

**I did NOT touch C++ code.** All my edits were in `renderer.js` (~13 small surgical changes) + `index.html` (~5 calledRun guards + 2 map paths) + `shell.html` (mirror) + vendoring of Three.js files. I did NOT recompile WASM (kept `tribes.js`/`tribes.wasm` from your R29 build).

---

## Console diagnostic — current ground truth (post R30.2)

The user pasted a console after R30.2. Key data:

```
[R30.2] PMREM environment built from Sky shader; PBR materials now lit   ← landed
[R30.0] === SCENE DIAGNOSTIC DUMP (one-shot) ===
[R30.0] scene root has 336 immediate children:
  [0] HemisphereLight visible=true
  [1] DirectionalLight visible=true
  [3] Mesh ShaderMaterial bbox=[-1,-1,-1 → 1,1,1]                      ← Sky shader, correct
  [4] Mesh MeshStandardMaterial bbox=[-1024,7,-1024 → 1024,77,1024]    ← terrain, correct
  [5..43] Group +2 children                                             ← 39 buildings, OK shape
  [44..70] Mesh MeshBasicMaterial color=#9ddcff bbox=[-1,-1,-1 → 1,1,1] ← spawn shield bubbles, fine
  [71..86] Mesh MeshStandardMaterial color=#ffffff bbox=[0,0,0]         ← ⚠️ ALL ZERO BBOX
  ...
[R30.0] renderer.info: 1 calls, 1 tris, 141 geom, 17 tex, programs=17
[R30.0] scene.background: #9bb5d6  scene.fog: undefined density=0.0006
[R18] 60fps, 1 draw calls, 1 tris, quality=high | cam=(-260,21,-11) localIdx=0 visSoldiers=4/16
```

Camera position moves correctly with player input (going from -232,26,-26 → -271,33,63 → -260,21,-11 as user plays). So **input is reaching WASM and WASM is updating the player position**. But the rendered scene shows almost nothing of the world.

**Two big mysteries Claude needs to verify:**

1. **`renderer.info` says 1 draw call, 1 tri.** Is this a real symptom (almost nothing being drawn) or an EffectComposer artifact (only counting the final composite pass)? My hypothesis: it's the latter (composer with bloom/output passes resets the stats per pass and `info.render.calls` only reflects the last). To prove/disprove: temporarily disable post-processing OR sum `renderer.info.render.calls` across passes via callbacks. If it's truly 1 draw call, then 95% of the scene is being culled.

2. **Many sub-meshes have bbox `[0,0,0 → 0,0,0]`** — including soldiers ([71..86]) and several other items. Three.js frustum-culls anything whose `geometry.boundingSphere.radius === 0` once the bbox is at origin. **Soldiers may be invisible because their bounding sphere is wrong**, not because `mesh.visible=false`. Your skeletal-rig setup needs a `geometry.computeBoundingSphere()` after the first skin update, OR a generous manual `boundingSphere` set at construction time.

---

## Specific bugs to fix (ranked by visual impact)

### 1. Soldiers render as solid black silhouettes (CRITICAL)

User screenshot (today's playtest) shows them as dark unlit figures. Two possible causes:
- Skeletal mesh `material` is `MeshStandardMaterial` color #ffffff but receives no light because **the rig hasn't been bound** correctly to the geometry → no normals → no PBR shading → reads as black
- OR the frustum culling kills them via the bbox=(0,0,0) issue, so what we see is leaked accent meshes from another source

Fix path: in `addSoldier()` / wherever soldiers are constructed in `renderer.js`, set `mesh.frustumCulled = false` on the rig root, OR `geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 5)` (5m radius around origin), AND ensure normals are computed/recomputed after vertex skinning.

### 2. Buildings render as floating yellow/black blocks (CRITICAL)

User's screenshot shows a **yellow rectangular box floating in the air**. From `renderer.js` (around line 441/450 in `createBuildingMesh`): stations have `MeshBasicMaterial({ color: 0xFFC850 })` for ring + display panels — these are **unlit accent decorations**. They get drawn **but the parent body** (a `MeshStandardMaterial` cylinder/cube) is **not visible** because it has bbox=(0,0,0) and is being frustum-culled.

Same root cause as soldiers: PBR sub-meshes are getting culled, only the unlit accents survive.

Fix path: walk every Group in `buildingMeshes`, recursively `child.frustumCulled = false` OR set sane bounding spheres at construction.

### 3. Buildings spawn floating in air (HIGH)

Per the screenshot, the yellow cube hovers ~30m up. C++ side `setMapBuildings` reads positions from mission data, but probably places them at flat Y from the map JSON without sampling the terrain heightmap at that X,Z. Need to either (a) clamp Y to `terrainHeight(X,Z)` in C++, or (b) accept the design intent that some buildings ARE supposed to be on tall pillars.

Recommend: in C++ `loadMission()`, sample heightmap at building (X,Z) and add a small offset so the foundation sits on terrain.

### 4. Movement direction ≠ camera direction (HIGH)

User reports: "press W, slide sideways." Combined with the fact that the camera position IS updating correctly per WASM, and the C++ side is doing the movement math, this is almost certainly a **yaw-convention mismatch** between Three.js camera (Y-up, looks down -Z, yaw rotates around Y) and WASM player (likely Z-up or some other handedness).

Look at `renderer.js` syncCamera around line 1133:
```js
camera.rotation.set(pitch, yaw, 0, 'YXZ');
```

Possible fix: try `camera.rotation.set(pitch, yaw + Math.PI, 0, 'YXZ')` (180° yaw flip), OR negate pitch, OR change rotation order. The C++ side controls movement based on its own yaw, so the camera needs to MATCH that yaw — not the other way around. Test by walking forward and confirming camera moves the same way as crosshair points.

### 5. Player clips through terrain (HIGH — C++ work)

User can fall through the ground. C++ side either has no terrain collision check or the heightmap lookup is broken. Look in `wasm_main.cpp` for player physics tick — there should be a `playerY = max(playerY, terrainHeightAt(playerX, playerZ) + 1.7)` or similar ground clamp. If missing, add it. If present, check the lookup is in correct world units.

### 6. NPCs stuck in static pose (MEDIUM — C++ AI)

Bots load (Fury/Viper/Storm/Ghost/Blaze/Raptor/Shadow) and the `[KILL]` log shows kills happen, so the AI brains are running. But visually they don't animate. Two possible causes:
- (a) The skeleton transforms aren't being driven by the simulation tick — animation system disconnected from C++ → JS bridge
- (b) The animation system runs in C++ (legacy) but R15 disabled the C++ render loop, and the new Three.js path doesn't pull animation state

Fix path likely: add to renderer.js `syncSoldiers()` a call to `Module._getPlayerAnimState(idx)` and apply to the skeleton bones each frame.

### 7. Weapon viewmodel position (MEDIUM)

I (Manus) made it smaller in R30.2 but it's now in a weird spot. Should be **firmly in lower-right of viewport, gun barrel pointing forward, slightly tilted**. Standard FPS rig: position relative to camera local space `(0.25, -0.20, -0.45)`, rotation `(0, 0.05, 0)`, scale appropriate for camera FOV=90.

### 8. `renderer.info` "1 draw call, 1 tri" (LOW — just verify it's a measurement artifact)

Add a single-frame diagnostic that disables EffectComposer and reads `renderer.info.render.calls` directly. If still 1, real bug. If 100+, just measurement artifact and we can remove the misleading log.

---

## Things to NOT change

- Don't revert any R29-R30.2 fixes; they're correct (precision, vendoring, init order, calledRun guards, sky uniforms, PMREM env)
- Don't remove the R30.0 diagnostic dump yet — useful for verifying R31 results
- Don't touch the comms/CHANGELOG.md format
- Don't bump version footer past `0.4 / R29 hotfix` — your call when to mark `0.5`

---

## Acceptance criteria for R31

User reloads, hits PLAY, plays for 30 seconds. They see:

1. Sky: blue gradient (already fixed) — no regression
2. Terrain: lit green-brown with shading — no regression
3. **Buildings**: at least some properly-lit gray turrets/stations visible at proper terrain-grounded positions, NOT floating yellow boxes
4. **Soldiers**: visible as lit gray armored figures, NOT solid black silhouettes
5. **Movement**: pressing W moves the camera in the direction it's pointing; A strafes left; D strafes right; mouse looks
6. **No terrain clipping**: player stays on top of the ground
7. **NPCs animate** (running animation when moving)
8. **Weapon viewmodel** clearly visible in lower-right
9. Console shows R30.0 diagnostic + at least 5+ draw calls in renderer.info (or proof the "1" was a measurement artifact)

If you can land 6/9 you're done; the remaining can be R31.1.

---

## Open questions for you to decide

1. Is the legacy WebGL renderer still needed? (R30 was originally planned to be "delete legacy renderer entirely" but we never got there because R29 hotfix cascade ate the time. Your call: delete now in R31, or keep until after multiplayer playtest?)
2. Should `renderer.info` accumulator across composer passes be added to the diagnostic permanently?
3. C++ collision system — do you want to fix the `loadMission` to clamp building positions to terrain, or change the renderer to clamp visually? Former is correct, latter is faster.

---

Cron will trigger you in ~5 min. Take whatever time you need. I'll review the diff and accept or kick a follow-up. Thanks for picking up the round.
