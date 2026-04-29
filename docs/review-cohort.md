# Firewolf Review Cohort

The expert panel for Adversarial Convergence Reviews on the Firewolf project. Pull this file up whenever running a review session.

---

## Design Panel

| Name | Lens | When to Include |
|---|---|---|
| **Jony Ive** | Design coherence, visual identity, user experience, simplicity, "should this exist?" | Always for design questions, Phase 6 Refinement, UI/HUD reviews, aesthetic decisions |
| **Jenova Chen** | Multiplayer emotion, cooperative play feel, unique aesthetics, player connection | Game design sessions, team play mechanics, atmosphere, phase transitions |
| **Fumito Ueda** | Atmosphere through restraint, visual identity via scale not fidelity, legibility | Visual identity questions, terrain, lighting, "what makes it feel like Tribes" |
| **Will Wright** | Emergent systems, player-generated stories, phase-based gameplay, scoring incentives | Game design sessions, phase system design, mech waves, scoring/incentive structures |

## Technical Panel

| Name | Lens | When to Include |
|---|---|---|
| **John Carmack** | Engine architecture, performance, FPS game design, rendering pipelines, memory | Always for T1 modules, renderer reviews, performance questions, terrain, physics |
| **Michael Abrash** | Low-level performance, GPU shaders, memory access patterns, quality tiers | Renderer core, terrain shader, particle systems, "runs on any hardware" questions |
| **Casey Muratori** | Simplicity, no unnecessary abstraction, gameplay feel, systems design, data flow | Always for architecture reviews, game logic, "should this be simpler?" |
| **Fabian "ryg" Giesen** | GPU pipeline, draw calls, instancing, shader optimization, naming/clarity | Renderer modules, particle systems, material systems, naming reviews |
| **Mike Acton** | Data-oriented design, cache coherence, data layout, module boundaries | Game logic, WASM bridge, data flow between modules, ECS-like patterns |
| **Sean Barrett** | Practical engineering, API design, stb-style simplicity, naming | Game bridge, UI/HUD, utility modules, API surface reviews |
| **Tim Sweeney** | Engine-scale architecture, asset pipelines, scalability | Large refactors, asset pipeline, editor architecture |
| **Erin Catto** | Physics engines, collision, character controllers | Physics module (renderer_rapier.js), building colliders, mech physics |
| **Glenn Fiedler** | Netcode, client prediction, state sync, multiplayer architecture | Networking stack (client/network.js, wire.js, prediction.js) |

## Adversarial Pass 1 Personas

| Name | Role | Focus |
|---|---|---|
| **The Saboteur** | Break it | Race conditions, null derefs, edge cases, "what if this is called twice?" |
| **The Wiring Inspector** | Trace connections | API mismatches, wrong argument types, stale state, callback ordering |
| **The Cartographer** | Map the territory | Data model gaps, missing states, incomplete enums, undocumented assumptions |

## How to Use

### Per-Module Review (Passes 1-6)
1. **Pass 1 — Break It:** Saboteur + Wiring Inspector + Cartographer
2. **Pass 2 — Challenge Architecture:** Pick 5-7 from Technical Panel based on module domain
3. **Pass 3 — Debate to Consensus:** Same experts from Pass 2, now in dialogue
4. **Pass 4 — System-Level Review:** Technical Panel + "should this exist?" (Ive's razor)
5. **Pass 5 — AI Rules Extraction:** Technical Panel produces @ai-contract blocks
6. **Pass 6 — Design Intent:** Ive (lead) + relevant Design Panel members

### Game Design Sessions
Full Design Panel + Carmack + Muratori + relevant specialists

### Expert Selection by Module Domain

| Domain | Experts |
|---|---|
| Renderer core | Carmack, ryg, Abrash, Muratori, Acton, Sweeney, Ive |
| Physics | Carmack, Erin Catto, Abrash, Muratori |
| Game bridge / WASM | Carmack, Abrash, Muratori, Acton, Barrett |
| Characters | ryg, Carmack, Muratori, Ive |
| Networking | Glenn Fiedler, Carmack, Muratori, Acton |
| Effects / Polish | ryg, Abrash, Carmack, Ive |
| UI / HUD | Barrett, Muratori, ryg, Ive |
| Map Editor | Carmack, Muratori, Ive, Wright |
| Game Design | Full Design Panel + Carmack + Muratori |
| Design / Refinement | Ive (lead), Carmack, Muratori, ryg |

---

## Key Principles from Prior Sessions

- **Ive's Razor:** If you can't articulate what sensation a module creates for the player, it's noise.
- **Clone What Works:** Before building any new system, find the canonical implementation and clone it.
- **Faceted Identity:** The terrain's angular faceted geometry IS the visual style. Don't smooth it away.
- **Performance is Identity:** Runs on any computer. 60fps non-negotiable. Quality tiers from vertex color to full PBR.
- **Phase-Reactive World:** Every game state has its own atmospheric personality. The world tells you what's happening.
- **Belonging Over Mastery:** The core feeling is "my tribe needs me and I need my tribe."

## Game Identity (North Star)

- **Feeling:** Belonging + Adaptation + Scale + Aliveness
- **Visual:** Faceted terrain, readable silhouettes, bold atmosphere, procedural boldness
- **Audio:** Generative, phase-responsive. The world has a sound.
- **Performance:** Any hardware. Quality tiers. 60fps always.
- **NOT:** AAA realism, cel-shading, Tribes 3 plastic, generic sci-fi
