# Design Intent Map — Firewolf

*Phase 6 Audit Deliverable — 2026-04-29*
*Ive's Razor: "If you can't articulate what sensation this module creates for the player, it's noise."*

---

## Core Feelings Reference

| Feeling | Key Word | Systems That Should Serve It |
|---|---|---|
| **Belonging** | tribe needs me | Armor interdependence, vehicle dependency, base infrastructure, shared objectives, team identity, flags, role differentiation |
| **Adaptation** | game is changing | Phase system, rising lava, fog, mech waves, shifting optimal strategies, phase-reactive atmosphere |
| **Scale** | vast world, speed | Terrain, skiing, jetting, altitude, long sightlines, procedural sky, day/night enormity |
| **Aliveness** | world breathes | Day/night, fairies, weather FX, phase atmospheres, generative audio, interior lights, particle systems |

---

## Module → Feeling Map

### Tier 1 — The Spine

These modules carry the core experience. Without any one of them, the game doesn't feel like Firewolf.

---

#### renderer.js (6,094 lines)

**Contains ~17 subsystems. Each mapped individually:**

| # | Subsystem | Lines (approx) | Core Feeling | Justification |
|---|---|---|---|---|
| 1 | **Terrain rendering** | L87–1146 (~1,060) | **Scale** | The vast faceted landscape IS the game's visual identity. 257×257 heightmap at scale 16–32 = 4–8km maps. Splat weights, watercolor wash, PBR array textures — all in service of a world you want to traverse at speed. Every ski route, every ridgeline, every valley reads from a distance. |
| 2 | **Building system** | L1217–1631 (~415) | **Belonging** | Bases are home. Generator rooms, inventory stations, flag stands — your tribe operates from these structures. Canonical mesh classification means a generator LOOKS like a generator. Team-color accents mark territory. |
| 3 | **Interior system** | L1632–2417, L4766–4832 (~850) | **Belonging** | Interior spaces — the generator room, the command center, the corridors — are where you feel the base is yours. PBR procedural textures, crease normals, interior lighting all serve the sensation of being INSIDE a place your tribe owns. |
| 4 | **Base accents** | L2617–2788 (~170) | **Belonging** | Team-color accentuation on base structures. You see YOUR tribe's color on YOUR base from across the map. Tribal identity, made visual. |
| 5 | **Player rendering** | L2789–3078, L3744–3888 (~425) | **Belonging** + **Scale** | Readable silhouettes at 300m. Nameplates with tier colors. Three armor types visually distinct. You can tell friend from foe, heavy from light, at a glance. This is how you know your tribe from theirs. The 64-player sync is what makes the world feel populated. |
| 6 | **Projectile rendering** | L3079–3095, L3937–3955 (~80) | **Adaptation** | Projectiles are information. A mortar arc tells you a heavy is sieging. A disc trail tells you someone's dueling. Reading these trajectories IS the adaptation loop — you change behavior based on what you see flying. |
| 7 | **Flag rendering** | L3096–3121, L3956–3973 (~80) | **Belonging** | The flag is the tribe's heart. Its visual state (home, carried, dropped) drives every player's immediate decision. The flag IS belonging made tangible — protect it, retrieve it, capture theirs. |
| 8 | **Weapon viewmodel** | L3122–3356, L3889–3936 (~280) | **Belonging** + **Adaptation** | The gun in your hand defines your role. Viewmodel sway (jet dip, ski lean, idle drift) gives physicality to movement — you FEEL the speed through your weapon's motion. Weapon switching during phase transitions is adaptation. |
| 9 | **Day/Night cycle + Lighting** | L360–640 (~280) | **Aliveness** + **Scale** | The world has time. Sunlight sweeps across 4km of terrain. Night bloom makes fairies glow. The sun position drives shadow direction across the entire map. Day/night is what makes the world feel like a PLACE, not a level. |
| 10 | **Post-processing** | L3487–3653 (~166) | **Aliveness** + **Scale** | Night-adaptive bloom, cinematic LUT, vignette — these create atmosphere. Bloom at night makes the world glow. Color grading gives each moment its mood. Without post-processing, the world is lit but not atmospheric. |
| 11 | **Camera + Spectator** | L3654–3743, L4052–4278 (~310) | **Scale** | The camera IS the player's relationship to space. Third-person camera at speed creates the sensation of traversing vast terrain. Spectator mode on death maintains spatial awareness. Camera sync from WASM keeps the player grounded in the physics. |
| 12 | **Particle systems (6 total)** | L3443–5263 (~1,700) | **Scale** + **Aliveness** | Broken down: |
| | — Jet exhaust | L4457–5263 | **Scale** | Thruster trails prove you're moving through space at speed. Two-nozzle emission on jetting players. |
| | — Ski particles | L4520–4643 | **Scale** | Terrain contact feedback. You're touching this vast world, carving through it. The canonical GPU particle pattern. |
| | — Projectile trails | L4644–4832 | **Adaptation** | Trails make projectiles readable at distance. You track trajectories to dodge. Information density. |
| | — Explosion FX | L4833–5021 | **Adaptation** | Impact feedback. Where the mortar hit, where the disc landed. You adapt to splash patterns. |
| | — Night sky fairies | L5022–5183 | **Aliveness** | Firefly-style GPU particles in the night sky. Atmospheric. The sky breathes. |
| | — Legacy particles | L3443–4051 | **Aliveness** | General-purpose particle pool for misc effects. The glue that ties other systems together. |
| 13 | **Rain system** | L3357–3442 (~85) | **Aliveness** | ⚠️ **DISABLED** (opt-in only). Raindance.MIS snowfall homage. When enabled: atmosphere, weather, the world has climate. Currently gated behind a flag — not contributing. |
| 14 | **Grass ring** | L5504–5755 (~250) | **Aliveness** + **Scale** | ⚠️ **DISABLED** on most tiers. Camera-local thin-blade grass. When active: ground-level life, the terrain isn't bare. Scales with quality tier. Currently only on high+ and often skipped in init. |
| 15 | **Ground fairy layer** | L5756–6094 (~338) | **Aliveness** | Map-wide rainbow fairies (renamed from "dust layer"). 64K scurrying motes across the entire playable area. Firefly fade-in/out cycles. THIS is the primary Aliveness system in the current build. |
| 16 | **Quality tiers + Infrastructure** | L102–359, L4364–4456, L5266–5503 (~450) | *(Infrastructure)* | Render loop, resize handler, quality tier switching, map loading, first-frame diagnostic. Not player-facing sensation — this is the engine floor that everything stands on. |

