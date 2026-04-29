# Firewolf — Game Design Document

*The north star. Every code review, every new feature, every design decision checks against this.*

---

## Identity

**Firewolf** is a browser-based multiplayer FPS inspired by Starsiege: Tribes (1998). Four tribes compete on a vast map through shifting game phases that reshape optimal strategy every few minutes. The game rewards team interdependence over solo mastery.

**It is NOT:**
- A Tribes clone (four tribes, phase mechanics, PvE moments — original design)
- AAA realistic (procedural boldness over fidelity)
- Cel-shaded / Breath of the Wild aesthetic (that's been done)
- Tribes 3 (no plastic water, no generic sci-fi)

**It IS:**
- Playable in any browser on any hardware at 60fps
- A game where your tribe needs you and you need your tribe
- A game where the world itself changes how you fight
- Visually bold: faceted terrain, readable silhouettes, atmospheric scale

---

## Core Feelings

Every system, every visual, every sound must serve one or more of these:

| Feeling | Description | Systems That Create It |
|---|---|---|
| **Belonging** | My tribe needs me, I need my tribe. I have a role. | Armor interdependence, vehicle dependency, phase-forced roles, shared objectives |
| **Adaptation** | The game is changing. I need to read it and respond. | Phase system, rising lava, fog, mech waves, shifting optimal strategies |
| **Scale** | This world is enormous and I'm moving through it at speed. | Vast terrain, skiing, jetting, high altitude, long sightlines |
| **Aliveness** | The world isn't static. It breathes, shifts, glows. | Day/night, fairy particles, phase atmospheres, generative audio, water/lava |

---

## The Four Tribes

| Tribe | Color | Identity |
|---|---|---|
| **Blood Eagle** | Red (#C8302C) | Aggressive, fast, offensive-minded |
| **Diamond Sword** | Blue (#2C5AC8) | Disciplined, defensive, tactical |
| **Phoenix** | Gold (#D4A030) | Adaptive, opportunistic, scavengers |
| **Starwolf** | Green (#30A050) | Pack hunters, coordinated, ambush specialists |

Each tribe starts with a base containing: Generator, Inventory Stations, Turrets, Sensors, Command Station, Flag Stand.

16 players per tribe = 64 players per match.

---

## Armor System

Three armor tiers with genuine mechanical differences that create role interdependence:

| Armor | Speed | Health | Weapons | Role | Team Need |
|---|---|---|---|---|---|
| **Light** | Fast (11 m/s) | Low (0.66) | Blaster, Chaingun, Disc, Grenade | Capper, scout, sniper | Speed — the only one who can cap at full velocity |
| **Medium** | Medium (8 m/s) | Medium (1.0) | + Plasma | Versatile fighter, escort | Backbone — escorts cappers, defends routes |
| **Heavy** | Slow (5 m/s) | High (1.32) | Grenade, Plasma, Mortar | Base assault, vehicle pilot, area denial | Firepower — the only one who can crack a fortified base |

**Key interdependence:** Heavies need vehicles to get anywhere (too slow on foot). Lights need heavies to break base defenses. Mediums bridge the gap. No single armor type can win alone.

---

## Weapons

| # | Weapon | Damage | Type | Role |
|---|---|---|---|---|
| 0 | Blaster | 0.125 | Projectile | Sidearm, all classes |
| 1 | Chaingun | 0.11 | Hitscan | Anti-air, close range |
| 2 | Disc Launcher | 0.5 | Projectile (splash) | Mid-air dueling, the signature weapon |
| 3 | Grenade Launcher | 0.4 | Projectile (arc, splash) | Area denial, indoor combat |
| 4 | Plasma Rifle | 0.45 | Projectile (splash) | Versatile mid-range |
| 5 | Mortar | 1.0 | Projectile (heavy arc, big splash) | Base assault, area denial |

**Future:** Laser Rifle (sniper, light-only, requires scope = team coordination), ELF Gun (drains energy, support weapon), Missile Launcher (vehicle counter).

---

## Vehicles

*Critical for the "Belonging" feeling — heavies NEED transport, lights NEED vehicles for deep flanks.*

| Vehicle | Seats | Role | Who Drives |
|---|---|---|---|
| **Scout Flyer** | 1 | Fast recon, light harassment | Light/Medium |
| **Transport** | 1 pilot + 4 passengers | Team deployment, heavy delivery | Any (usually medium) |
| **Tank** | 1 driver + 1 gunner | Base siege, area control | Heavy drives, medium guns |

Vehicles are bought at Vehicle Stations using team resources. Destroying enemy vehicles is a priority — a team without transport during ground burn is stranded.

---

## Phase System

The core innovation. The map shifts between phases on a schedule visible to all players. Each phase reshapes what's optimal, forcing role adaptation and creating a match narrative.

### Phase Schedule (30-60 minute match)

```
0:00  — Match Start (Open Sky, 5 min)
5:00  — Transition Warning (90 sec)
6:30  — Dense Fog (5 min) — visibility 50m, close combat
11:30 — Transition Warning
13:00 — Open Sky (5 min)
18:00 — Transition Warning
19:30 — Lava Flood / Ground Burn (5 min) — lava rises from valleys
24:30 — Transition Warning
26:00 — Open Sky (3 min)
29:00 — Mech Wave (cooperative PvE, ~3-5 min)
~34:00 — Final Open Sky until match end
```

Phase sequence is visible on the HUD — teams can plan ahead.

### Phase Details

**Open Sky** (default)
- Standard play, all strategies viable
- Clear visibility, full terrain access
- Rewards: skiing skill, mid-air combat, flag running

**Dense Fog**
- Visibility drops to 50m
- Sniper scopes useless, chaingun range irrelevant
- Heavies shine (close-range mortar/plasma)
- Lights must play cautious (can't see threats coming)
- Indoor combat intensifies around bases
- Audio cues become critical (footsteps, jet sounds)

**Lava Flood (Ground Burn)**
- Lava rises from the lowest terrain points over 5 minutes
- Low-ground routes get cut off progressively
- Players on lava take escalating damage (1s grace period for brief landings)
- Vehicles become essential — heavy armor is stranded without transport
- Aerial combat dominates
- Bases at low elevation get threatened — generators at risk
- Retreating to ridgelines and taking to the air

**Power Surge** (optional phase)
- Generators supercharged — turret range and damage doubles
- Base defense becomes critical
- Rewards teams who maintained their generators
- Punishes teams who've been neglecting base repair

**Mech Wave** (cooperative PvE event)
- A massive mech spawns at map center
- Damages all four bases equally unless tribes converge fire
- Tribes that ignore it lose their generator to bombardment
- Per-tribe damage tracking — most damage = bonus points + temporary buff
- The mech type varies (slow ground = heavy DPS check, fast flyer = light/vehicle challenge)
- Visual: 40m tall, camera shake on footsteps, sky darkens, siren warning
- Creates temporary cooperation that's also competitive ("we're helping, but also racing")

### Phase Transitions
- 90-second warning before each phase shift
- Visual cue: sky color shifts, atmospheric effects begin
- Audio cue: phase-specific musical transition, siren for mech wave
- Players can see the phase timeline on the HUD at all times

---

## Scoring

Multi-objective scoring creates emergent strategy and prevents meta collapse:

| Action | Points | Why |
|---|---|---|
| Flag Capture | 100 | Primary objective, requires team coordination |
| Flag Return | 25 | Rewards defense |
| Kill | 5 | Rewards combat but doesn't dominate scoring |
| Generator Destroy | 30 | Strategic — disables enemy defenses |
| Mech Wave (top damage tribe) | 50 + buff | Rewards PvE cooperation |
| Mech Wave (participation) | 20 | Everyone gets something for helping |

**Win condition:** First to target score, or highest score at match end.

The scoring weights ARE the diplomacy engine. CTF gives big points → tribes protect flags and plan runs. Mech damage gives a buff → tribes engage the PvE event. The incentive structure communicates strategy without explicit diplomacy.

---

## Map Design

### Terrain Identity
- **Faceted geometry** — angular flat triangles visible at close range, smooth silhouettes at distance
- **257×257 heightmap at scale 16-32** — 4-8km maps, large facets, readable ski slopes
- **Curated color palette per map** — not photorealistic. Warm dry grass, grey-blue rock, ruddy soil in valleys.
- **Readability over fidelity** — you always know what you're looking at at 300m

### Map Features
- **Four base quadrants** — each tribe's territory with generator, stations, flag
- **Central contested zone** — mech spawn point, shared resources
- **Water bodies** — lakes as strategic barriers (hydroplane at speed, sink when slow)
- **Lava rivers** — permanent route constraints (distinct from phase lava flood)
- **Ridgelines** — safe ground during lava flood, sniper positions
- **Valleys** — fast ski routes, but first to flood during lava phase
- **Building complexes** — interior combat zones, generator protection

### Water Mechanics
- **At speed (skiing/jetting):** Hydroplane across the surface — rewards momentum
- **Below speed threshold:** Sink, movement slowed, damage over time
- **Visual:** Tier 1 flat plane + animated shader (1 draw call), Tier 2 planar reflection on medium+ quality

### Lava Mechanics
- **Permanent lava rivers:** Fixed map features, route constraints
- **Phase lava flood:** Rising Y level during Ground Burn phase, threatens low-elevation areas
- **Contact damage:** Escalating — 1s grace period, then rapid damage
- **Visual:** Emissive shader + bloom + heat shimmer (1-2 draw calls total)

---

## Map Editor

For the map creator (Levi), not for pro-level designers.

### Core Requirements
- **Split-pane:** 2D paint canvas + 3D Three.js preview (live update)
- **Brush presets:** Mountain, Valley, Ridge, Plateau, Flatten, Smooth (named for what they make, not what they do)
- **Zone painting:** Ground burn areas, fog density zones, power surge zones
- **Four-team placement:** 4 bases, 4 flags, 4 spawn zones, vehicle stations
- **Structure placement:** Drag-and-drop from building catalog (integrates with renderer_buildings.js)
- **Water/lava placement:** Water level slider per body, lava river painting
- **Atmosphere config:** Per-phase sky, fog, lighting presets
- **Save/Load:** `.tribes-map` v2 format
- **Instant test:** Hot-load into game without publish step

### Map Format v2
```json
{
  "schemaVersion": 2,
  "terrain": {
    "size": 257,          // or 512, 1024
    "worldScale": 16,     // meters per heightmap cell
    "heights": "base64...",
    "zones": "base64..."  // bitmask per cell: ground-burn, fog, power-surge
  },
  "teams": [
    { "tribe": "blood-eagle", "base": [x,y,z], "flag": [x,y,z], "spawns": [...] },
    { "tribe": "diamond-sword", ... },
    { "tribe": "phoenix", ... },
    { "tribe": "starwolf", ... }
  ],
  "buildings": [...],     // layouts.json format from renderer_buildings.js
  "water": [{ "y": 15.0, "bounds": [...] }],
  "lava": [{ "y": 8.0, "bounds": [...], "permanent": true }],
  "atmosphere": {
    "openSky": { ... },
    "fog": { ... },
    "groundBurn": { ... },
    "mechWave": { ... }
  }
}
```

---

## Visual Identity

### Principles
1. **Scale over fidelity.** Vast terrain, huge skies, tiny figures. Shadow of the Colossus, not Call of Duty.
2. **Atmosphere over texture.** The sky, the light, the particles, the fog. Not PBR material quality.
3. **Readable silhouettes.** You always know what you're seeing at 300m. Armor types distinguishable. Vehicles distinguishable. Teams distinguishable.
4. **Procedural boldness.** Generated textures are the style, not a compromise. Visible brushstrokes. Bold color.
5. **Phase-reactive world.** Each game state has its own atmospheric personality. The world TELLS you what phase it is.

### Quality Tiers
| Tier | Terrain | Particles | Post-Processing | Shadows | Target Hardware |
|---|---|---|---|---|---|
| **Low** | Flat diffuse + vertex color | Reduced count | None | Off | Integrated GPU, old laptops |
| **Medium** | Diffuse + normal map | Full count | Bloom | 1024px | Mid-range GPU |
| **High** | Full PBR (albedo + normal + roughness) | Full count | Bloom + grade | 2048px | Dedicated GPU |
| **Ultra** | Full PBR + array textures | Full count + extras | Full stack | 2048px | High-end |

---

## Audio Identity

### Principles
- **Generative, phase-responsive soundtrack** — continuous music that shifts with game state
- **Spatial gameplay cues** — hear jets, footsteps (metal vs terrain), skiing, weapon fire
- **Phase transitions have sound** — you hear the shift before you see it
- **The world has a sound** — ambient hum near generators, fairy motes chime at night, lava crackles

### Existing Audio Systems
- Weapon fire sounds
- Footstep synthesis (metal floor detection inside buildings)
- Generator proximity hum (60Hz + harmonics)
- Ambient mood-bed (procedural drone, renderer_cohesion.js)

### Needed
- Phase transition music/stingers
- Mech wave siren + footstep rumble
- Lava ambient crackling
- Water ambient
- Vehicle engine sounds
- VGS-style voice callouts ("Shazbot!", "I am the greatest!", "Defend our flag!")

---

## What Exists vs What's Left to Build

### ✅ Built and Working

| System | Status | Location |
|---|---|---|
| WASM game engine (physics, movement, skiing, jetting) | Working | build/tribes.js (compiled from C++) |
| Three.js renderer (terrain, buildings, interiors, lighting) | Working, 6K-line monolith | renderer.js |
| Day/night cycle | Working | renderer.js DayNight |
| Particle systems (jet, ski, trails, explosions, fairies) | Working | renderer.js |
| Post-processing (bloom, grading, vignette) | Working | renderer_polish.js |
| Procedural sky dome | Working | renderer_sky_custom.js |
| Rapier physics (terrain + building collision) | Working | renderer_rapier.js |
| Modular building system | Working, tested | renderer_buildings.js |
| Character models (4 teams × 3 armors, 4 LODs, 17 anims) | Working | renderer_characters.js |
| Minimap / radar | Working | renderer_minimap.js |
| Combat FX (muzzle flash, tracers, hit feedback) | Working | renderer_combat_fx.js |
| Kill feed | Working | renderer_combat_fx.js |
| Weapon system (6 weapons, 3 armor loadouts) | Working in WASM | client/constants.js defines |
| Basic map editor (2D heightmap paint) | Basic, needs upgrade | client/mapeditor.js |
| Building layout editor | Working | editor/buildings.html |
| Asset editor (GLB placement) | Working | editor/ |
| HUD (health, energy, ammo, weapon, crosshair) | Working | tribes.js |
| Server skeleton (WebSocket, lobby, wire protocol) | Exists, needs work | server/ |
| Client networking (WebSocket, snapshot, delta) | Exists, needs work | client/network.js, wire.js |
| Client prediction | Exists, needs work | client/prediction.js |
| Anti-cheat framework | Exists | server/anticheat.ts |
| Bot AI (researched, skeleton) | Skeleton | server/bot_ai.ts |
| Replay system | Exists | client/replay.js |
| Voice chat | Exists | client/voice.js |

### 🔨 Needs Building — Major Systems

| System | Complexity | Dependencies | Priority | Est. Time |
|---|---|---|---|---|
| **Dedicated multiplayer server** | High | server/, Cloudflare Workers or dedicated host | 🔴 Critical | 40-80 hrs |
| **Four-tribe support** | Medium | WASM + renderer + server + HUD + minimap | 🔴 Critical | 20-30 hrs |
| **Phase system** | Medium | Game clock, renderer atmosphere, audio, HUD | 🔴 Critical | 20-30 hrs |
| **Vehicles** (3 types) | High | New models, physics, WASM vehicle logic, networking | 🟡 High | 40-60 hrs |
| **Map editor v2** (3D preview, zone painting) | Medium | terrain renderer, building system, map format v2 | 🟡 High | 20-30 hrs |
| **Water renderer** | Low | Shader, heightmap integration | 🟡 High | 3-5 hrs |
| **Lava renderer + flood mechanic** | Low | Shader, phase system, damage | 🟡 High | 3-5 hrs |
| **Mech wave PvE** | Medium | Model, AI, damage system, phase integration | 🟢 Medium | 20-30 hrs |
| **Bot AI (full)** | Medium | Waypoint graph, state machines, weapon selection | 🟢 Medium | 20-30 hrs |
| **VGS voice callouts** | Low | Audio assets or TTS, keybind system | 🟢 Medium | 5-10 hrs |
| **Matchmaking / lobby** | Medium | Server, UI, queue system | 🟢 Medium | 15-20 hrs |
| **Generative music system** | Medium | Web Audio, phase hooks | 🟢 Medium | 15-20 hrs |
| **Additional weapons** (laser, ELF, missile) | Low | WASM weapon table, renderer projectiles | 🟢 Medium | 10-15 hrs per weapon |
| **Scoreboard UI** | Low | HUD overlay, game state | 🟢 Medium | 3-5 hrs |
| **Player accounts / persistence** | Medium | Backend, auth, database | ⚪ Later | 20-30 hrs |
| **Spectator mode** | Low | Camera system, HUD variant | ⚪ Later | 5-10 hrs |
| **Map sharing / workshop** | Medium | Backend, upload, browse UI | ⚪ Later | 20-30 hrs |

### 🔧 Needs Work — Existing Systems

| System | What's Needed | Priority |
|---|---|---|
| **renderer.js decomposition** | Extract terrain, particles, interior shapes into modules | 🟡 High (audit) |
| **Networking hardening** | Reliable snapshot/delta, reconnection, 64-player scale | 🔴 Critical |
| **Server authoritative physics** | Server must validate movement (currently client-authoritative WASM) | 🔴 Critical |
| **Building floor grounding** | Characters sink through building floors | 🟡 High |
| **Terrain material pipeline** | Rebuild raindance_meshes.bin with ground-truth .dig data | 🟢 Medium |
| **window.* cleanup** | Reduce global coupling per audit plan | 🟡 High (audit) |
| **Module system migration** | IIFE → ES modules for stragglers | 🟡 High (audit) |

---

## Multiplayer Architecture

### Overview
```
                    ┌─────────────────────┐
                    │  Game Server (auth)  │
                    │  - Physics tick 30Hz │
                    │  - State authority   │
                    │  - Anti-cheat        │
                    │  - Phase orchestrator│
                    └──────────┬──────────┘
                               │ WebSocket
            ┌──────────────────┼──────────────────┐
            │                  │                  │
     ┌──────┴──────┐   ┌──────┴──────┐   ┌──────┴──────┐
     │  Client 1   │   │  Client 2   │   │  Client N   │
     │  - WASM sim │   │  - WASM sim │   │  - WASM sim │
     │  - Predict  │   │  - Predict  │   │  - Predict  │
     │  - Render   │   │  - Render   │   │  - Render   │
     └─────────────┘   └─────────────┘   └─────────────┘
```

### Key Decisions
- **Server-authoritative:** Server runs the physics simulation and is the source of truth. Client predicts locally for responsiveness but reconciles with server state.
- **Tick rate:** 30Hz server physics, 10Hz snapshots, 30Hz deltas, 60Hz client input
- **Wire protocol:** Binary (already defined in wire.js/wire.ts). Snapshots + deltas + input.
- **Hosting options:** Cloudflare Workers (existing deploy), or dedicated server for 64-player matches
- **Lag compensation:** 200ms rewind window (already defined in constants.js)

### 64-Player Scalability Concerns
- **Bandwidth:** 64 players × 30Hz deltas × ~100 bytes per player = ~190 KB/s outbound per client. Manageable.
- **Server CPU:** 64-player physics at 30Hz on a Worker might be tight. May need a dedicated server (existing Dockerfile in server/).
- **Client render:** 64 player models × 4 LODs. At distance, lowest LOD (sub-1K tris). At close range, top LOD. Draw call instancing per team per armor tier reduces this.

---

## Development Roadmap (Post-Audit)

### Phase A: Foundation (do first, everything depends on it)
1. Code audit (Adversarial Convergence Review — the current plan)
2. renderer.js decomposition (extract terrain, particles, etc.)
3. Four-tribe support (WASM + renderer + HUD)
4. Map format v2 + variable terrain size

### Phase B: The World
5. Water renderer (Tier 1 + Tier 2 option)
6. Lava renderer + permanent lava rivers
7. Map editor v2 (3D preview, zone painting, four-team placement)
8. First original map design

### Phase C: The Game
9. Phase system (open sky, fog, lava flood, power surge)
10. Lava flood mechanic (rising Y level tied to phase)
11. Multiplayer server hardening (64-player, server-authoritative)
12. Mech wave PvE event
13. Scoring system (multi-objective)

### Phase D: Vehicles + Roles
14. Scout Flyer
15. Transport
16. Tank
17. Vehicle stations + team resource system
18. Heavy → vehicle dependency tuning

### Phase E: Polish + Feel
19. Generative music system
20. VGS voice callouts
21. Bot AI (for filling matches / solo testing)
22. Additional weapons (laser, ELF, missile)
23. Matchmaking / lobby UI

### Phase F: Community
24. Player accounts / persistence
25. Spectator mode
26. Map sharing / workshop
27. Leaderboards / rankings

---

## Test Architecture

### Per-System Visual Harnesses
Each major system gets a standalone HTML test page:

| Harness | Tests | Visual Output |
|---|---|---|
| `test/buildings_test.html` | ✅ Complete | Building lifecycle, colliders, debug wireframes |
| `test/terrain_test.html` | Heightmap, quality tiers, water planes | Faceted terrain, PBR toggle, water level |
| `test/characters_test.html` | Animations, LOD, grounding, team colors | Single character, all states |
| `test/particles_test.html` | All emitter types, pool usage | Jet, ski, trail, explosion, fairy |
| `test/sky_test.html` | Day/night cycle, phase atmospheres | Time slider, fog, storm |
| `test/physics_test.html` | Capsule movement, collision, step-up | WASD capsule, debug wireframes |
| `test/combat_fx_test.html` | Muzzle flash, tracers, hit feedback | Trigger effects, FPS counter |
| `test/water_lava_test.html` | Water tiers, lava emissive, flood level | Water/lava planes, rising Y slider |
| `test/phase_test.html` | Phase transitions, atmosphere shifts | Time-lapse full match cycle in 60s |

### Integration Harnesses
| Harness | Systems Tested | What Could Break |
|---|---|---|
| `test/integration_physics_buildings.html` | Rapier + Buildings + Terrain | Walk-through-wall, collider misalignment |
| `test/integration_character_terrain.html` | Characters + Terrain + Grounding | Floating, sinking, foot offset |
| `test/integration_phase_atmosphere.html` | Phases + Sky + Lighting + Terrain | Transition flicker, night crush, fog mismatch |
| `test/integration_full_frame.html` | Everything | One frame renders correctly, scripted camera path |

### Reference Screenshots
Each visual harness includes a known-good reference PNG for human comparison regression testing. Not pixel-perfect — "does this still look right?"

---

*This document is the source of truth. When in doubt, check here. When reviewing code, check against here. When adding a feature, justify it against the Core Feelings.*
