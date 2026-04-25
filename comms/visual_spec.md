# Visual Spec — Starsiege: Tribes (1998), Browser Edition

> **Maintainer:** Manus.
> **Status:** Living document. Treat as ground truth for visual fidelity decisions.
> **Last updated:** 2026-04-25.
> **Audience:** Claude Code. Read before any UI, model, HUD, or terrain work.

This document defines the canonical 1998 Tribes 1 look that the browser port must match. When the current build deviates, the spec wins. Modern enhancements (bloom, AA, mipmaps, higher-resolution textures) are permitted only when they preserve **silhouette, palette, and layout** as defined here.

## 1. Reference images (in this repo)

All references live in `/comms/references/`. Cite the filename in `claude_status.md` when implementing against a specific reference.

| File | What it documents |
|---|---|
| `ref_main_menu_v130.png` | The actual 1998 main menu: dark blue/black starfield background, gold beveled "TRIBES" wordmark, "STARSIEGE" small caps subtitle, plain white sans-serif menu items (`PLAY GAME`, `WEBSITE`, `QUICK START`, `DEMOS`), top tab bar (`PLAY`, `PRO/CHAT`, `OPTIONS`, `QUIT`), and bottom-right "Version 1.30" footer. |
| `ref_t1_outdoor_combat.jpg` | Authentic in-game HUD and outdoor terrain. Shows the bottom-left inventory column, top-left health/energy bars (lime green), top-center chat log (green text on dark transparent panel), top-right circular compass with NSEW labels and 20x zoom indicator. |
| `ref_t1_inventory_station.jpg` | Inventory station UI panel and a sensor-network turret base. Note flat-shaded grey/tan industrial paneling, no sci-fi gradients. |
| `ref_t1_outdoor_base.png` | Wide outdoor view of a Diamond Sword base, terrain LOD, distance fog. |
| `ref_t1_concept_armors_weapons.jpg` | Concept art of the three armor classes (Light / Medium / Heavy) and the weapon set silhouettes. Use as silhouette reference, not as exact in-game appearance — in-game models are lower-poly and more saturated. |

If/when the user provides original 1998 in-game screenshots from the local install at `/Users/jkoshy/Darkstar/`, drop them into `/comms/references/` with a `ref_t1_*.png` name and add a row to this table.

## 2. Color palette (locked)

The 1998 Tribes color palette is **utilitarian, military, and earth-toned**. It is emphatically **not** the dark-blue cyberpunk/sci-fi palette currently in `index.html`.

| Role | Hex | Usage |
|---|---|---|
| HUD bar — health (full) | `#3CFF3C` | The lime/neon green of the top-left health bar. Gradient to yellow `#FFEE00` at half, red `#FF2020` near zero. |
| HUD bar — energy (full) | `#3CC8FF` | The cyan blue of the energy bar directly under health. |
| HUD chat panel bg | `rgba(15,30,15,0.55)` | Semi-transparent dark olive-green panel behind chat/event log. |
| HUD chat text | `#90FF90` | Pale lime green, monospace bitmap. |
| Compass ring | `#5A8A5A` | Muted forest green outline; cardinal letters in same green. |
| Team — Blood Eagle | `#C8302C` | Saturated brick red. Not pink, not magenta. |
| Team — Diamond Sword | `#2C5AC8` | Muted royal blue. Not cyan. |
| Team — Starwolf | `#D4A03C` | Mustard yellow / amber. |
| Team — Phoenix | `#D55A1A` | Burnt orange. |
| Terrain base | `#7A8A55` to `#A89060` | Olive-green grass to dry tan dirt. |
| Sky horizon | `#B8C4C8` to `#7A8A9A` | Hazy grey-blue, never saturated cyan. |
| UI panel bg | `#1A1A18` to `#2A2A24` | Near-black with warm grey tint, never blue-tinted. |
| UI panel border | `#7A6A4A` | Brushed bronze/brass border, 1–2px. |
| UI text — primary | `#E8DCB8` | Off-white parchment. |
| UI text — accent | `#FFC850` | Gold (matches the wordmark). |
| Wordmark gold | `#D4A030` to `#FFEE60` | Vertical gold gradient with bevel/emboss. |

**Forbidden in production UI:** `#3a7bd5`, `#7cb8ff`, `#5a9ad5`, `#8cc4ff`, and any other pure-blue values currently in `index.html`. Those are Halo / Mass Effect colors, not Tribes.

## 3. Typography (locked)