**Overall verdict:** renderer.js is a 6K-line monolith containing the game's entire visual identity. Every subsystem maps to a Core Feeling — but the monolith structure means changes to one feeling-system risk breaking another. The subsystem boundaries are function-level, not file-level. Extraction candidates: rain → `renderer_weather.js`, grass ring → `renderer_vegetation.js`, fairy layer → merge with night fairies into one system. The particle systems (6 separate init/update pairs) are the strongest extraction candidates — they follow a proven SoA pattern that's self-contained.

---

#### tribes.js (6,868 lines)

| Aspect | Assessment |
|---|---|
| Core Feeling | *(Infrastructure)* |
| Justification | Auto-generated Emscripten WASM glue code. This is the bridge between C++ game physics (skiing, jetting, movement, collision, weapon logic) and the JavaScript renderer. It ENABLES every Core Feeling but creates none directly. Players never see this code's output — they see what renderer.js does with the data it provides. |
| Verdict | **KEEP as-is.** Never hand-edit. Regenerated from C++ source. The sensations live in the C++ physics (Scale via skiing speed, Belonging via armor differentiation) but this file is just the plumbing. |

---

### Tier 2 — The Identity Layer

These modules define how Firewolf LOOKS and FEELS distinct from every other browser shooter.

---

#### renderer_sky_custom.js (396 lines)

| Aspect | Assessment |
|---|---|
| Core Feeling | **Scale** + **Aliveness** + **Adaptation** |
| Justification | The procedural sky dome — day/night gradient, cloud layers, stars, sun disc, moon. The sky IS scale: it's the largest visual element on screen at all times. A vast sky over vast terrain = the feeling of being small in an enormous world. Phase-reactive sky color shifts signal Adaptation (sky darkens before mech wave, haze before fog phase). Stars at night = Aliveness (the world has a cosmos). |
| Verdict | **KEEP. Critical.** One of the most feeling-dense modules per line of code. |

