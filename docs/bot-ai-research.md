# Bot AI Research — 3D Pathfinding with Flight Support

**Date:** 2026-04-28
**Context:** Phase 3 task — find free/open 3D pathfinding + movement AI that supports FLIGHT for browser JS/WASM context.

## Current State

The WASM bot AI (lines 1357-1580 of `wasm_main.cpp`) already implements:

- **A\* pathfinding** on a 2D nav grid (32m cells, 64×64 grid)
- **Bot roles** — offense/defense/midfield with distinct destination logic
- **Stuck detection** — 1.5s timer, jump + yaw randomize on stuck
- **Skiing** — slope detection, downhill dot product, momentum physics
- **Jetting** — reactive: jet when waypoint is above player or being chased
- **LoS-gated engagement** — 5-point raycast, 80m engagement range
- **Flag carrier logic** — return-home pathfinding, reduced engagement range
- **Building collision** — `resolvePlayerBuildingCollision` + `resolvePlayerInteriorCollision`

### Current Weaknesses

1. **No interior navigation** — nav grid marks buildings as unwalkable; bots can't enter bases
2. **2D-only pathfinding** — altitude not considered in route planning
3. **Reactive jetting** — bots only jet when waypoint is above, not planning flight routes
4. **No generator/turret targeting** — open_issues.md notes bots should prioritize generators
5. **No formation or coordination** beyond role assignment

## Libraries Evaluated