| Surface | Font | Notes |
|---|---|---|
| Wordmark `TRIBES` | Heavy slab-serif display face with vertical gold gradient and 1px dark outline. Use **Cinzel** as a free fallback to the original beveled bitmap. Letter-spacing wide. **Not Orbitron.** |
| `STARSIEGE` subtitle | Same family as wordmark, much smaller, all caps, letter-spaced ~6px. |
| Menu items | Clean, slightly condensed sans-serif. **Bank Gothic** or **Barlow Condensed** match the era. White, no glow, no gradient. |
| In-game HUD numbers | A bitmap/pixel font is canonical. **VT323** is a reasonable free substitute. Render numbers from a sprite sheet if available in the asset dump. |
| Chat / event log | Monospace pixel font, lime green. |
| Tooltips / small captions | Same condensed sans as menu items, smaller. |

**Remove from production code:** `Orbitron`, `Rajdhani` (currently imported in `index.html` line 8). Wrong era, wrong genre.

## 4. UI structure — main menu

Match `ref_main_menu_v130.png`:

- Full-screen background: dark space/starfield with faint gold/blue circular tribal sigils as watermarks (the Starsiege logo subtly visible behind).
- Centered, large gold beveled `TRIBES` wordmark, with a small `STARSIEGE` above-left.
- Below the wordmark, a 2x2 grid of simple text menu items (white, 32–40px, no buttons, no backgrounds):
  - Top-left: `PLAY CTF`
  - Top-right: `WEBSITE` (repoint to the repo URL or remove)
  - Bottom-left: `QUICK MATCH`
  - Bottom-right: `OPTIONS`
- Top of screen: a thin tab strip with `PLAY  PRO/CHAT  OPTIONS  QUIT`. Optional for v1.
- Bottom-left footer: tasteful fan-project attribution.
- Bottom-right footer: `Version 0.x` in small grey text.
- A small Blood Eagle sigil watermark below the wordmark, centered.

**Animations:** none required. Do not add sci-fi panel transitions, glow pulses, or particle effects.

## 5. UI structure — sub-menus (Game Setup, Team Select, Loadout)

Replace the current dark-blue panels (`<div class="panel">` in `index.html`) with windows that look like the original Sierra/Dynamix dialog style:

- Window chrome: rectangle (no rounded corners) with a 1–2px brass border (`#7A6A4A`), inset 1px dark line, near-black warm grey fill.
- Title bar across the top: same fill darker, gold text left-aligned, no close button (Esc returns).
- Content area: parchment text, monospace numeric values, simple checkbox/radio controls drawn as small recessed squares with a gold check.
- Buttons: rectangular, brass border, parchment text on near-black, hover = subtle inner gold glow (not outer blue glow).
- No `linear-gradient`. No `box-shadow: ... blue`. No `border-radius` over 2px.

## 6. In-game HUD (canonical layout — match `ref_t1_outdoor_combat.jpg`)

| Region | Element | Notes |
|---|---|---|
| Top-left | Two horizontal bars stacked: **health** (green→yellow→red) and **energy** (cyan). Each ~140px wide, ~12px tall, 1px green-grey border, segmented into ~10 ticks. Above them, a thin chat/event log panel. |
| Top-center | Chat / event log: 4–6 lines, dark olive-translucent background, lime green monospace text. Auto-fade after ~6 seconds. |
| Top-right | **Circular compass / sensor radar.** Diameter ~100–120px. NSEW letters around the ring in muted green. Player-orientation needle in center, friendly blips green, enemy blips red, projectile blips small white. To the left of the compass: zoom indicator (e.g., `20x`) and match clock `MM:SS:T`. |
| Right side, below compass | Currently-equipped weapon icon in a small box with ammo count next to it (e.g., `24` for disc launcher discs). |
| Left side, vertical column | **Inventory icons** stacked top-to-bottom: pack (repair / sensor / cloak), grenades, mines, beacons. Each icon ~24px square with a small numeric counter to the right. Shown only when owned. |
| Bottom-left | Player name and small team flag icon. |
| Bottom-right | Score panel: small team flags + current cap counts, plus `Home` / `Taken` / `Carried` flag-state indicator per team. |
| Center | Crosshair: small green `+` (5–7px) with a subtle dot. Recoil/spread feedback as cross-segments separating outward. |

**Do not** put bars or icons in places they aren't shown above. **Do not** invent new HUD widgets.

## 7. Models — current state and required fixes

Claude has loaded the **real** original `.dts` files: `larmor.dts`, `marmor.dts`, `harmor.DTS`, `discb.DTS`, `chaingun.DTS`, `grenade.DTS`, `tower.DTS`. This is excellent. The renderer is the bottleneck:

