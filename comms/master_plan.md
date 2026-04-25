# Tribes 1 Browser Port: Master Plan & Playtest Tiers

> **Goal:** Port Starsiege: Tribes (1998) to a browser-playable WASM build.
> **Priority Directive:** Structure and mechanics first (unblocks playtesting the "feel"). Aesthetics and textures second.
> **Source of Truth:** TorqueScript logic extracted from T1.40 install (`/Users/jkoshy/Darkstar/base/scripts/server/items/`).

---

## Tier 1 — "Playable enough to feel Tribes" (Current Focus)

The goal of Tier 1 is to get the core movement and combat loop working so the user can drop into Raindance, ski, jetpack, and fire a Spinfusor at a target. Visuals can be untextured grey geometry, but the *shapes* and *physics* must be authentic.

### 1. DTS Skeletal Hierarchy (Armor & Weapon Models)
- **Current State:** `.dts` files load but render as untextured blobs at the origin because the node hierarchy parser is missing.
- **Requirement:** Port the skeletal parser from Darkstar `ts_shape.cpp` so the parts (torso, limbs, weapon mount) assemble into the correct humanoid silhouette.
- **Acceptance:** Light, Medium, and Heavy armors render as recognizable humanoid shapes holding a weapon. Untextured grey/magenta is acceptable.

### 2. Terrain Topology Fix
- **Current State:** Raindance heightmap loads but repeats every 64 columns due to a buggy extraction.
- **Requirement:** Re-extract the 257×257 heightmap from `Raindance.mis` using the canonical Darkstar `terrData.cc` logic.
- **Acceptance:** Terrain is a single continuous 257×257 field matching the original Raindance layout. No tiling artifacts.

### 3. Core Movement Physics (Skiing & Jetpacks)
- **Reference Numbers (Light Armor):**
  - Jet Force: `236`
  - Jet Energy Drain: `0.8` / sec
  - Max Energy: `60`
  - Mass: `9.0`
  - Jump Impulse: `75`
  - Max Forward Speed (Ground): `11` m/s
  - Max Jet Forward Velocity: `22` m/s
- **Requirement:** Implement the classic Tribes friction-negation "skiing" mechanic (jumping on downward slopes preserves/builds momentum).
- **Acceptance:** User can ski down a hill and jetpack up the other side to maintain speed > 30 m/s.

### 4. Spinfusor (Disc Launcher) Mechanics
- **Reference Numbers (`disclauncher.cs`):**
  - Muzzle Velocity: `65.0` m/s
  - Terminal Velocity: `80.0` m/s
  - Damage: `0.5` (Splash damage class)
  - Splash Radius: `7.5` m
  - Fire Time: `1.25` s
  - Inherited Velocity Scale: `0.5` (projectile inherits 50% of player speed)
- **Requirement:** Implement the Spinfusor with correct projectile speed, inheritance, and splash damage.
- **Acceptance:** Firing a disc while skiing forward adds inherited velocity; disc hits terrain and applies splash impulse (rocket jumping).

### 5. Base Geometry & Flag Logic
- **Requirement:** Load the `.dts` interiors/exteriors for the Raindance bases (even untextured) so they have collision. Implement flag pickup/drop/cap logic.
- **Acceptance:** Player can enter a base, collide with walls, grab the enemy flag, and return it to their own flag stand.

---

## Tier 2 — "Recognizably Tribes"

Once Tier 1 is playtest-able, we flesh out the rest of the core CTF loop.

### 6. Full Weapon Arsenal
- **Chaingun:** Hitscan or fast-projectile, high fire rate.
- **Grenade Launcher:** Bouncing physics, timed fuse.
- **Plasma Gun:** Slower projectile (`55.0` m/s), splash damage.
- **Mortar:** Heavy arc, massive splash damage (`0.85` damage, `10.0`m radius).
- **Laser Rifle:** Hitscan, drains player energy to fire.

### 7. Base Infrastructure (Generators & Turrets)
- **Turrets:** Auto-targeting AI, requires base power.
- **Generators:** Destructible. When destroyed, turrets and stations go offline.
- **Inventory Stations:** Allow players to change armor class and loadout.

---

## Tier 3 — "Polished Aesthetics"

Once the game plays correctly, we make it look correct.

### 8. Textures & Materials
- Apply original `.bmp` (converted to PNG) textures to terrain (splatmap), armors, and bases.
- Apply team coloring (Blood Eagle red vs. Diamond Sword blue) to armor skins.

### 9. Tribes 1 UI Shell
- Replace the modern Orbitron UI with the authentic 1998 look: gold beveled wordmarks, brass-bordered dialogs, utilitarian green/grey HUD, round compass.

### 10. Vehicles
- Implement Scout (Flier), LPC, HPC.
- Scout physics: Max speed `50`, Max alt `25`, Mass `9.0`, Lift `0.75`.

---

## Protocol for Darkstar Source Porting

**Manus is the design and reference-porting agent. Claude is the integrator.**

When Claude needs to port a complex Darkstar subsystem (e.g., the `.dts` parser or `.mis` extractor) and wants to avoid trial-and-error:
1. Claude identifies the necessary source files in `/Users/jkoshy/Darkstar/`.
2. Claude copies the relevant C++ snippets into a new file in `comms/source_excerpts/` (e.g., `comms/source_excerpts/dts_parser.cpp`).
3. Claude leaves a note in `comms/claude_status.md` asking Manus to port it.
4. Manus will read the C++, write a clean, modern JavaScript/C++ reference implementation, and push it to `comms/reference_impl/`.
5. Claude pulls the reference implementation and integrates it into the WASM build.

This keeps Claude focused on the running build and Manus focused on careful translation of 1998 engine logic.