---

#### renderer_characters.js (294 lines)

| Aspect | Assessment |
|---|---|
| Core Feeling | **Belonging** + **Scale** |
| Justification | GLB character models with 4 LODs, 17 animations, team coloring. This is how you SEE your tribe — and theirs. Three armor types × four teams × distance-based LOD. At 50m you read the silhouette (heavy vs. light). At 300m you read the team color. Character grounding keeps soldiers planted on terrain, connecting them to the vast world. Animation system (run, ski, jet, die, idle) communicates player state — you read your teammate's intention from their pose. |
| Verdict | **KEEP. Critical for Belonging.** The armor silhouette differentiation is the visual backbone of role interdependence. |

---

#### renderer_palette.js (92 lines)

| Aspect | Assessment |
|---|---|
| Core Feeling | **Belonging** |
| Justification | Color constants and team colors (Blood Eagle red, Diamond Sword blue, Phoenix gold, Starwolf green). Every team-colored element in the game traces back to this file. Palette consistency IS tribal identity — you know your team by its color before you read any HUD element. |
| Verdict | **KEEP. Foundation.** Tiny file, massive downstream impact. Every renderer module that paints team color depends on these values. |

---

#### renderer_toonify.js (210 lines)

| Aspect | Assessment |
|---|---|
| Core Feeling | **Scale** (visual identity) |
| Justification | Toon shader post-process that enforces the game's "procedural boldness" visual identity. The bold, non-photorealistic look IS how Firewolf communicates Scale differently from realistic shooters — angular terrain + toon shading = readable at any distance. When silhouettes pop, the 4km map feels navigable, not overwhelming. |
| Verdict | **KEEP with review.** Serves the visual identity principle, but needs validation that it plays well with the PBR texture array system (potential style contradiction). |

---

### Tier 3 — Tactical Systems

These modules serve specific gameplay moments and create sensation during those moments.

---

#### renderer_combat_fx.js (301 lines)

| Aspect | Assessment |
|---|---|
| Core Feeling | **Adaptation** |
| Justification | Muzzle flash, tracers, hit crosshair feedback, kill feed. Every one of these is tactical information delivered as visual feedback. The hit crosshair confirms "I'm dealing damage — keep doing this." The kill feed tells you who's winning fights and where. Tracers reveal enemy positions and weapon types. This is Adaptation in its purest form: the game is giving you data, and you need to respond. |
| Verdict | **KEEP. Expand.** Should absorb combat-related polish from `renderer_polish.js` (camera shake on damage, FOV punch on hit, damage vignette pulse). |

---

#### renderer_command_map.js (601 lines)

| Aspect | Assessment |
|---|---|
| Core Feeling | **Belonging** + **Adaptation** |
| Justification | Full-screen tactical overlay map. This is where Belonging becomes strategic — you see all four bases, flag positions, teammate locations. The command map is HOW a player transitions from individual combat to tribal coordination. During phase transitions (Adaptation), the command map lets you plan your tribe's response: "Lava rising — heavies need transport to high ground." |
| Verdict | **KEEP. Will grow.** Phase timeline overlay, vehicle markers, mech wave indicator — this becomes the nerve center for Adaptation. |

---

#### renderer_minimap.js (348 lines)

| Aspect | Assessment |
|---|---|
| Core Feeling | **Belonging** + **Scale** |
| Justification | Circular radar HUD in the corner. Belonging: you see teammates as colored dots, enemies as threat pings. Scale: the minimap gives you spatial context for the 4km world — where are you relative to your base, the enemy, the center? Without it, the vast terrain is disorienting instead of exhilarating. |
| Verdict | **KEEP. Essential HUD element.** |

---

#### renderer_zoom.js (206 lines)

| Aspect | Assessment |
|---|---|
| Core Feeling | **Scale** + **Adaptation** |
| Justification | Scope/zoom FOV effect. Scale: zooming in on a target 400m away IS the sensation of scale — you can SEE that far because the world IS that big. Adaptation: the zoom is a tactical choice. You trade peripheral awareness for distance intel. Future laser rifle (light-only, requires scope) makes this a Belonging system too — only your role can do this. |
| Verdict | **KEEP. Will gain importance** with sniper weapons and expanded loadout differentiation. |

