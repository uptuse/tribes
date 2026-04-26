# R32.7+ Visual Polish — "Buy Not Build" Plan

50 renderer-only upgrades, mapped to existing Three.js libraries/examples so we
port battle-tested code instead of reinventing it. Renderer-only, no C++/WASM,
no Claude touchpoints.

## Source library shortlist (all MIT/permissive)

| Library | Use | Notes |
|---|---|---|
| `three/addons` (built-in `examples/jsm`) | Sky, Water, EffectComposer, UnrealBloomPass, OutputPass, SSAOPass, FilmPass, GlitchPass, OutlinePass, LensflareShader, LightningStrike, DecalGeometry, BoxLineGeometry, SubdivisionModifier reference | Already in our importmap — zero new deps |
| `pmndrs/postprocessing` | Higher-quality bloom (selective), SSAO, vignette, chromatic aberration, noise, outline, godrays, depth-of-field | Battle-tested in production, drop-in EffectComposer replacement |
| `three-stdlib` | Polyfilled three/addons | Fallback if a built-in addon is broken |
| `three-volumetric-clouds` (Faraz) | Ray-marched clouds | Demo-quality, plug into existing EffectComposer |
| Faraz rain-puddle demo | Rain + ripples + puddles + lightning | Single bundle, MIT, drop in |
| `three-mesh-bvh` | Fast spatial query (decals, splash/footstep ground sampling) | Already battle-tested |
| ambientCG / Poliigon free PBR | Free CC0 textures (concrete, metal panel, asphalt, dirt) | Direct download, drop into `assets/textures/` |
| Polyhaven HDRI | Free CC0 environment maps | For IBL — gives metal real reflections |
| Three.js Sky | Preetham analytic sky | Built-in, zero deps |
| Three.js LightningStrike | Animated lightning bolt mesh | Built-in addon |
| Three.js Lensflares | Sun lens flares | Built-in |
| Three.js DecalGeometry | Bullet holes, scorch marks, blast craters | Built-in addon |

## The 50, mapped

### Atmosphere & lighting (1–10)
| # | Item | Source | Effort |
|---|---|---|---|
| 1 | Procedural sky w/ Preetham model | `three/addons/objects/Sky.js` | XS |
| 2 | Sun direction synced to Sky | Sky's `uniforms.sunPosition` | XS |
| 3 | HDRI environment map for IBL | Polyhaven CC0 + `RGBELoader` | S |
| 4 | ACES filmic tone mapping | `renderer.toneMapping = THREE.ACESFilmicToneMapping` | XS |
| 5 | Tuned exposure + film color grade | LUT pass via pmndrs `LUT` effect | S |
| 6 | UnrealBloom selective on emissives | `UnrealBloomPass` already imported via comp | XS |
| 7 | SSAO ground-contact AO | pmndrs `NormalPass` + `SSAOEffect` | S |
| 8 | Volumetric godrays through clouds | pmndrs `GodRaysEffect` | M |
| 9 | Hemisphere fill light from sky color | `HemisphereLight`, color sampled from Sky | XS |
| 10 | Cascaded shadow tuning | `CSM` from `three/addons/csm` | M |

### Geometry detail (11–20)
| # | Item | Source | Effort |
|---|---|---|---|
| 11 | Loop subdivision behind `?detail=high` | `three-subdivide` npm or `three/examples/jsm/modifiers/SubdivisionModifier` | S |
| 12 | Edge bevel via inset poly | Hand JS — `BufferGeometryUtils.mergeVertices` + cone offset | S |
| 13 | Procedural greebles on building tops | Custom kit-bash JS (~50 lines) | M |
| 14 | Bridge railings | Custom Group of `BoxGeometry` posts + cylinder rail | XS |
| 15 | Tower window emissive cutouts | PlaneGeometry overlay on tower facade | S |
| 16 | Generator chimney smoke | `three.quarks` particle library OR simple sprite plume | S |
| 17 | Rocket turret missile cluster split | Replace single box with 4× cylinders | XS |
| 18 | Plasma turret coil emissive ring | TorusGeometry + `MeshBasicMaterial({color: cyan})` | XS |
| 19 | Sensor dish detail (ribs, mounting) | Custom 4× cylinders + ring | XS |
| 20 | Soldier visor real geometry | LatheGeometry curve | S |