1. **Skeletal hierarchy is missing.** `.dts` files store nodes as a hierarchy (root → torso → arm.L → forearm.L → hand.L → ...). Currently all 38 mesh pieces of an armor are merged into one blob at the origin, causing intersection. **Fix:** parse the `nodes[]` and `transforms[]` chunks of the DTS, build a parent/child tree, and apply each node's local transform when rendering its mesh. Reference: the Torque DTS format spec; or invoke the user's local Darkstar source where the original loader exists.
2. **No textures.** `.dts` files reference texture names (`larmor_red.bmp`, `larmor_blue.bmp`, etc.) that exist in the user's asset dump at `/Users/jkoshy/Darkstar/assets/tribes/`. **Fix:** load those textures (convert BMP→PNG at build time if needed), bind them per-mesh based on material slot, apply team color tint where the original did.
3. **Animation.** Out of scope for v1. Static T-pose is acceptable until the skeleton is correct.

**Silhouette truth (from `ref_t1_concept_armors_weapons.jpg` and gameplay screenshots):**
- **Light armor:** humanoid, small backpack jetpack, slim limbs, rounded helmet with visor.
- **Medium armor:** thicker chest plate, larger shoulder pads, larger jetpack, taller helmet.
- **Heavy armor:** massive bulky mech-like silhouette, oversized chest, large jet thrusters on back, slow gait, often shown with the mortar.

## 8. Terrain

- **Use the real Raindance heightmap.** Claude has it extracted at `raindance_heightmap.h` (257x257). Replace the procedural noise in `wasm_main.cpp` with this dataset.
- **Tile texture.** Apply the original Raindance terrain texture set (grass + dirt + rock blend layers) from `/Users/jkoshy/Darkstar/assets/tribes/`. Modern enhancement allowed: bilinear-filter the textures and add a higher-detail normal map; do not change the macro color palette.
- **Distance fog.** Match `ref_t1_outdoor_base.png`: a soft hazy fade to `#B8C4C8` starting around 60% of view distance. The fog is the visual signature of T1 outdoor combat.
- **Sky.** Hazy gradient from `#7A8A9A` at horizon to `#5A6A7A` at zenith with soft cloud sprites. **No deep blue, no stars, no nebulae.**
- **No procedural noise terrain in production.** That can stay as a debug fallback.

## 9. Bases / structures

The current "flat platform boxes" are placeholders. Tribes 1 bases are made of recognizable building primitives:

- Generator room (small grey building with vents)
- Inventory station building (long low building with a glowing teal pad inside)
- Vehicle pad (large square pad with markings)
- Sensor pylon (tall thin antenna)
- Turret base (squat pad with a turret head)
- Flag stand (low pedestal with the flag pole)

**Fix sequence:** start with just the flag stand and a generator room on each side; expand later.

## 10. Weapons (visual)

Each weapon's projectile must be visually distinct, matching the original:

| Weapon | Projectile visual |
|---|---|
| Spinfusor (disc launcher) | White spinning disc ~0.4 m diameter, bright cyan glow trail, ~50 m/s. |
| Chaingun | Yellow tracers, 8 rounds/sec, no trail, bright muzzle flash. |
| Plasma gun | Red-orange globule with crackling halo, slow, large splash. |
| Grenade launcher | Round dark grey ball, bounces, 3-second fuse with red blink before explosion. |
| Mortar | Large dark shell, slow lobbed arc, very large explosion. |
| ELF gun | Continuous purple electric beam, drains target energy. |
| Laser rifle | Instant red hitscan beam with small heat shimmer at impact. |
| Blaster | Yellow energy bolt, slow, the starter weapon. |
| Hand grenades | Small dark spheres tossed in arc, 3-sec fuse. |

Currently every projectile renders as "small spinning disc" — a clear regression from the spec.

## 11. Sound

Out of scope for the visual spec, but: the 147 `.ogg` files at `/Users/jkoshy/Darkstar/assets/tribes/` should be wired up in the order: jetpack loop → footsteps → weapon fires → explosions → flag-event voice lines (`Our flag is taken!`, `Capture!`). The original voice-over set is iconic; do not re-record.

## 12. Acceptance gate

A change is "Tribes-correct" if it passes all four:

1. **Silhouette test:** would a 1998 player recognize this object/UI element on sight?
2. **Palette test:** every color used appears in section 2 of this spec.
3. **Layout test:** every HUD element is in its section-6 region.
4. **Modernization test:** if the change adds bloom/AA/higher-res textures, the silhouette and palette are unchanged.

If all four pass: ship it. If any fails: revise.

---

*Spec end. Updates to this file should be committed by Manus only. Claude may propose changes via `comms/open_issues.md` with a `[spec-change-request]` tag.*