---

#### renderer_buildings.js (362 lines)

| Aspect | Assessment |
|---|---|
| Core Feeling | **Belonging** |
| Justification | Modular building system — mesh generation and collider registration for base structures. These are the physical spaces where tribes operate: generator rooms, inventory stations, command centers. The building meshes define the boundaries of "home." Destroying an enemy's buildings is attacking their Belonging. |
| Verdict | **KEEP. Expand.** Should absorb building-detail polish from `renderer_polish.js` (railings, station icons, tower windows, coil rings, missile clusters, sensor dishes). |

---

#### renderer_rapier.js (456 lines)

| Aspect | Assessment |
|---|---|
| Core Feeling | **Scale** (grounding) |
| Justification | Rapier 3D physics collision facade. This is what makes skiing WORK — terrain collision, building collision, player grounding. Without accurate collision, the vast terrain is a visual backdrop you clip through. Physics grounding is what transforms "moving fast above polygons" into "carving through a mountain range." Every ski route, every building interior, every mortar arc — all depend on this collision mesh. |
| Verdict | **KEEP. Foundation.** Silent infrastructure that enables Scale's kinesthetic payoff. |

---

#### renderer_debug_panel.js (216 lines)

| Aspect | Assessment |
|---|---|
| Core Feeling | *(Development tool)* |
| Justification | Debug stats overlay — FPS counter, draw calls, player count, camera position, memory stats. This serves no player-facing Core Feeling. It exists for the developer (Levi) to validate performance budgets and diagnose issues. |
| Verdict | **KEEP but flag as dev-only.** Should be completely hidden in production builds. Ensure it has zero runtime cost when disabled. Not noise — just not player-facing. |

---

### Tier 4 — Client Systems

These modules handle the non-visual game infrastructure. They enable Core Feelings without directly creating visual or audio sensation.

---

#### client/audio.js (95 lines)

| Aspect | Assessment |
|---|---|
| Core Feeling | **Aliveness** + **Belonging** + **Scale** |
| Justification | Sound system — spatial audio, footsteps (metal vs. terrain detection), generator proximity hum. Audio is the PRIMARY Aliveness channel after visuals. The generator hum tells you you're home (Belonging). Footstep echo in a vast valley tells you the world is enormous (Scale). Spatial weapon fire tells you where the fight is. 95 lines is TINY for how much sensation it should carry — this module is critically underbuilt. |
| Verdict | **KEEP. Massively expand.** Needs: phase transition stingers, VGS voice callouts, vehicle engines, mech wave siren, lava crackling, water ambient. Audio is the most underserved sensation channel in the entire codebase. |

---

#### client/constants.js (115 lines)

| Aspect | Assessment |
|---|---|
| Core Feeling | **Belonging** + **Adaptation** |
| Justification | Shared constants — message types, weapon definitions, damage thresholds. These numbers ARE the balance sheet of role interdependence. Light armor health (0.66) vs. heavy (1.32) — that ratio IS Belonging (heavies need lights, lights need heavies). Weapon damage values shape combat flow — Adaptation emerges from these numbers. |
| Verdict | **KEEP. Foundation data.** Any balance change here ripples through every Core Feeling. |

---

#### client/network.js (331 lines)

| Aspect | Assessment |
|---|---|
| Core Feeling | **Belonging** (enabler) |
| Justification | WebSocket multiplayer client. Without networking, there is no tribe — you're alone in a single-player sandbox. Network.js is what makes "my tribe needs me" possible by connecting 64 players. Snapshot/delta compression keeps the connection fast enough that skiing at speed still feels smooth. |
| Verdict | **KEEP. Critical path.** Marked "needs work" in game-design.md. Network quality directly impacts every Core Feeling because lag destroys immersion. |

---

#### client/prediction.js (140 lines)