### 1. recast-navigation-js (★★★★☆)
- **URL:** https://github.com/isaac-mason/recast-navigation-js
- **Type:** WASM port of Recast/Detour (industry standard)
- **Size:** ~600KB WASM + JS wrapper
- **Features:** Runtime navmesh generation, crowd simulation, off-mesh connections, tiled navmesh, temporary obstacles
- **Flight support:** ❌ Ground-based navmesh only. Off-mesh connections can simulate short flight hops but no true 3D pathfinding.
- **Pros:** Battle-tested, great three.js integration, crowd simulation could give realistic bot groups
- **Cons:** Heavy dependency, overkill for our static terrain, no flight, requires mesh input (we'd need to export terrain + buildings as geometry)
- **Verdict:** Too heavy for our use case. The 2D navmesh doesn't solve the flight problem. Off-mesh connections are interesting but we can implement the concept ourselves.

### 2. navcat (★★★☆☆)
- **URL:** https://github.com/isaac-mason/navcat
- **Type:** Pure JavaScript navmesh library (same author as recast-navigation-js)
- **Size:** ~50KB tree-shaken
- **Features:** Same algorithms as Recast/Detour but in pure JS, fully JSON serializable
- **Flight support:** ❌ Floor-based navigation only
- **Pros:** No WASM dependency, lightweight, works with any engine, off-mesh connections
- **Cons:** Still ground-based, pure JS may be slower than our C++ A* in WASM
- **Verdict:** Interesting for the JS side but doesn't solve flight. Our C++ A* is faster anyway.

### 3. Yuka.js (★★★★☆)
- **URL:** https://mugen87.github.io/yuka/
- **Type:** Standalone JavaScript game AI library
- **Size:** ~60KB minified
- **Features:** Vehicle model, 14 steering behaviors (seek, flee, pursue, evade, arrive, wander, interpose, alignment, cohesion, separation), state machines, goal-driven agents, navmesh pathfinding, triggers, perception
- **Flight support:** ⚠️ Partial — steering behaviors work in 3D (seek/arrive/pursue all handle Y axis). Vehicle model supports 3D movement. But navmesh is floor-based.
- **Pros:** Great steering behaviors library, goal-driven agent design, standalone (no three.js dependency), well-documented
- **Cons:** Pure JS (our sim runs in WASM), navmesh still ground-based, would need bridging
- **Verdict:** The steering behavior concepts are valuable to port to C++. The library itself doesn't fit our WASM architecture, but the algorithms are well-documented and can be reimplemented.

### 4. three-pathfinding (★★☆☆☆)
- **URL:** https://github.com/donmccurdy/three-pathfinding
- **Type:** A* on three.js navmesh
- **Size:** ~15KB
- **Features:** Channel-based pathfinding on navmesh geometry
- **Flight support:** ❌
- **Verdict:** Too simple for our needs.

### 5. Octree-based 3D pathfinding (★★★☆☆)
- **Reference:** Kythera AI (O3DE), various academic papers
- **Type:** Volumetric 3D navigation using octree subdivision
- **How it works:** Voxelize the world into an octree, mark free/occupied cells, A* through free cells at various resolutions
- **Flight support:** ✅ Full 3D movement
- **Pros:** True 3D flight pathfinding, handles arbitrary geometry
- **Cons:** Memory-heavy (Raindance is ~2km², even at 8m resolution that's 256³ = 16M cells), expensive to query, no existing browser/JS implementation
- **Verdict:** The concept is sound for true flying games but massive overkill for Tribes where jetpacking is altitude-limited (energy constraint) and most movement is ground-based. Would need custom implementation.

## Recommended Approach: Hybrid Waypoint Graph

After evaluating all options, the best fit for Tribes is a **hybrid waypoint graph** — the same approach the original Tribes 1 used. It's lightweight, fast, runs in C++/WASM, and naturally supports mixed ground/flight/interior movement.

### Architecture

```
┌─────────────────────────────────────────────┐
│           Hybrid Waypoint Graph             │
│                                             │
│  Ground Layer    Flight Layer    Interior   │
│  ┌──────────┐   ┌───────────┐   ┌────────┐ │
│  │ Nav Grid  │──│ Sky Edges  │──│ Building│ │
│  │ A* (2D)   │   │ (altitude) │   │ Waypts │ │
│  └──────────┘   └───────────┘   └────────┘ │
│       ↕               ↕              ↕      │
│  ┌──────────────────────────────────────┐   │
│  │      Unified A* on Combined Graph    │   │
│  └──────────────────────────────────────┘   │
│       ↕                                     │
│  ┌──────────────────────────────────────┐   │
│  │    Steering (seek/arrive/avoid)      │   │
│  └──────────────────────────────────────┘   │
└─────────────────────────────────────────────┘
```

### Three Layers

1. **Ground Layer** (existing)
   - Keep the 2D nav grid A* for outdoor terrain paths
   - Add edge weights based on slope (prefer skiing downhill routes)
   - Already works well for cross-map traversal

2. **Interior Waypoint Layer** (new)
   - Hand-placed waypoints at key building locations:
     - Doorway entrances (2 per building side)
     - Corridor intersections
     - Generator room center
     - Each inventory/ammo/command station
     - Flag stand locations
   - Edges between adjacent interior waypoints (short distances)
   - **Doorway waypoints** connect to nearest ground nav cell

3. **Flight Edge Layer** (new)
   - Connect distant ground/interior waypoints with "flight edges"
   - Edge cost = distance + altitude change + energy drain estimate
   - Bot follows flight edge by jetting toward waypoint at specified altitude
   - Key flight paths:
     - Base rooftop → enemy base rooftop (capper routes)
     - Hill peaks → valley crossings
     - Interior exit → nearby hill (escape routes)

### Implementation Plan

**Phase A: Interior Waypoints** (~50 lines C++)
- Define `InteriorWaypoint` struct: `{Vec3 pos, int building, int[] neighbors}`
- Hardcode ~20 waypoints for Raindance (both bases are symmetric): doorways, gen room, stations
- Connect to nearest nav grid cell at each doorway
- Modify `astarPath()` to include interior waypoints in the search

**Phase B: Enhanced Movement** (~30 lines C++)
- Add `botState` for ENTER_BUILDING and EXIT_BUILDING
- When target is inside building (generator, station), route through doorway waypoints
- When inside, reduce speed, no skiing, careful corner navigation

**Phase C: Flight Edges** (~40 lines C++)
- Pre-compute a handful of strategic flight edges (base-to-base, hill-to-hill)
- A* considers flight edges when bot has enough energy
- Movement along flight edge: jet at computed angle toward next waypoint

**Phase D: Generator Targeting** (~20 lines C++)
- Add ATTACK_GENERATOR bot state
- Offense bots periodically check if enemy gen is alive → switch to gen attack
- Route through doorway waypoints to reach gen room
- Fire at generator, then retreat

### Estimated Complexity

- Interior waypoints: ~80 lines C++ (data + pathfinding integration)
- Generator targeting: ~30 lines C++ (role logic)
- Flight edges: ~50 lines C++ (edge data + movement)
- Total: ~160 lines, no external dependencies

### Why Not External Libraries

1. **Architecture mismatch** — Our sim runs in C++/WASM; JS libraries would need expensive bridge calls every frame
2. **Performance** — Custom C++ is faster than any JS library for our tight game loop
3. **Simplicity** — We have 8 bots max on a single map; we don't need industrial navmesh
4. **Bundle size** — Zero additional bytes vs 50-600KB for a library
5. **Control** — We can tune bot behavior precisely for Tribes movement (skiing, jetting, momentum)

### Stretch: Skiing Route Planning

For smarter skiing, the nav grid edge weights could be modified to prefer:
- Downhill slope direction (momentum gain)
- Smooth terrain (avoid sharp slope changes that break ski chains)
- Routes through valleys (gravity-assisted speed)

This would make bots choose ski-friendly routes naturally through the existing A*.

## Confidence Assessment

**High confidence** to proceed with implementation. The hybrid waypoint approach is:
- Proven (original T1 used this exact concept)
- Lightweight (no dependencies)
- Incremental (can ship interior waypoints first, flight edges later)
- Compatible with existing code (extends, doesn't replace, current A*)

**Recommendation:** Start with Phase A (interior waypoints) and Phase D (generator targeting) as they have the highest gameplay impact. Flight edges are a nice-to-have that improves capper behavior but isn't critical for good bot gameplay.
