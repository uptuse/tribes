# Starsiege × Tribes BE — Hybrid Design Proposal

*Research and design doc, R32.20-prep. References verified Apr 26, 2026.*

---

## Why this is the right question

Starsiege and Tribes were not parallel franchises that happened to share a publisher. They were **the same universe by the same studio (Dynamix), released eight months apart in 1999**, and Tribes is canonically the *sequel-by-implication* to Starsiege — set roughly 600 years later in the same lore continuity. The "Tribes" themselves descend from the Knights, Hercs, and Cybrid wars depicted in Starsiege.

References:
- [Tribes Wiki — Universe](https://tribes.fandom.com/wiki/Universe)
- [Ben Overmyer — The Lore of Starsiege: Tribes](https://benovermyer.com/blog/2012/06/the-lore-of-starsiege-tribes/)
- [Starsiege Compendium Project](https://starsiegecompendium.com/empire/index.html)
- [Reddit r/Tribes — Why is Tribes so different from Earthsiege/Starsiege/Cyberstorm](https://www.reddit.com/r/Tribes/comments/13ffjn3/why_is_tribes_so_different_from_the/)

There is documented concept art for **HERCs in Tribes 1 and Tribes 2 that never shipped** — Dynamix originally intended Hercs to be deployable battlefield assets in Tribes but cut them for scope. Doing this hybrid isn't a fan crossover; it's *finishing the original vision*.

---

## Part 1 — What Starsiege actually plays like

Drawing on Earthsiege (1994), Earthsiege 2 (1996), Starsiege (1999), and the Tribes 2 vehicle system that inherited Starsiege's design language.

### Locomotion: deliberate, weighty, terrain-aware

A HERC is a 12-30 ton bipedal walker. Movement is **slow, momentum-heavy, and terrain-affected**:

- Top speed varies by chassis — Light scouts (Razor, Minotaur) hit ~80 kph; Heavies (Apocalypse, Emancipator) cap at ~25 kph.
- **No instant turns.** The torso rotates independently of the legs; you can run forward while shooting sideways. *This is the iconic "twin-stick mech" feel.*
- Going uphill cuts speed dramatically; going downhill, the HERC builds momentum it can't easily shed. There is no "skiing" — that's a Tribes-specific mechanic that does not exist in Starsiege.
- A HERC weighs **3-5 tons of jump-jet fuel** allowing brief boosted hops. Less mobile than infantry jets — they're for crossing obstacles, not flight.
- Crouch / kneel mode for stability when sniping or holding a position.

### Combat: shields, armor, heat — three independent systems

This is the defining mechanical novelty of Starsiege. Every shot is a question of **which damage layer to hit and what your weapons can attack**.

| Layer | What hits it | What damages it |
|---|---|---|
| **Shields** (recharging energy bubble) | Energy weapons (Blasters, ELF, PBC, Plasma) — most kinds | Drained in real time; recharges from reactor when not firing |
| **Armor** (per-component plates: torso, legs, arm L/R, head/cockpit) | Slug/missile/cannon weapons after shields are down | Permanent damage until repaired at depot |
| **Internals** (computer, sensors, jets, weapon mounts) | After armor is gone on a component | Each system can be knocked offline — lose your jets, your radar, a specific weapon |

Result: **target prioritization matters**. A skilled pilot strips shields with PBCs, then switches to slug-based MFAC autocannons or Class-V missiles for armor-shredding.

### Weapon families

Roughly four functional groups (see [the-junkyard.net](https://legacy.the-junkyard.net/weapons-starsiege.php) for the full list):

1. **Energy direct-fire** — Blasters (variable charge), Plasma cannons (slow heat-heavy), Particle Beam Cannons (PBC: long-range hitscan). Anti-shield. Generate heat.
2. **Slug / cannon** — MFAC mass-driver, Catapult heavy slug, autocannons. Anti-armor. Limited ammo, no heat.
3. **Missiles** — Class-I through Class-VI, lock-on capable. Anti-armor or anti-air; some lock to heat signature, some to radar. Ammo-limited.
4. **Specials** — ELF Gun (drains target's energy reservoir; both anti-shield and anti-electronics), TAG (tags target for friendly missile lock), Smart Gun (turret-style auto-track).

Weapon hardpoints are loadout-driven before deployment; you can't change once committed. **Every weapon takes mass slots and adds to heat dissipation needs.**

### Heat: the meta-resource

Energy weapons generate heat. Heat builds linearly with fire rate. At thresholds:

- 70%: HUD turns amber, accuracy degrades
- 90%: weapons cycle slower, sensors flicker
- 100%: emergency shutdown, immobile for 5-10 seconds, **broadcasting your position to all enemies**

This forces **rhythm** — alpha-strike or sustain. Most pilots run a "cool" loadout (fewer energy guns, more slug) and a "hot" loadout (PBC + Plasma) and choose based on mission.

### HUD: information density as identity

The Starsiege cockpit is a four-quadrant readout:
- **Center**: external camera view + reticle
- **Left**: weapon group status, ammo, heat per gun, current weapon group selection (1-4)
- **Right**: shield/armor/internal status as a **wireframe paper-doll of your HERC** with damage zones color-coded
- **Bottom**: throttle, jet fuel, contacts list with distance and IFF
- **Top**: target paper-doll (when you've designated one) showing *their* damage state

This dense, technical aesthetic is **half the reason Starsiege feels like Starsiege**. Ours could borrow it for a dedicated mech-HUD mode.

### Lore-anchored chassis archetypes

| Class | Tons | Speed | Role | Examples |
|---|---|---|---|---|
| **Recon** | 12-15 | 70-90 kph | Scout, harass, tag for missile lock | Razor, Minotaur |
| **Light** | 18-22 | 50-70 kph | Skirmisher, fast cap | Adjudicator, Wolverine |
| **Medium** | 22-28 | 40-55 kph | Workhorse, mixed loadout | Sampson, Talon, Olympian |
| **Heavy** | 28-34 | 25-40 kph | Frontline brawler, gen-killer | Apocalypse, Emancipator |
| **Cybrid** | varies | varies | Alien feel — angled, glowing, irregular silhouettes | Goad, Old One, Master |

---

## Part 2 — What we already have vs. what's missing

Strict mapping against the current Tribes BE codebase (R32.19).

### Already present (or trivially adjacent)

| Starsiege concept | Our equivalent |
|---|---|
| Three armor classes (light/medium/heavy infantry) | Yes — already shipped, trivially extends to "tier" concept |
| Energy reservoir with regen | Yes — jetpack energy is exactly this; ELF gun already drains it |
| Target paper-doll HUD | We don't have it but our HUD module can do it |
| Weapon hardpoints | We have weapon slots 1-4; mapping to Starsiege loadout slots is structural-only |
| Vehicle entry/exit | Tribes 1 had this for the Wildcat and Beowulf; lore-canon |
| Map scale | Raindance is 1024m × 1024m — fine for HERC combat |
| Heightmap-aware physics | Yes (C++ side); HERC ground-clamp would inherit this |
| Polish / FX module | Already exists, perfect place for cockpit overlays |

### Missing but additive (JS-side achievable, no C++)

| Starsiege concept | Approach |
|---|---|
| Cockpit HUD overlay | Pure DOM/SVG, layered same as our R32.18 zoom reticle |
| Heat as a resource | New `window.HeatFX` module driving a heat bar; debuffs are visual-only initially (HUD warnings, screen shake on overheat) |
| Damage paper-doll | Read player health into a 2D canvas; overlay during combat |
| Weapon mode/group selection | We already cycle 1-5; just relabel and group |
| Missile lock indicator | Trail-and-cone overlay on target, audio chirp |
| Weapon families with cosmetic differentiation | Per-weapon viewmodel work I deferred earlier |

### Missing AND requires C++ work

| Starsiege concept | Why C++ |
|---|---|
| **Pilotable HERC** as a separate entity with its own physics | New entity type, AABB, mass, collision response |
| **Independent torso/leg rotation** | Player rig change — our soldier mesh has one yaw axis |
| **Per-component armor zones** | Hit-detection against capsule subdivisions, not a single AABB |
| **Shield-vs-armor damage routing** | Damage pipeline change |
| **Weapon hardpoints on the chassis** | Projectile spawn locations per mount |
| **Non-skiing mech locomotion** | Different ground-clamp + acceleration curve; can't just reuse soldier physics |

---

## Part 3 — The hybrid: three viable scope tiers

Picking the right scope is the whole question. Three options, each progressively more ambitious.

### Option A — "Skin" hybrid (1-2 days, JS-only)

**What it is:** Re-skin our existing infantry-CTF as a Starsiege-flavored experience without changing any underlying mechanics.

- Add the Starsiege HUD theme (paper-doll, heat bar, four-quadrant layout) as an alternative HUD overlay toggleable with `H` or always-on for a loadout
- Rename our four weapons to Starsiege equivalents: Spinfusor → "Plasma Mortar," Chaingun → "MFAC autocannon," Plasma → "PBC blaster," GL → "Class-II missile"
- Add **heat as a soft mechanic**: every shot adds heat, cooldown drains it, overheat causes weapon delay (no shutdown stun yet — that needs C++)
- Color-grade the world cooler/grayer with the LUT from the Three.js research doc — Starsiege's palette was bleak military gray-greens
- Add Starsiege-style ambient cockpit sounds: fan hum, occasional radio chatter ("Cybrids on the ridge, sector 7"), warning chimes for low energy
- Title screen and music shift to Starsiege aesthetic

**What's true:** Players still play infantry, still ski, still capture the flag. The fiction has changed; the mechanics haven't. **Low risk, fast ship.**

**Verdict:** This is the right MVP. It validates aesthetic direction before committing to a multi-week C++ effort.

### Option B — "Drivable HERC" hybrid (4-8 weeks, requires Claude / C++ work)

**What it is:** Add HERCs as deployable vehicles that players board, drive, fight in, and exit. Infantry CTF still runs; HERCs are a tactical asset like Tribes 2's Beowulf tank.

Required changes:
- New entity type in C++ (vehicle base class, HERC subtype)
- Vehicle entry/exit state on the player (riding-flag in playerView)
- Modified camera mode (cockpit-cam vs. infantry-cam)
- HERC-specific physics: 4× mass, no skiing, jet-jumps not jet-flight, slow turn rate, terrain-aware ground clamp
- Three HERC chassis: Recon (fast, light weapons), Medium (balanced), Heavy (slow, gen-killer weapons)
- Shield/armor/heat layered damage system
- Spawn HERCs at base "vehicle pads" — already lore-canonical in Tribes 2

**What's true:** Two distinct gameplay layers. Infantry can hijack a Herc; a Herc can crush infantry; flag carriers prefer light-armor for speed; defenders pilot heavies. Tribes' core tension between mobility and firepower scales up an order of magnitude.

**Verdict:** This is the dream. It's also a real engineering project — not weekend scope.

### Option C — "Mech-class infantry" hybrid (1-2 weeks, mostly JS)

**What it is:** Don't add vehicles. Instead, **reinterpret our existing heavy armor class as a "Light Herc"** — same bipedal pilot, but with cockpit-style HUD, mech-flavored weapons, slower-but-tankier movement, and Starsiege's shield/armor/heat damage model.

- Heavy armor becomes "Recon-class HERC"
- Add cockpit HUD overlay only when in heavy armor
- Slow heavy armor's top skiing speed by 30%, raise jet thrust by 20%, raise health by 50% — feels mech-like without new physics
- Weapons used by heavy armor get the heat system + shield-vs-armor damage flag
- Light/medium armors stay infantry; you choose at spawn

**What's true:** The aesthetic and mechanical distinction lives. Heavies feel like **walking tanks**; lights feel like **skating commandos**. Same map, same flag rules. Player choice reshapes the engagement.

**Verdict:** This is the "best of both worlds" middle path. Most Tribes players will recognize it as "heavy armor done right." Most Starsiege fans will see the cockpit and feel home. **Recommended next step if Option A lands well.**

---

## Part 4 — What needs to be true for this to work

Hard requirements for a hybrid to feel coherent rather than confused:

1. **One unified scale.** Either everyone is infantry-scaled (Option A/C) or there are clearly two scales: infantry vs. mech (Option B). Don't mix scales mid-encounter without commitment.
2. **Movement speed differentiation must be enormous.** A Tribes infantry skier hits 200 kph. A heavy HERC walks at 25 kph. If you put both on the same map, the infantry will dominate every objective. Solutions: bigger maps, choke points, mech-only weapons that hard-counter infantry mobility (slow fields, ELF stun), or designated mech-only zones.
3. **Shield/armor/heat must be readable.** If players can't tell at a glance which damage layer they're hitting, the system doesn't add depth — it adds confusion. Paper-doll HUD is non-negotiable.
4. **The HUD has to commit.** Half-Tribes-half-Starsiege HUDs look like aborted ports. Either ship the cockpit aesthetic completely (border, paper-doll, four-quadrant readouts) or don't.
5. **Loadout must matter.** Starsiege without pre-deploy loadout choice is just infantry CTF with extra steps. Need at minimum: pick a chassis, pick a primary weapon group (energy/slug/missile), pick a special.
6. **Lore needs a hook.** Starsiege ended with humanity scattered across the stars after the Cybrid wars. Tribes opens 600 years later with the Tribes themselves descended from those scattered survivors. **The hybrid lives in the gap year — "300 years after the wars, before the Tribes formed."** Maps could be ruined Earth/Mars frontier sites. Voice lines could reference Petresun, the Knights, the Old Ones.

---

## Part 5 — Recommended path

**Ship Option A as R32.20-R32.22** over the next few sessions. Pure JS. Tests aesthetic direction.

| Release | Content |
|---|---|
| R32.20 | Starsiege HUD theme: paper-doll, heat bar, four-quadrant layout. Toggle on/off via `H`. |
| R32.21 | Soft heat mechanic: weapons heat up, overheat causes 0.5s firing delay, screen tint. Cockpit ambient audio loop. |
| R32.22 | Starsiege color LUT, weapon rename pass, voice line set, title screen + music shift. |

**Then evaluate.** If the aesthetic clicks, escalate to **Option C (mech-class infantry)** as R33.x. Heavy armor becomes Recon HERC. Visible commitment to the hybrid identity.

**Option B (drivable HERCs)** stays on the roadmap as R34.x and the eventual end-state, gated on (a) Option A/C succeeding and (b) Claude having capacity for the C++ side.

---

## Part 6 — Day-one experiments worth running before any code

A few cheap things to validate before committing:

1. **Mock the HUD in Figma or just pure CSS.** Put the paper-doll, heat bar, weapon groups on screen statically. Look at it for an hour. Does it feel like Starsiege? Does it feel like Tribes? Does it feel like a coherent third thing?
2. **Make a 30-second highlight reel with the new color grade.** A LUT pass + slowed footage. If it doesn't read as Starsiege-ish immediately, the visual direction is wrong and we should rethink.
3. **Build a Starsiege-style audio loop** (cockpit fan + occasional radio chatter) and play it over current gameplay footage. Half of Starsiege's identity is auditory.

These three are 2-4 hours total and tell us whether the whole direction is right before any meaningful code commits.

---

## Reference resources

| Source | What's there |
|---|---|
| [Starsiege Compendium](https://starsiegecompendium.com/empire/index.html) | The Empire, the Knights, lore depth |
| [The Junkyard — Starsiege Weapons](https://legacy.the-junkyard.net/weapons-starsiege.php) | Full weapon stats and behavior |
| [The Junkyard — Starsiege Vehicles](https://legacy.the-junkyard.net/vehicles-starsiege.php) | All HERC chassis and stats |
| [Starsiege FAQ on GameFAQs (Brunneng)](https://gamefaqs.gamespot.com/pc/89815-starsiege/faqs/36621) | Combat tactics, weapon uses |
| [Starsiege Design Guide (Kamineko)](https://gamefaqs.gamespot.com/pc/89815-starsiege/faqs/30508) | Loadout theory, human vs. Cybrid |
| [Tribes Wiki — Universe](https://tribes.fandom.com/wiki/Universe) | Lore continuity (33rd-40th century) |
| [Dynamix Wiki — Cybrid](https://dynamix.fandom.com/wiki/Cybrid) | The antagonist faction |
| [SpaceBattles analysis thread](https://forums.spacebattles.com/threads/complete-starsiege-tribes-feats-and-analysis-thread.318023/) | Power-level cross-reference |

---

## TL;DR

**Tribes is canonically the future of Starsiege** — same studio, same universe, same lore. The hybrid is finishing Dynamix's original vision.

The defining Starsiege mechanics are:
1. **Weighty mech locomotion** (slow, momentum, no skiing)
2. **Shield/armor/heat triple-layer damage**
3. **Cockpit HUD with paper-doll** target visualization
4. **Loadout commitment** before deployment
5. **Energy/slug/missile/special weapon families**

For our codebase, the recommended path is:
- **R32.20-22:** Ship a "skin" hybrid (Option A) — Starsiege HUD, heat mechanic, color grade, audio. Pure JS. ~3 sessions.
- **R33.x:** If the aesthetic clicks, do "mech-class infantry" (Option C). Heavy armor becomes Recon HERC. ~1-2 weeks.
- **R34.x+:** Eventually, drivable HERCs (Option B). Real engineering. Needs Claude.

What needs to be true:
- Commit to the cockpit HUD or don't
- Make damage layers visually readable
- Ground the fiction in the canonical 300-year gap between Starsiege and Tribes
- Differentiate movement speeds enough that mechs and infantry are *different games* sharing a map
- Loadout choice must matter

**My recommendation: green-light Option A starting next session.**