### Materials & shaders (21–30)
| # | Item | Source | Effort |
|---|---|---|---|
| 21 | Inferno faction grunge variant | ambientCG `MetalPlate006` + tint | S |
| 22 | Storm faction chrome variant | ambientCG `Metal027` + cooler tint | S |
| 23 | Wear-and-tear armor over time | Custom shader, simple noise-based dirt mask, time-driven | M |
| 24 | Energy weapon emissive + bloom | Already wired via #6 | XS |
| 25 | Flag fabric cloth wave | Vertex displacement shader (sin-based) — built-in `Cloth` example reference | S |
| 26 | Holographic station icons | `Sprite` with canvas-rendered glyph | S |
| 27 | Animated team emblem | Canvas texture animated per-frame on chest plate | M |
| 28 | Jetpack heat shimmer | `MeshNormalMaterial` distortion via composer screen-space distort | S |
| 29 | Ground decal system | `DecalGeometry` from three/addons | S |
| 30 | Wet terrain shader (rainy Raindance) | Custom — dial up roughness near 0.1 + emissive blue tint | S |

### FX & atmospherics (31–40)
| # | Item | Source | Effort |
|---|---|---|---|
| 31 | Improved rain (depth-aware) | Faraz rain-puddle demo port | M |
| 32 | Lightning flash + scene-light pulse | `LightningStrike` addon | S |
| 33 | Distant thunder (audio + slight cam shake) | `THREE.Audio` + custom timing | S |
| 34 | Jetpack ground scorch | Decal projector on jet impact | S |
| 35 | Footstep dust puffs | Sprite particle on stride event | S |
| 36 | Skiing dust trail | Continuous emitter while `skiing` flag set | S |
| 37 | Projectile contrails | `Line2` from `three/addons/lines` w/ fade | S |
| 38 | Explosion shockwave + screen distort | pmndrs `ShockWaveEffect` | S |
| 39 | Nameplate redesign | Canvas refactor — already have framework | S |
| 40 | Compass + objective HUD ring | Canvas overlay element | M |

### Polish & UX (41–50)
| # | Item | Source | Effort |
|---|---|---|---|
| 41 | Camera shake on near-miss | Hand: trauma scalar -> `camera.position` jitter | XS |
| 42 | FOV punch on jet boost | Animate `camera.fov` w/ `lerp` | XS |
| 43 | Damage vignette pulse | pmndrs `VignetteEffect` w/ red tint, time-driven | XS |
| 44 | Death cam slow-mo + look-at-killer | Animate `THREE.Clock` scale + camera target | M |
| 45 | Spawn shimmer fade-in | Custom shader, ~15 lines vertex displacement | S |
| 46 | Flag pickup screen flash + sting | DOM CSS animation + `THREE.Audio` ping | XS |
| 47 | Capture cam pull-back | Camera state machine, `cinematic_state = capture` | M |
| 48 | Loading screen w/ map preview + tip | DOM/CSS, no Three | S |
| 49 | Settings panel for graphics quality | DOM/CSS + composer reconfigure | M |
| 50 | Telemetry HUD (fps/ping/players/speed) | DOM overlay reading existing state | S |

## Sequencing strategy

To keep visible-progress milestones, integrate in this order (NOT 1→50):

**Phase A (foundation)** — 1, 2, 3, 4, 6, 9, 10
The Sky+HDRI+ACES+Bloom combination is the single highest-ROI change. Doing
those first gives every subsequent item a better-looking baseline to layer on.

**Phase B (atmosphere)** — 31, 32, 33, 7, 8, 5
Rain+lightning+thunder+SSAO+godrays+LUT. Now Raindance feels like a stormy
basin instead of a flat valley.

**Phase C (architecture)** — 11, 12, 14, 15, 18, 19, 13
Subdivide+bevel+bridge railings+windows+coil+sensor+greebles. Buildings stop
looking like 1998 Tribes.

**Phase D (hero objects)** — 17, 20, 25, 26, 27, 30
Missile cluster, soldier visor, flag fabric, station icons, team emblem, wet ground.

**Phase E (FX)** — 16, 21, 22, 23, 28, 29, 34, 35, 36, 37, 38
Smoke, faction variants, wear, heat shimmer, decals, scorch, footsteps, trails, shockwave.

**Phase F (polish/UX)** — 24, 39, 40, 41, 42, 43, 44, 45, 46, 47, 48, 49, 50
HUD pass + camera feel + UX. Dressing on top of a now-solid visual foundation.

## Approach: single-commit batch

Per user instruction, all 50 ship in one commit (with sub-commit history rebased
to keep clean reverts available). Footer rolls to `R32.7-polish-pass`. Brief
written to Claude only as a stand-down note (no action required).

## Risk register

- **Composer + post-processing layers** — easy to torpedo perf. Plan: ship with
  a `?fx=low|mid|high` URL flag so we can turn it off mid-match if needed.
- **Texture downloads** — ambientCG textures are 1-4MB each. Lazy-load and only
  ship 5-7 essential textures first.
- **Volumetric clouds + godrays** — known to be expensive. Gate behind `fx=high`.
- **Decal accumulation** — bullet holes pile up forever w/o cleanup. LRU cap at
  256 active decals.
