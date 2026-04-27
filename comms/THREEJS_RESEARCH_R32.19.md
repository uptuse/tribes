# Three.js Browser Games — Feature Inspiration & Visual Cohesion Playbook

*Research compiled overnight, R32.19 cycle. All links verified live as of Apr 26, 2026.*

This document has two parts:

1. **Feature Inspiration** — Notable Three.js browser games, what they do well, and what we could borrow for Tribes BE.
2. **Visual Consistency Playbook** — Techniques specifically for making a Three.js game feel "thematically of-a-piece," with examples and code-level patterns we can apply.

---

## Part 1 — Top Three.js Browser Games & What to Steal

The selection below skews toward games with technical or design ideas we could realistically port into our codebase without C++ work.

### 1. Slow Roads — [slowroads.io](https://slowroads.io/)

A meditative, infinite, procedurally-generated driving game. One of the most polished Three.js games ever shipped — the developer wrote an extensive [web.dev case study](https://web.dev/case-studies/slow-roads) on it.

**Why it matters for us:**

- **Time-of-day cycle** — A continuous, smoothly-interpolated day/night loop with sun position, sky color, fog density, and ambient temperature all driven from one master `time` parameter. Our `R32.11.2` HDRI sky is a static dome; making it cyclic would be a one-screen change to the sky shader and would feel enormous.
- **Weather presets that change everything at once** — Clear, overcast, fog, rain, snow. Each preset bundles fog params, particle systems, post-FX exposure, and audio. We currently have a polish module and a particle system but they're not wired to a single weather authority. A `weather.js` orchestrator would unlock this.
- **Procedural variation in repeatable assets** — Slow Roads has only a handful of tree, rock, and house meshes but never feels repetitive because each instance has small per-instance noise applied (scale, hue, rotation). We do this for grass tufts in `R32.8` but not for buildings or the four soldier types.
- **No HUD when not needed** — The HUD is auto-hidden during scenic moments. We could fade ours out when no enemies are visible / no recent damage / no flag carry — feels much more cinematic.
- **Music that adapts to camera mode** — Calmer when slow, energetic when fast. We have ambient audio but no dynamic mixing.

### 2. Narrow One — [narrow.one/](https://narrow.one/)

A 5v5 multiplayer archery CTF game by Pelican Party Studios. **Stylistically the closest analog to what we're trying to be.** Open-world castle arenas, primary fire is a single-shot weapon (bow vs. our spinfusor), team-color-coded soldiers, capture-the-flag.

**Why it matters for us:**

- **Stylized low-poly cohesion** — Every asset is hand-modeled at the same poly budget with the same shader. No PBR realism mixed with low-poly props. Look any direction and it feels like one game. (We have some of this but our terrain shader and our soldier shader fight each other a bit.)
- **Trail rendering on projectiles** — The arrow leaves a thin curved fletching-trail that arcs perfectly with gravity. Our disc has a procedural trail in `combat_fx` but it doesn't visually communicate the parabolic path the way an arrow trail does. Worth revisiting now that R32.18 added scope zoom — players will see projectile arcs at distance.
- **Weapon-bob cadence is everything** — Notice the bow gently bobs in idle, draws back smoothly on aim, and holds tense during charge. Our R32.15 viewmodel sway is good, but it lacks the "weapon as an instrument" idle posture.
- **Map design as kill-corridor architecture** — The "narrow" in Narrow One refers to the long sightlines that funnel combat. Their maps are intentionally tube-shaped. Worth studying for any future CTF map we build.
- **Squad-up / persistent lobby** — Friends list, party invite, recent-played-with. Pure JS networking, no C++ side.

### 3. PolyTrack — [poly-track.one/](https://poly-track.one/)

Low-poly racing with a built-in track editor and community track sharing. Probably the most polished low-poly aesthetic on the Three.js scene.

**Why it matters for us:**

- **Editor-as-first-class-mode** — PolyTrack ships with a UI for placing track pieces. We have map-load logic; we could add an in-browser placement UI for buildings and flags. Even a minimal version would be a huge differentiator.
- **Ghost replay overlay** — Translucent past-runs you can race against. We already have a replay system (`watchReplayFromFile`); making it overlay the live game as a ghost would be a small extension.
- **Custom-content URL sharing** — Tracks share via shortlink. Same pattern would work for our maps once we have an editor.
- **Tilt-shift / miniature look** — PolyTrack uses a vertical depth-blur gradient on distant terrain that makes the world look like a tabletop diorama. Pure post-FX, no geometry change. See "Visual Cohesion #5" below.

### 4. Cube Slam — [cubeslam.com](https://www.cubeslam.com/) (still up, archive of the original Google experiment)

Google's 2013 demo of a 3D Pong-like game that runs entirely in the browser, including peer-to-peer multiplayer over WebRTC.

**Why it matters for us:**

- **WebRTC peer-to-peer multiplayer is real and runs in 100 lines** — If the appetite for non-authoritative co-op multiplayer ever comes back, this is the reference architecture: SDP exchange via a tiny signaling server (or even a copy-paste link), then game state flows over `RTCDataChannel`. Skipped tonight per your direction; logging here for the future.

### 5. PolyToria's Polytrack-likes & Crossy Road port — [crossy-road.com](https://www.crossy-road.com/) (third-party Three.js fan port)

**Why it matters for us:**

- **Mobile-first input layer** — Touch controls that don't feel ported. We don't currently have mobile input wired; for casual reach this is huge. Three.js has built-in `Touch` events and there are pre-baked twin-stick libraries (`nipplejs`).

### 6. Stein.world — [stein.world/](https://stein.world/)

A persistent multiplayer 3D MMORPG written in Three.js. Notable for running thousands of concurrent users in a browser.

**Why it matters for us:**

- **Server-authoritative architecture diagram** — They published their architecture; valuable reference if/when we want a real multiplayer.
- **Inventory + economy UIs done well in DOM** — Their inventory is HTML/CSS overlaid on the WebGL canvas. We do the same for HUD; we should look at how they style item slots and tooltips for the brass-Tribes aesthetic.

### 7. Quake.js — [github.com/inolen/quakejs](https://github.com/inolen/quakejs)

Quake III Arena ported to JavaScript via emscripten — *exactly the same architectural pattern as us*. Worth periodically diffing against to see how they solved problems we're hitting.

**Why it matters for us:**

- **Emscripten-built game architecture reference** — They took id Tech 3 (similar vintage to Tribes' engine), wrapped it in emscripten, did the JS-side renderer + audio + UI, and shipped it. Their solutions to problems like virtual filesystem, WebSocket-as-UDP, and server browsing are all documented in their wiki.

### 8. Gorescript — [gorescript.com](http://gorescript.com/)

A 1990s-era doom-style FPS built on Three.js. Open-source, MIT-licensed. Levels load from JSON.

**Why it matters for us:**

- **Their JSON map format is the same idea as our `loadMap` system** — Worth diffing to see what features they support that we don't (triggers, scripted events, secrets).
- **Pure-canvas pixel-art HUD over WebGL** — Beautiful integration. Their ammo counter is an actual sprite-strip animation drawn into a hidden 2D canvas and then composited. Worth borrowing for retro HUD effects.

### 9. Bruno Simon's portfolio — [bruno-simon.com](https://bruno-simon.com/)

Not a "game" but the de-facto Three.js showpiece — a drivable car that explores a portfolio. The author teaches the [Three.js Journey](https://threejs-journey.com/) course.

**Why it matters for us:**

- **Best in class for "the world reacts to you"** — Click anywhere and physics objects scatter. Honking horn changes nearby objects. Tiny details that make the world feel alive. Most of these are 5-line additions to a polish module.
- **Cannon.js / Rapier integration patterns** — If we ever wanted JS-side physics for ragdolls / debris (separate from the C++ physics for player movement), Bruno's site has the reference implementation.

### 10. Tiny Glade — Painterly Three.js Study — [Instagram demo](https://www.instagram.com/reel/C80OluGoqNx/)

Not a finished game, but a notable Three.js *visual study* by Daniel Velazquez recreating the painterly look of the indie hit Tiny Glade. Runs at 120 FPS with custom shaders. He published the technique breakdown.

**Why it matters for us:**

- **Painterly post-processing recipe** — Kuwahara filter for brush-stroke abstraction + curl-noise on grass + warm/cool LUT. Total ~3 KB of GLSL, total transformative effect on the look. We could add this as a `?style=painterly` toggle without changing any geometry.

---

## Part 2 — Visual Consistency Playbook for Three.js

A game looks "of a piece" when many small choices reinforce the same aesthetic decisions. Below is a concrete checklist with patterns and example links.

### 2.1 Pick a single shader paradigm — and don't mix

**The problem:** PBR (`MeshStandardMaterial`) and stylized (`MeshToonMaterial`, custom shaders) make scenes look broken when used side-by-side, because PBR objects are lit by environment maps while toon objects only respond to direct lights. The two camps will never agree on shadows, reflections, or specular highlights.

**The rule:** Pick PBR-realism *or* stylized — never both.

**For us:** We have `MeshStandardMaterial` (PBR) on most of the world and a custom faceted shader on terrain. They don't line up. Either:
- (a) Convert all materials to `MeshToonMaterial` with a 4-band gradient ramp (simple, dramatic visual change) — see [Three.js MeshToonMaterial docs](https://threejs.org/docs/?q=toon#api/en/materials/MeshToonMaterial)
- (b) Convert terrain to PBR with a proper splatmap (more work, more "realistic" but less distinctive).

I recommend (a) — Tribes was always a stylized game.

### 2.2 One environment map for everything

**The problem:** PBR materials rely on `envMap` for ambient light. If only some materials have it, the ones that don't will look unnaturally dark.

**The rule:** Set `scene.environment` once. Don't override per-material unless you have a specific reason.

**For us:** Already done in `R30.2` with the PMREM-generated env from the sky shader. Just keep new materials inheriting it (don't pass `envMap: null`).

### 2.3 Locked color palette

**The problem:** Random hex codes accumulating across the codebase. Every new feature picks a slightly different green for "team friendly" or "objective marker."

**The rule:** Define a palette object once and reference it everywhere.

```javascript
const PALETTE = {
    teamRed:   '#E84A4A',
    teamBlue:  '#4A8AE8',
    objective: '#D4A030',  // brass — used for all interactive objects
    danger:    '#FF3030',
    safe:      '#48D870',
    bg:        '#0A0E14',
    fg:        '#E8DCB8',
    accent:    '#FFC850',  // gold/amber — used for HUD highlight only
};
```

Then every UI element, every dot on the command map, every reticle hue references this. Three.js example: [discoverthreejs.com palette](https://discoverthreejs.com/book/first-steps/transformations/) — they use a constant `colors` object across their book.

**For us:** I've already started this implicitly with the brass/amber HUD theme. Should formalize it into one constant in `index.html` and refactor command-map / zoom / combat-fx to read from it.

### 2.4 Fog as the great unifier

**The problem:** Every scene with too much detail at distance feels "busy" and pulls focus.

**The rule:** Always have fog. Even in clear weather, atmospheric perspective tints distant objects toward the sky color. This is what makes them feel "in the same world."

```javascript
scene.fog = new THREE.Fog(skyHorizonColor, near=80, far=600);
// match the exposure / tone-mapping so fog reads correctly
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.0;
```

**For us:** We have a fog setup but should verify (a) it matches the sky color, (b) the toneMapping is ACES (modern film-look standard), (c) the exposure is locked at 1.0. See [discoverthreejs.com fog](https://discoverthreejs.com/book/first-steps/lights-color-action/).

### 2.5 Tilt-shift / depth haze for "this is one world"

**The problem:** Distant geometry can read as separate from foreground.

**The rule:** Apply a subtle depth-of-field with the focal point at mid-distance. Foreground and far-distance both blur slightly. Reads as cinematic.

```javascript
// using postprocessing library
const dofPass = new BokehPass(scene, camera, {
    focus: 50.0,
    aperture: 0.0001,  // very subtle
    maxblur: 0.005,
});
composer.addPass(dofPass);
```

[postprocessing library](https://github.com/pmndrs/postprocessing) is the standard. PolyTrack uses a vertical-gradient blur instead of a real DOF for the tabletop look — `[poly-track.one](https://poly-track.one/)`.

### 2.6 Color grading via 3D LUT

**The problem:** Even with everything else right, a scene can feel "video-gamey" — too saturated, too neutral.

**The rule:** Apply a final 3D LUT (look-up table) as the last post-FX pass. A LUT is a small `.cube` file (or PNG strip) that maps every input color to an output color, giving you the look of film stock. One LUT can take an entire game from "Unity preset" to "thematically owned."

```javascript
import { LUTPass } from 'three/addons/postprocessing/LUTPass.js';
const lutPass = new LUTPass({ lut: lutTexture });
composer.addPass(lutPass);
```

For Tribes: a slightly desaturated, cool-shadow / warm-highlight LUT (a "modern war film" grade) would lock in the aesthetic. Free LUTs at [lutify.me/free-luts](https://lutify.me/free-luts/) or generate a custom one in DaVinci Resolve in 5 minutes.

[Three.js docs LUT example](https://threejs.org/examples/#webgl_postprocessing_3dlut)

### 2.7 Bloom selectively, not globally

**The problem:** `UnrealBloomPass` over the whole scene makes everything glow. Looks cheap.

**The rule:** Use [`SelectiveBloom`](https://threejs.org/examples/#webgl_postprocessing_unreal_bloom_selective) so only emissive materials bloom — weapon muzzles, neon signs, magic effects, jet flames. The rest of the scene stays grounded.

**For us:** Worth a pass to tag jet thrust, weapon muzzle flashes, and turret indicators as `material.emissive` properly so a selective bloom can pick them out, instead of the current global bloom in the polish module.

### 2.8 Fonts as identity

**The problem:** Default browser fonts (`Arial`, `sans-serif`) leak the "demo" feeling.

**The rule:** Two fonts max. One distinctive display font for headers/titles, one clean monospace for HUD numbers. Bake them into a `<style>` block with `@font-face` so they don't FOUT.

**For us:** We use Courier New for HUD numbers (good — it's free everywhere). Display font is a generic sans. Going to Courier+Inter or Courier+Rajdhani would be a 5-minute change. [Google Fonts: Rajdhani](https://fonts.google.com/specimen/Rajdhani) is free, military/sci-fi, perfect for Tribes-era.

### 2.9 Audio mood layer

**The problem:** Visuals alone can't carry consistency — silence between events feels like a tech demo.

**The rule:** A continuous low-volume ambient bed (wind, distant industrial hum, faint music drone) at -25 dB, always on. Players never consciously hear it but its absence is jarring.

**For us:** We have `AE` (audio engine) but no continuous ambient bed. Generating a 30-second loopable wind-and-drone layer in `synth_sfx.py` and looping it at low gain would do it.

### 2.10 Camera as cinematographer

**The problem:** Static camera angles are video-gamey.

**The rule:** Tiny constant camera motion — 0.5° breathing, slight roll on movement, easing on aim — makes the shot feel "held by a person." We added some of this in R32.15 (viewmodel sway) but not the camera itself.

**For us:** Polish module could apply a tiny `camera.position.add(noise * 0.02)` per frame for a sub-perceptual shake. It's the difference between "tech demo" and "shipping game."

### 2.11 The "one accent color" rule

**The problem:** UIs with five accent colors feel chaotic.

**The rule:** Pick exactly one accent color. For Tribes, it's the brass amber `#FFC850`. Every interactable, every important number, every callout uses *only* this color for highlight. Everything else is grayscale or team color.

**For us:** Mostly already done (HUD is amber-on-dark) but the command map uses a different yellow for objectives. Should reconcile to one hex.

### 2.12 Vignette + film grain

**The problem:** Modern WebGL output is mathematically perfect — and that's the problem. Real footage has lens vignetting and film grain.

**The rule:** Subtle vignette (15% darkening at corners) + low-amplitude noise grain (1-2% per pixel, 30 FPS animated) bakes in a "shot, not rendered" feel.

```glsl
// fragment shader, post-FX
vec2 uv = vUv;
float vig = smoothstep(0.7, 0.3, length(uv - 0.5));
color.rgb *= vig;
color.rgb += (random(uv * time) - 0.5) * 0.02;
```

[postprocessing FilmPass](https://github.com/pmndrs/postprocessing/blob/main/src/passes/FilmPass.js)

**For us:** We have a critical-HP vignette but no always-on cinematic one. A constant ~15% vignette would be a single line of CSS or a single pass.

### 2.13 Reference: Discover three.js (the book)

For everything above, the best free reference is [Discover three.js](https://discoverthreejs.com/) by Lewy Blue. Specifically the chapters on:

- [Lights & Color & Action](https://discoverthreejs.com/book/first-steps/lights-color-action/)
- [Ambient Lighting](https://discoverthreejs.com/book/first-steps/ambient-lighting/)
- [Animation](https://discoverthreejs.com/book/first-steps/animation-system/)

For paid: [Three.js Journey](https://threejs-journey.com/) by Bruno Simon ($95). Covers shaders, post-FX, and case studies. Probably the most-recommended Three.js resource on the planet.

---

## Recommendations Ranked by Impact-per-Effort for Us

If you want to pick one or two things from this report to actually do:

**Tier 1 (high impact, half-day each):**
1. **Lock the palette** — Define `PALETTE` constant, refactor 5 files to read from it. Pure cleanup, transformative for cohesion.
2. **3D LUT post-FX pass** — Single shader pass, single LUT texture, locks the aesthetic identity. Most under-used technique on the entire Three.js scene.
3. **Day/night cycle** — One uniform driving sky color, sun position, fog density, exposure. Slow Roads-style.

**Tier 2 (high impact, 1-2 days each):**
4. **Convert all materials to MeshToonMaterial** — Massive style commitment but locks coherence completely. Risky for retro look.
5. **Weather presets module** — Wraps fog/particles/audio/post-FX into named states.
6. **Selective bloom on emissives** — Tag jet, muzzle, turret indicator as emissive; switch global bloom to selective.

**Tier 3 (lower priority):**
7. Mobile touch input via nipplejs
8. Ghost-replay overlay
9. Custom font pair (Rajdhani + Courier)

My single highest-leverage recommendation: **#2 (3D LUT)**. It's one pass, one texture, transforms the entire output, costs nothing in performance.

---

*End of research deliverable. Ready to act on any of the above on request.*