| Aspect | Assessment |
|---|---|
| Core Feeling | **Scale** (feel) |
| Justification | Client-side prediction and reconciliation. This is what makes skiing feel responsive at 100+ km/h across a 4km map. Without prediction, every server round-trip adds latency to movement — and at Tribes speed, even 50ms of input lag kills the sensation of speed. Prediction IS the kinesthetic Scale feeling for multiplayer. |
| Verdict | **KEEP. Critical for feel.** "Needs work" per game-design.md. Should be top priority alongside networking — broken prediction = broken Scale. |

---

#### client/wire.js (254 lines)

| Aspect | Assessment |
|---|---|
| Core Feeling | *(Infrastructure)* |
| Justification | Binary wire protocol encode/decode. Compact binary format keeps bandwidth low so 64 players can coexist on a single WebSocket connection. No player-facing sensation, but wire efficiency directly enables the player count that creates Belonging. |
| Verdict | **KEEP. Invisible enabler.** |

---

#### client/quant.js (40 lines)

| Aspect | Assessment |
|---|---|
| Core Feeling | *(Infrastructure)* |
| Justification | Quantization helpers for the wire protocol. Compresses floats to smaller representations for network transmission. 40 lines of math that saves bandwidth. |
| Verdict | **KEEP. Utility.** |

---

#### client/voice.js (314 lines)

| Aspect | Assessment |
|---|---|
| Core Feeling | **Belonging** |
| Justification | Voice chat via WebRTC. Hearing your teammate call out "enemy capper incoming" IS Belonging. Voice transforms four strangers into a squad. Proximity-based spatial audio would add Scale (hearing someone's callout fade as they jet away). This is the highest-bandwidth human connection channel in the game. |
| Verdict | **KEEP. High impact when activated.** Currently exists but underused. Voice + VGS callouts together would be the most potent Belonging system in the game. |

---

#### client/replay.js (376 lines)

| Aspect | Assessment |
|---|---|
| Core Feeling | **Adaptation** (retrospective) |
| Justification | Match replay system. Replays let players study what happened — "why did we lose that flag?" — and adapt for next time. This is Adaptation on a meta-game timescale. Also serves community building (sharing epic plays = emergent Belonging). |
| Verdict | **KEEP. Secondary priority.** Not essential for core gameplay loop, but high value for competitive community. |

---

#### client/tiers.js (46 lines)

| Aspect | Assessment |
|---|---|
| Core Feeling | **Belonging** (identity) |
| Justification | Skill tier/rating system. Your tier is part of your identity within the tribe — nameplates display tier colors. "I'm a Diamond Sword Gold-rank heavy" is Belonging in its competitive form. Matchmaking fairness (when implemented) protects the Belonging feeling by preventing stomps. |
| Verdict | **KEEP. Grows with matchmaking.** |

---

#### client/moderation.js (120 lines)

| Aspect | Assessment |
|---|---|
| Core Feeling | **Belonging** (protection) |
| Justification | Chat moderation — word filter, mute system. This PROTECTS Belonging. Toxic chat destroys the "my tribe needs me" feeling faster than any game mechanic can build it. Moderation is the immune system of community. |
| Verdict | **KEEP. Essential for multiplayer.** |

---

#### client/mapeditor.js (393 lines)

| Aspect | Assessment |
|---|---|
| Core Feeling | **Scale** (creation) |
| Justification | 2D heightmap paint map editor. This is how Levi builds the 4km worlds that create the Scale feeling. The editor serves the creator, not the player directly — but every ski route, every ridgeline, every valley floor that creates Scale was painted here. |
| Verdict | **KEEP. Expand to v2.** Needs 3D preview, zone painting (fog/lava/power surge areas), structure placement. The map IS the game. |

---

### Noise Flags

Modules or subsystems that fail Ive's Razor:

| Module/Subsystem | Verdict | Reasoning |
|---|---|---|
| **renderer_cohesion.js** (138 lines) | ⚠️ **NOISE — KILL** | Dead code. Camera breathing (~0.0008 rad micro-jitter) that nobody asked for and nobody noticed. Ambient mood-bed audio drone that duplicates what `client/audio.js` should own. Loaded via `<script>` tag but the tick call in renderer.js is commented out or gated. 138 lines of phantom sensation. **Delete the file.** |
| **renderer_polish.js** (1,146 lines) | ⚠️ **NOISE — DECOMPOSE & KILL** | Grab-bag module that violates single-responsibility. Contains 15+ unrelated subsystems: lens flare, lightning, decals, camera shake, FOV punch, rain splashes, smoke stacks, damage vignette, telemetry HUD, compass ring, flag flash, heat shimmer, railings, station icons, tower windows, coil rings, missile clusters, sensor dishes. Each subsystem maps to a real Core Feeling — but lumping them together means you can't reason about any individual one. **Decompose:** weather FX → `renderer_weather.js`, combat feedback (shake, FOV punch, vignette, flag flash) → `renderer_combat_fx.js`, building details (railings, icons, windows, coils, missiles, dishes) → `renderer_buildings.js`, HUD elements (compass, telemetry) → HUD system, atmosphere (lens flare, heat shimmer) → `renderer_sky_custom.js` or new `renderer_atmosphere.js`. Then delete the file. |
| **renderer.js — Rain system** (85 lines) | ⚠️ **LATENT — EXTRACT** | Disabled by default (opt-in via flag). If rain serves a purpose (Raindance map homage, weather-as-Aliveness), it should live in `renderer_weather.js` alongside lightning, wind effects, and phase-reactive weather. If it doesn't serve a purpose, kill it. It shouldn't sit disabled in a 6K-line monolith. |
| **renderer.js — Grass ring** (250 lines) | ⚠️ **LATENT — EXTRACT OR KILL** | Disabled on most quality tiers. Camera-local grass serves Aliveness when visible, but the current implementation has had multiple false starts (initGrass, initDetailProps, initGrassRing — three attempts across revision history). Either commit to a proper vegetation system in `renderer_vegetation.js` or kill it. The current state is "abandoned experiment inside the monolith." |
| **renderer.js — Legacy particles** (syncParticles, L3974–4051) | ⚠️ **TECHNICAL DEBT** | Old particle system that predates the GPU SoA pattern. May overlap with the newer jet/ski/explosion systems. Audit for dead code paths and consolidate into the proven pattern. |

---

## Feeling Coverage Analysis

| Core Feeling | Well-Served By | Underserved? |
|---|---|---|
| **Belonging** | renderer_palette.js (team colors), renderer_characters.js (armor silhouettes), flag system, building system, base accents, client/voice.js, client/moderation.js, nameplates + tier colors | **Underserved in audio.** No VGS callouts ("Defend our flag!"), no team-specific musical stingers, no "base under attack" alarm. Visual Belonging is strong; auditory Belonging is nearly absent. Also **underserved in gameplay systems** — four-tribe support, phase-forced role switching, and vehicle dependency (heavies need transport) are all unbuilt. The visual infrastructure is ready, but the mechanics that CREATE interdependence don't exist yet. |
| **Adaptation** | renderer_combat_fx.js (hit feedback), projectile rendering (trajectory reading), renderer_command_map.js (tactical overlay), explosion FX | **Underserved in phase systems.** The phase system itself is unbuilt — no fog, no lava flood, no mech wave, no power surge. The renderer has atmospheric capability (sky, post-processing, day/night) that COULD serve phase-reactive Adaptation, but there's no phase state to react to yet. Also: no phase timeline HUD, no transition warnings, no "the game is about to change" sensation. |
| **Scale** | Terrain (faceted 4km maps), renderer_sky_custom.js (vast sky dome), skiing particles, jet exhaust, camera system, renderer_rapier.js (physics grounding), renderer_zoom.js | **Well-served visually.** The weakest link is **audio Scale** — no distant thunder, no wind at altitude, no Doppler on passing players, no echo in valleys. Also: water renderer is unbuilt (lakes as barriers would add route-planning Scale), and vehicle movement (transport flying across the map) would dramatically amplify the sensation. |
| **Aliveness** | Day/night cycle, ground fairy layer (64K motes), night sky fairies, post-processing (night bloom), interior lights, generator hum (audio.js) | **Strongest visual system, weakest in interactivity.** The world breathes passively (fairies, day/night, bloom) but doesn't REACT to players. No footprints in terrain, no water ripples, no vegetation bending from jet wash, no scorch marks from mortars. Aliveness currently means "the world moves on its own" — it should also mean "the world responds to me." Phase-reactive weather (rain during fog phase, heat shimmer during lava) would connect Aliveness to Adaptation. |

---

## Extraction Priority Map

Based on the noise flags and monolith analysis, these are the recommended structural changes ranked by impact:

| Priority | Action | Feeling Served | Effort |
|---|---|---|---|
| 🔴 1 | **Kill `renderer_cohesion.js`** | — | 15 min |
| 🔴 2 | **Decompose `renderer_polish.js`** into 4–5 proper homes | All four | 4–6 hrs |
| 🟡 3 | **Extract particle systems** from renderer.js into `renderer_particles.js` | Scale + Aliveness | 3–4 hrs |
| 🟡 4 | **Extract rain + grass + fairy** from renderer.js into `renderer_weather.js` + `renderer_vegetation.js` | Aliveness | 2–3 hrs |
| 🟡 5 | **Expand `client/audio.js`** — the single highest-impact new work for Core Feelings | All four | 15–20 hrs |
| 🟢 6 | **Create `renderer_phase.js`** — phase-reactive atmosphere, fog, lava shader, transition FX | Adaptation | 20–30 hrs |
| 🟢 7 | **Create `renderer_weather.js`** — rain, lightning, wind, phase weather | Aliveness + Adaptation | 8–12 hrs |

---

## Recommendations

### Immediate (before next feature work)

1. **Delete `renderer_cohesion.js`.** Confirmed dead code. Remove the `<script>` tag from `index.html` and the commented-out tick call from renderer.js. Zero player impact.

2. **Decompose `renderer_polish.js` before it grows further.** Every new "polish" effect gets thrown in this file. The decomposition targets are clear:
   - Combat feedback (shake, FOV punch, vignette, flag flash) → `renderer_combat_fx.js`
   - Building details (railings, icons, windows, coils, missiles, dishes, smoke stacks) → `renderer_buildings.js`
   - Weather FX (lightning, rain splashes) → new `renderer_weather.js`
   - Atmosphere (lens flare, heat shimmer) → `renderer_sky_custom.js`
   - HUD elements (compass ring, telemetry) → HUD system or `renderer_debug_panel.js`
   - Decals → `renderer_combat_fx.js` (they're combat decals)

3. **Audit legacy particle system** (syncParticles, L3974–4051) for dead code paths. If it's only used for backward compatibility, sunset it.

### Strategic (next 1–3 months)

4. **Audio is the #1 underserved sensation channel.** `client/audio.js` at 95 lines is carrying the entire auditory experience of a game that should sound as rich as it looks. Priority audio work:
   - Phase transition stingers (Adaptation)
   - VGS voice callouts (Belonging)
   - Generator under-attack alarm (Belonging)
   - Wind at altitude / speed (Scale)
   - Vehicle engines (Belonging + Scale)

5. **Phase system is the #1 unbuilt Core Feeling driver.** Adaptation has zero working gameplay systems. The renderer can handle phase-reactive atmosphere (sky, lighting, post-processing all support it), but the phase state machine, HUD timeline, and transition logic don't exist. This is the biggest gap between the game's design document and its implementation.

6. **Aliveness needs interactivity.** The passive breathing is beautiful (fairies, day/night, bloom). The next step is reactive Aliveness: mortar scorch marks, jet wash vegetation bend, footprints in soft terrain, water ripples. These are "the world notices me" moments.

### Architectural

7. **renderer.js needs a subsystem registry.** Currently, adding a new particle system means adding init + update functions to the monolith and wiring them into the render loop by hand. A registry pattern (`registerSubsystem({ init, update, dispose })`) would let extracted modules plug in cleanly and make the monolith shrinkable over time without breaking the render loop.

8. **Every new module should declare its Core Feeling in its `@ai-contract` block.** Example:
   ```
   // @ai-contract
   // CORE_FEELING: Scale (skiing kinesthetics, terrain contact feedback)
   // ...
   // @end-ai-contract
   ```
   This makes Ive's Razor enforceable by the AI in future reviews.

---

*Generated by Phase 6 Audit. Every module mapped. Every feeling accounted for. The gaps are visible.*
