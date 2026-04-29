# Phase 6 — Refinement / Design Pass (Run 1)

**Scope:** Full codebase design coherence review
**Date:** 2026-04-29
**Panel:** Ive (lead), Carmack, Muratori, ryg

---

## 1. Opening: The 30-Second Architecture Test

**Ive:** Before we debate specifics, I want to run an exercise. Imagine you're a fresh AI session — or a new contributor — and you see the file listing for the first time. No documentation. Just file names. Tell me what you understand about the architecture in thirty seconds.

**Carmack:** Alright. I see `renderer.js` and fifteen `renderer_*.js` files. That tells me there's a core renderer and satellite modules. Then `tribes.js` — I'd assume that's the main game logic. Then a `client/` folder with eleven files covering networking, audio, settings, map editor. The hierarchy isn't terrible. The renderer stuff is clearly labeled.

**Muratori:** Hard disagree. What's the *relationship* between `renderer.js` and `renderer_polish.js`? Does polish run after the main pass? Is it a separate pipeline? Is it additive? The name tells me nothing about data flow. And `tribes.js` — that's the most misleading file in the entire project. It's 6,868 lines of auto-generated Emscripten WASM glue. Not a single line of hand-written game logic. A fresh reader would spend twenty minutes reading that file before realizing it's machine output.

**ryg:** The renderer files are the worst offender for me. Fifteen satellite files with no visible hierarchy. In a real engine, you'd see the pipeline stages in the names — `renderer_gbuffer.js`, `renderer_lighting.js`, `renderer_post.js`. Instead I see `renderer_polish.js`, `renderer_cohesion.js`, `renderer_toonify.js`. These are vibes, not pipeline stages. I can't reconstruct the render order from the names.

**Ive:** That's the test result, then. A fresh session cannot understand this architecture from the file list. The names communicate *intent* rather than *function*. That's backwards for engine code. Intent belongs in comments. Function belongs in names.

**Carmack:** I'd push back slightly. The codebase is 26 files and 13,000 lines. This isn't Unreal Engine. A competent developer reads the entry point, traces the initialization, and understands the architecture in an hour. The naming is imperfect, but the scale doesn't demand the kind of taxonomic precision you'd want in a 500-file project.

**Muratori:** That argument applies to the *current* team. One developer plus an AI partner. But the audit exists because the codebase is growing. And naming debt compounds. Every new `renderer_*.js` file makes the existing naming scheme harder to fix. If you're going to rename, now is cheap. In six months it's expensive.

**Ive:** Casey's right. The question isn't whether *Levi* can navigate this. He wrote it. The question is whether the *names themselves* carry meaning. Let's move to specifics.

---

## 2. Module Decomposition

**Ive:** Let's start with the elephant: `renderer.js` at 6,094 lines. That's 47% of all hand-written code in the project. It contains — by our count — fifteen distinct subsystems. Terrain, buildings, interior shapes, players, projectiles, flags, six particle systems, weather, day/night, post-processing, camera, weapon viewmodel, quality tiers, map loading, grass, dust. My question is simple: is this one module or fifteen?

**Carmack:** It's both, and that's fine for now. Look — I've shipped engines where the renderer was a single file longer than this. The key question is whether the subsystems inside `renderer.js` have clean boundaries *within* the file. If terrain rendering starts at line 800 and ends at line 1,200 and doesn't reach into the particle code, then the monolith is a organizational choice, not a structural problem. The data all flows through the same WebGL context. There's a natural gravity pulling these systems together.

**Muratori:** Except they *don't* have clean boundaries. Six particle systems with duplicated patterns — that means six copies of roughly the same init/update/render loop with different parameters. That's not a module boundary problem, that's a data-driven-vs-hardcoded problem. You should have one particle system with six configurations, not six particle systems with one pattern each.

**ryg:** I want to zoom in on the GPU side. Each of those fifteen subsystems presumably sets up its own shader, its own vertex format, its own draw calls. In a 6,094-line file, how do you reason about the draw call budget? How do you know which subsystem is eating your frame time? The monolith makes profiling harder because the boundaries between "terrain draw" and "building draw" and "particle draw" are lexical, not structural. You can't instrument at the module boundary because there is no module boundary.

**Ive:** John, you said "fine for now." When does it stop being fine?

**Carmack:** When you can't hold the whole file in your head. For a single developer, that's around 8,000 lines if the code is well-structured. At 6,094 with fifteen subsystems, you're close. The risk isn't today — it's the next three features. Each one adds 200-400 lines. By the time you notice the file is unmanageable, the extraction cost has doubled.

**Muratori:** I'd put the threshold lower. It's not about holding the file in your head — it's about holding the *interactions* between subsystems. Fifteen subsystems means 105 potential pairwise interactions. Even if most are zero, the ones that aren't are where your bugs live. Weather affects particles. Day/night affects post-processing. Camera affects everything. Those coupling points are invisible in a flat file.

**Ive:** Now let's look at the satellite modules. `renderer_polish.js` — 1,146 lines. Five or more unrelated systems: weather effects, combat feedback, building detail, HUD elements, visual atmosphere. The name suggests this is optional flourish. But combat feedback — screen shake on hit — is that really "polish"? If I get shot and the screen doesn't react, I'd call that a bug, not a missing polish pass.

**ryg:** The naming reveals a design philosophy problem. "Polish" implies these systems were added after the core was done. Tacked on. But weather, combat feedback, HUD — these are *pipeline stages*. They should be named for what they do in the pipeline, not when they were written.

**Carmack:** I'll defend the pragmatic view: `renderer_polish.js` was probably created as "stuff I'm adding to make it look better" and it grew. That's normal development. The question is whether to refactor it now or keep shipping. My answer: rename it, but don't reorganize it yet. The internal structure matters more than the filename.

**Muratori:** Rename it to what? That's the problem. It's five unrelated systems. There's no single name that covers weather FX, combat shake, building details, HUD compass, lens flare, and decals. The correct action is to break it up, not to find a more creative umbrella name.

**Ive:** And then there's `renderer_cohesion.js`. 138 lines. Camera breathing and mood bed audio. Already flagged dead in Phase 4. This one's straightforward — it doesn't belong, and everyone agrees. But I want to understand *how* it got here. What design process produced a file called "cohesion" that contains camera breathing?

**Carmack:** It was probably an experiment. "What if the camera breathes and there's ambient audio that shifts with mood? That would make the world feel more *cohesive*." The name described the goal, not the implementation. It didn't work, it got abandoned, nobody deleted it.

**Muratori:** Which brings us to a process point: there's no mechanism for killing experiments. Code gets written, it gets disabled, it stays forever. The disabled rain system still calls update every frame. The grass ring allocated 213MB of GPU memory before it was disabled. Dead code isn't free — it has a cognitive cost even when it doesn't execute.

---

## 3. Naming Review

**Ive:** Let's go file by file. I want a verdict on every name: keep, rename, or kill.

**Ive:** `renderer_polish.js` — 1,146 lines. Weather FX, combat feedback, building detail, HUD, lens flare, decals. Name verdict?

**ryg:** Kill the name. "Polish" is a phase of development, not a module responsibility. If I see `renderer_polish.js` in a file listing, I expect optional visual enhancements I can disable for performance. But combat feedback isn't optional. And HUD elements aren't "polish" — they're core UI.

**Muratori:** Split it. `renderer_weather.js` for weather. `renderer_hud.js` for compass and telemetry. Combat shake goes back into the main renderer or into an effects module. Lens flare and decals — those *are* polish, actually. Keep them together as `renderer_vfx.js` or something.

**Carmack:** I'd do two files, not four. `renderer_environment.js` for weather, atmosphere, lens flare. `renderer_feedback.js` for combat shake, HUD, decals. The split should follow the *update frequency* — environment updates once per frame at scene level, feedback updates per-event at player level.

**Ive:** I like John's framing. Split by update cadence, not by visual category. Next — `renderer_cohesion.js`.

**Everyone:** Kill.

**Ive:** `renderer_toonify.js`. Toon shader toggle. Name?

**ryg:** "Toonify" is cute but imprecise. It's a material post-process — specifically, it's quantizing the color ramp and adding edge detection. The name should describe the technique or the pipeline stage, not the aesthetic goal. `renderer_stylize.js` if you want to be general. `renderer_postmaterial.js` if you want to be precise.

**Carmack:** I'd keep `toonify`. Everyone on the team knows what it does. Renaming it to `renderer_stylize.js` adds no information — it's *less* descriptive because "stylize" could mean anything. "Toonify" tells you exactly what aesthetic it produces.

**Muratori:** The deeper question is whether the module should exist at all, which we'll get to. But on naming — John's right that `toonify` is unambiguous. The problem isn't the name, it's whether the *thing* should ship.

**Ive:** `renderer_command_map.js` versus `renderer_minimap.js`. Are these names clear enough?

**ryg:** What's the difference between a command map and a minimap?

**Carmack:** Command map is the full tactical overlay — the one you pull up to see the whole battlefield. Minimap is the corner HUD element. Different scales, different render targets, different interactions. The names are fine if you know the game design. They're opaque if you don't.

**Muratori:** That's the test. If the name requires domain knowledge to parse, it fails the 30-second architecture test. `renderer_tactical_overlay.js` and `renderer_minimap.js` would be self-documenting. "Command map" is a Tribes-specific term.

**Ive:** Agreed. Rename `renderer_command_map.js` to something a non-Tribes-player would understand. Now — `client/tiers.js`. 46 lines. What is this?

**Carmack:** It's a skill rating system. Player skill tiers. Completely unrelated to quality tiers in the renderer.

**ryg:** That's a naming collision waiting to happen. When someone searches for "tiers" to debug quality tier fallback, they'll find this file first and waste five minutes. Rename to `client/skill_rating.js` or `client/player_ranks.js`.

**Muratori:** 46 lines. At that size, does it need to be its own file? Could it be a section in whatever module handles player stats?

**Carmack:** Separate files are fine at any size if they represent a distinct concern. Skill rating *is* distinct from player stats. Keep it separate, rename it.

**Ive:** `client/quant.js`. 40 lines. Quantization helpers.

**Muratori:** "Quant" is engineer shorthand. Nobody outside of signal processing or machine learning sees "quant" and thinks "quantization." Rename to `client/quantize.js` at minimum, or `client/net_quantize.js` if it's specifically for network compression.

**ryg:** Agree. Three extra characters eliminate all ambiguity.

**Ive:** And the big one. `tribes.js` — 6,868 lines. Auto-generated Emscripten WASM glue.

**Carmack:** This is genuinely misleading. If I see `tribes.js` as the largest file in a project called Firewolf — previously Tribes-inspired — I assume it's the core game logic. It's not. It's machine-generated boilerplate. Rename to `wasm_glue.js` or `emscripten_runtime.js`. Mark it as generated. Add it to `.gitattributes` so diffs are suppressed.

**Muratori:** Or better: move it to a `generated/` directory. Don't put machine output next to hand-written code. The cognitive load of ignoring it while browsing the file tree is nonzero.

**ryg:** Strongly agree. This is the single highest-impact naming fix in the entire codebase. It eliminates 6,868 lines of confusion.

**Ive:** Unanimous. Rename and relocate `tribes.js`.

---

## 4. The "Should This Exist?" Audit

**Ive:** Now for the hard conversation. I want to apply a simple test to every module: *if you can't articulate what sensation this module creates for the player, it's noise.* Let's go through the candidates.

**Ive:** `renderer_cohesion.js`. Camera breathing and mood bed audio. 138 lines. Dead code.

**Carmack:** Confirmed kill. Phase 4 flagged it. No player ever experienced it. Delete it in the next commit.

**Muratori:** The concept behind it — world mood — isn't wrong. But the implementation was an experiment that never reached playable state. If someone wants mood audio later, they'll write it fresh. Dead code doesn't serve as a "template" — it serves as a trap.

**Ive:** Killed. `renderer_toonify.js`. Toon shader toggle. Does toon shading serve the visual identity?

**ryg:** Let me frame this from the GPU pipeline perspective. The toon shader adds a post-process pass that quantizes color ramps and adds edge detection. That's an extra full-screen pass. On low-end hardware — which this project explicitly targets — that's not free. The question is: does the visual output justify the cost?

**Carmack:** The game design doc says "faceted terrain" and "procedural boldness." Toon shading is stylistically aligned with that. It reinforces the low-poly aesthetic by simplifying material gradients. I'd keep it as an *option*, but not default-on for all quality tiers.

**Muratori:** What does it actually look like? Has anyone played with it on versus off and preferred it? "Stylistically aligned" isn't the same as "players notice and care." If nobody's tested it in gameplay, it's a hypothesis, not a feature.

**Ive:** That's Gate 8 — play with it on, play with it off. If you don't miss it, it doesn't ship. Has that test been run?

**Carmack:** I don't think so. The module exists, it works, but I don't see evidence of a design evaluation. Keep the code, but don't ship it until Gate 8 is passed. Mark it experimental.

**ryg:** And if it does ship, it needs quality-tier awareness. Full-screen post-process on the lowest tier is a non-starter.

**Ive:** Verdict: keep as experimental, require Gate 8 before shipping. Now — `renderer_debug_panel.js`.

**Muratori:** Dev tool. Not player-facing. It should exist, but it should be excluded from production builds. Is it?

**Carmack:** In a web build, "excluded from production" means either tree-shaking or a build step that strips it. If there's no build step — which I suspect there isn't for a project at this stage — then it ships to every player. That's 200+ lines of debug UI code in the production bundle.

**ryg:** The debug panel also likely exposes internal state through the DOM. Shader names, draw call counts, buffer sizes. If any of that is visible in production, it's an information leak.

**Ive:** Flag for build-step exclusion when a build pipeline exists. For now, ensure it's behind a dev flag that isn't trivially discoverable. Next — the disabled systems in `renderer.js`.

**Ive:** Rain system. Disabled, but update called every frame.

**Carmack:** That's a measurable cost for zero player value. If the rain system isn't ready, gate it completely. Don't call update on a disabled system. The cost might be small — maybe a few microseconds — but it's the principle. Disabled means *disabled*, not *running invisibly*.

**Muratori:** This is exactly the "experiments never die" problem I mentioned. Someone wrote rain, it wasn't ready, they set `enabled = false`, and the update loop kept running because nobody verified that disabling actually skips the work. Guaranteed there's a conditional at the top of the update that returns early, but the function call, the branch, and any setup before the check still execute.

**ryg:** In a frame budget of 16.6ms at 60fps, microseconds matter when you have six particle systems, weather, post-processing, and a 6,094-line renderer all competing. It's not that rain is expensive. It's that fifteen "cheap" things that shouldn't run at all add up to something measurable.

**Ive:** Grass ring. 2.8 million instances. 213MB GPU memory. Disabled.

**Carmack:** 213MB of GPU memory for grass that isn't rendered. That's the most expensive disabled feature I've ever seen. Is the memory allocated at startup regardless of whether grass is enabled?

**ryg:** If it's using instanced rendering — which at 2.8 million instances it must be — then the instance buffer is allocated when the system initializes. If initialization runs unconditionally, yes, you're burning 213MB on startup for a feature nobody sees.

**Muratori:** Kill the allocation. Keep the code if you want, but wrap the entire initialization in the enable check. 213MB is the difference between running on a 512MB integrated GPU and not. For a project that targets "any hardware," this is directly contradicting a design goal.

**Ive:** Dust layer. Also disabled.

**Carmack:** Same pattern. Disable means don't initialize, don't allocate, don't update. If the feature isn't shipping, it should be as close to not-existing as possible without deleting the code.

**Ive:** Jet exhaust. This one's interesting because it was supposedly the canonical particle system.

**ryg:** Jet exhaust is the one that works and was used as the reference implementation. The issue isn't whether it should exist — it should. The issue is that five other particle systems were built *alongside* it instead of *on top of* it. The canonical implementation should be a shared base, not a pattern to copy-paste.

**Muratori:** That's the architectural miss. You have one good particle system and five copies of it with different parameters. The fix isn't to delete anything — it's to extract the common pattern into a single parameterized system and have each effect be a configuration, not a codebase.

---

## 5. Core Feelings Alignment

**Ive:** The game design document defines four Core Feelings. I want to map every module to at least one, and flag anything that maps to none. Let me state them:

- **Belonging** — my tribe needs me, I need my tribe
- **Adaptation** — the game is changing, I need to respond
- **Scale** — vast world, moving through it at speed
- **Aliveness** — the world breathes, shifts, glows

**Ive:** Let's go system by system. Terrain rendering.

**Carmack:** Scale. Clearly. The faceted terrain *is* the world. It communicates vastness through geometric simplicity — you can see far because the poly count stays manageable. Core system, core feeling. No debate.

**Ive:** Buildings and interior shapes.

**Muratori:** Belonging and Adaptation. Buildings are where tribes congregate. Interiors create the spaces where you feel *inside* your territory. But also Adaptation — buildings can be contested, controlled, lost. The physical space is the battleground for tribal ownership.

**Ive:** Players and projectiles.

**ryg:** All four, arguably. Players are Belonging (your tribe visually distinct), Adaptation (enemies approaching, responding), Scale (seeing players at distance), Aliveness (motion, physics). Projectiles are Adaptation pure — incoming fire demands response.

**Ive:** The six particle systems. Collectively.

**Carmack:** Aliveness, primarily. Jet exhaust, weapon impacts, environmental effects — they make the world feel physical. But only if they're *good*. Bad particles — or too many competing systems — create visual noise that *reduces* Aliveness. It becomes chaos, not breathing.

**Muratori:** And right now, with six separate implementations, the visual coherence between them is uncertain. Do they use the same blending modes? Same size curves? Same opacity falloff? If each was built independently, they probably *look* independent, which breaks the "the world breathes" feeling. It should feel like one world with one physics, not six bolt-on effect libraries.

**Ive:** Weather and day/night.

**ryg:** Aliveness. This is the quintessential "world breathes" system. Time passes, light changes, weather moves. But — the rain system is disabled. Day/night presumably works. So you have half the Aliveness subsystem active. That's a coherence problem.

**Ive:** Now the harder ones. `renderer_toonify.js`. What Core Feeling does toon shading serve?

**Carmack:** Visual identity, which isn't a Core Feeling — it's a design constraint. Toon shading serves the *aesthetic*, not the *experience*. That doesn't mean it's wrong, but it means it lives in a different category. It's about brand, not about player emotion.

**Muratori:** I'd argue it *could* serve Scale. Simplified shading makes distant objects more readable, which reinforces the feeling of vastness. But that's a stretch, and it depends entirely on the implementation. If the toon shader just makes things look flat up close without improving distance readability, it's not serving Scale either.

**Ive:** `renderer_polish.js` — the weather effects and combat feedback components.

**ryg:** Combat feedback — screen shake, hit flash — serves Adaptation. You got hit, the world tells you. That's critical. Lens flare and atmosphere serve Aliveness. The HUD compass serves Scale — orientation in a vast world. So the systems inside `renderer_polish.js` serve three different Core Feelings, which is another argument for splitting it.

**Ive:** The 256-decal system.

**Muratori:** What Core Feeling do decals serve? Scorch marks on the ground? That's Aliveness — the world records what happened. But 256 decals is a budget question. How many are visible at once? If the answer is "usually 5-10 but we support 256 because the buffer is pre-allocated," that's fine engineering. If the answer is "we render 256 decals every frame," that's a performance problem masquerading as a feature.

**Carmack:** Decals serve Aliveness at low count, but they serve *nothing* at high count because the player can't perceive 256 individual marks. Past about 30-40 visible decals, they become texture noise. The budget should be capped at perceptual relevance, not GPU capacity.

**Ive:** `renderer_cohesion.js` — camera breathing.

**Carmack:** Aliveness, if it worked. Camera breathing makes the view feel human, organic. It says "you are a body in this world." But the implementation is dead, so it serves nothing. And honestly — for a fast-paced skiing game, camera breathing could *conflict* with the experience. You're moving at 200 km/h and the camera is... breathing? That could cause nausea.

**Muratori:** This is a case where the concept conflicts with the genre. Aliveness in a tactical shooter means wind in the trees and dust in the air. It doesn't mean your camera subtly bobs while you're trying to hit a target at 300 meters. The concept was wrong for this game, not just unfinished.

**Ive:** The grass ring. 2.8 million instances.

**ryg:** Scale and Aliveness. Dense grass covering the terrain makes the world feel massive and alive. But — 213MB GPU for a feature that's disabled. The concept serves Core Feelings. The implementation doesn't serve the project. This needs to be rebuilt at a budget that's compatible with "any hardware," or it needs to be a top-tier-only feature with aggressive LOD.

**Ive:** So here's what I'm hearing. Every system *can* be mapped to a Core Feeling in theory. But several fail in practice — either because the implementation is dead, the budget is wrong, or the concept conflicts with the game's speed and readability requirements. The question isn't "does this system serve a Core Feeling?" It's "does this system serve a Core Feeling *in this game, at this budget, in its current implementation*?"

**Carmack:** That's the right framing. Kill the ones that fail on implementation. Budget-cap the ones that fail on cost. Reconsider the ones that fail on game fit.

---

## 6. Visual Identity Coherence

**Ive:** The game design document says "procedural boldness," "faceted terrain," and "atmosphere over texture." Meanwhile, Phase 1 introduced PBR textures at R32.70. I want to ask the uncomfortable question: does PBR conflict with the stated visual identity?

**ryg:** Depends on how it's used. PBR is a lighting model — physically-based shading. You can do PBR on flat-shaded faceted geometry and it looks fantastic. The risk is when PBR becomes an excuse for high-resolution texture work. If someone sees "PBR pipeline" and starts authoring 2K normal maps for terrain tiles, that directly conflicts with "procedural boldness."

**Carmack:** PBR done right is just correct light behavior. Metal reflects like metal, dirt scatters like dirt. That's consistent with "atmosphere over texture" because the *lighting* does the work, not the *textures*. The danger is scope creep: PBR pipelines invite PBR-quality content, and PBR-quality content takes time and memory.

**Muratori:** Let me be concrete. If the terrain is faceted — low-poly, geometric — and the buildings have PBR materials with specular maps, you have a visual coherence problem. The world will look like a low-poly terrain with high-fidelity objects sitting on it. Stylistic mismatch. Either everything is stylized or everything is physically accurate. Mixing them requires extreme skill and intention.

**Ive:** So the PBR pipeline isn't wrong, but it needs style constraints. What about the "atmosphere over texture" principle and the 256-decal system?

**ryg:** Decals are literally texture. They're stamps on surfaces. "Atmosphere over texture" says: spend your budget on fog, lighting, weather, particle effects — things that create *mood*. Decals create *detail*. Detail is the opposite of atmosphere in a rendering budget. Every draw call spent on decals is a draw call not spent on volumetric fog or god rays.

**Carmack:** I'd moderate that. Scorch marks from a battle create *narrative atmosphere*. "A fight happened here." That serves the game. But 256 is a lot. Cap it at 32-64 visible, fade aggressively, and the decal system becomes a storytelling tool instead of a rendering burden.

**Ive:** "Readable silhouettes at 300 meters." Currently there's one character model with no armor differentiation. How does that serve Belonging — knowing your tribe from the enemy at distance?

**Muratori:** It doesn't. At 300 meters, a 2-meter character is about 12 pixels tall on a 1080p screen at typical FOV. At that size, geometry detail is invisible. The only things that read are: color, proportions, and *motion*. If all four tribes use the same model, the only differentiator is color. That might be enough for friend-vs-foe, but it doesn't serve Belonging. I should *feel* different playing as a heavy versus a light. I should *see* the difference at distance.

**ryg:** This is actually a place where the toon shader could help. Hard edges on silhouettes make small characters more readable. If the toon post-process adds edge detection and the edges are tribe-colored, you get readable silhouettes for free at all distances. That would be a concrete argument for shipping `renderer_toonify.js`.

**Carmack:** That's a smart connection. The toon shader might not serve a Core Feeling directly, but it *enables* Belonging at distance by improving silhouette readability. If that hypothesis tests well, it earns its place in the pipeline.

**Ive:** So we have a potential answer to the toonify question: it ships *if and only if* it measurably improves silhouette readability at distance. That's a testable criterion, not an aesthetic preference.

---

## 7. renderer.js — The Monolith Question

**Ive:** We've been circling this, so let's address it directly. 6,094 lines. Fifteen subsystems. 47% of all hand-written code. What do we do with it?

**Carmack:** I want to push against the reflex to split it. Splitting a monolith into fifteen files creates fifteen files that need to coordinate through imports, shared state, and calling conventions. Right now, all the subsystems share a WebGL context, a camera matrix, a time uniform, a quality tier. If they're in one file, sharing is trivial — it's just variable access. Split them out, and you need to pass those shared values explicitly or create a shared context object.

**Muratori:** But the alternative is a 6,000-line file that grows by 200 lines with every new feature. At 8,000 lines, John says it becomes unmanageable. That's three features away. The question isn't "should we split" — it's "what's the natural split?"

**ryg:** The natural split follows the render pipeline. Group 1: geometry passes — terrain, buildings, interiors, characters. Group 2: effect passes — particles, weather, post-processing. Group 3: overlay passes — HUD, minimap, debug. Group 4: infrastructure — camera, quality tiers, map loading, resource management. Each group shares a context but has different update frequencies and different GPU pipeline states.

**Carmack:** That's four files plus the infrastructure core. I could live with that. But I want the split to be mechanical, not architectural. Don't redesign the data flow. Just move functions to new files and import them. The renderer's internal architecture can evolve *after* the split reduces cognitive load.

**Muratori:** Agreed on mechanical split. The worst thing you can do is split *and* refactor simultaneously. You lose the ability to verify correctness because too many things changed at once. Move the code, verify it still works identically, *then* improve the individual pieces.

**Ive:** What about the six particle systems? That's a subsystem within the monolith that has its own decomposition problem.

**Carmack:** Extract one parameterized particle system. Define the six effects as data — emission rate, velocity distribution, size curve, color gradient, lifetime, blending mode. The code shrinks from six implementations to one implementation and six configuration objects.

**ryg:** The shader side needs thought. If all six systems use different blend modes or different vertex attributes, "one system" still means multiple draw calls with different pipeline states. But the *CPU-side* logic — spawning, aging, sorting, buffering — that's absolutely shareable. I'd guess 80% of the particle code is identical across all six systems.

**Muratori:** This is the highest-value refactor in the entire codebase. Six systems to one. Hundreds of lines removed. Every future particle effect is data, not code. And the visual coherence improves because all particles share the same physics and blending pipeline. It directly serves Aliveness.

**Ive:** So the recommendation is: extract particles first, then split renderer.js along pipeline stages. Particles are the proof-of-concept for the split — if you can extract one subsystem cleanly, the rest follow the same pattern.

---

## 8. The Global Coupling Problem

**Ive:** 83 `window.*` globals. I want to understand what that number means for this project.

**Carmack:** In a single-page web application, `window.*` globals are the equivalent of C-style global variables. 83 means 83 values that any code anywhere can read or modify without going through an API. That's a coupling surface area of 83 × 26 files = 2,158 potential coupling points.

**Muratori:** Let's be more precise. How many of those 83 are actually accessed from multiple files? If 60 of them are written in one file and read in one other file, the coupling is 60 bilateral relationships, not 2,158. Still bad, but tractably bad. If 20 of them are accessed from 10+ files each, *that's* the coupling crisis.

**ryg:** The 8 IIFE modules versus 4 ES modules split is related. IIFEs communicate through globals by nature — they don't have import/export. ES modules communicate through imports. Having both systems means you have two communication patterns coexisting, which makes it impossible to trace data flow with tooling. An import search misses global access, and a global search misses imports.

**Carmack:** The pragmatic path: audit the 83 globals, categorize them. Some are legitimate shared state — the WebGL context, the current time, the camera position. Those should exist, but as named exports from a shared module, not as `window.*`. Some are debug flags. Those should be behind a debug interface. Some are initialization artifacts — values set once at startup and never changed. Those can be module-scoped constants.

**Muratori:** I'd bet at least 20 of those 83 are one of: (a) values that should be function parameters, (b) values that should be module-scoped, or (c) values that are written but never read. The first step is a dead-global analysis — which of the 83 are actually used?

**Ive:** The dual module system — 8 IIFEs and 4 ES modules. Is the path forward to migrate everything to ES modules?

**Carmack:** Eventually, yes. ES modules give you static analysis, tree shaking, and explicit dependency graphs. But migration is tedious and risky — every IIFE-to-ESM conversion changes how the code initializes and what's available when. Do it one file at a time, test thoroughly, don't batch.

**ryg:** The 28 locations of 2-team hardcoding across 12 files are another coupling problem. That's 28 places where adding a third team requires coordinated changes across 12 files. If the game design says four tribes, that's a data model problem, not a constants problem. The number of teams should be defined once and derived everywhere.

**Muratori:** The hardcoding issue is separate from the global coupling but compounds it. If team count is a global (`window.NUM_TEAMS = 2`), at least it's in one place. If it's a literal `2` scattered across 28 locations, it's worse — you can't even search for it reliably because `2` appears in thousands of non-team contexts.

**Ive:** So the coupling problem has three layers: globals for shared state, IIFEs for communication patterns, and hardcoded values for game parameters. Each needs its own remediation strategy.

---

## 9. Convergence: Actionable Recommendations

**Ive:** Let's converge. I want numbered, prioritized recommendations that the team can execute. No vague directives — concrete actions with clear criteria for done.

**1. Kill `renderer_cohesion.js` immediately.** Delete the file, remove all references. 138 lines of confirmed dead code. Zero risk, zero debate. Do it in the next commit.

**2. Rename and relocate `tribes.js`.** Move to `generated/emscripten_glue.js` or equivalent. Add to `.gitattributes` to suppress diffs. This eliminates 6,868 lines of confusion for any new reader. The single highest-impact naming fix.

**3. Stop disabled systems from executing.** Rain update, grass allocation, dust initialization — wrap all disabled system code paths so they truly do nothing. No function calls, no allocations, no branches. The grass ring's 213MB GPU allocation when disabled is the most urgent.

**4. Extract a unified particle system from `renderer.js`.** Consolidate six particle implementations into one parameterized system with six configuration objects. This is the highest-value code reduction, improving both maintainability and visual coherence. Estimate: net reduction of 400-600 lines.

**5. Split `renderer_polish.js` into two files.** `renderer_environment.js` (weather, atmosphere, lens flare) and `renderer_feedback.js` (combat shake, HUD, decals). Split by update cadence — environment is per-frame at scene level, feedback is per-event at player level.

**6. Rename ambiguous files:**
  - `client/tiers.js` → `client/skill_rating.js`
  - `client/quant.js` → `client/net_quantize.js`
  - `renderer_command_map.js` → `renderer_tactical_overlay.js`
  - Consider `renderer_toonify.js` → `renderer_stylize.js` (debated, lower priority)

**7. Audit the 83 `window.*` globals.** Categorize each as: (a) legitimate shared state → move to a shared context module, (b) debug flag → move behind debug interface, (c) initialization constant → make module-scoped, (d) dead → delete. Target: reduce to under 30 true globals.

**8. Gate `renderer_toonify.js` on silhouette readability.** The toon shader ships only if it measurably improves character readability at 300m. Test with it on, test with it off. This is Gate 8 — if you don't miss it, it doesn't ship. If it passes, consider using it specifically for silhouette enhancement tied to tribe identity.

**9. Plan the `renderer.js` monolith split.** Don't execute yet. Design the four-group split: (a) geometry passes, (b) effect passes, (c) overlay passes, (d) infrastructure. Define the shared context interface. Execute after the particle extraction proves the pattern works.

**10. Define a team-count constant.** Replace all 28 instances of hardcoded 2-team logic with a single `TEAM_COUNT` constant or configuration. The game design says four tribes. The codebase says two. Every hardcoded `2` is technical debt against a core design goal.

**11. Migrate IIFEs to ES modules incrementally.** One file per session, test thoroughly. Prioritize files that are most coupled through globals. Don't batch.

**12. Cap the decal system at 48 visible decals.** Fade aggressively beyond 32. The current 256 budget exceeds perceptual relevance and contradicts "atmosphere over texture." Reclaim the draw calls for volumetric effects.

**13. Establish a code-deletion ritual.** Disabled features get 30 days. If they aren't re-enabled and tested within 30 days, they're archived to a branch and deleted from main. Dead code has a cognitive cost that compounds. The rain system, grass ring, and dust layer have all exceeded this threshold.

---

**Ive:** Thirteen actions. The first four are unambiguous — no design judgment required, just engineering. Five through eight require modest design decisions. Nine through thirteen are structural changes that benefit from the monolith split plan being in place first.

**Carmack:** I'd prioritize 3 and 4 above everything except 1. Stopping disabled systems from burning resources is the highest performance-per-effort fix. Particle consolidation is the highest code-quality-per-effort fix. Do those two and the codebase measurably improves before any renaming or splitting happens.

**Muratori:** Agreed, with the caveat that 2 — renaming `tribes.js` — is a five-minute task with permanent benefit. Don't defer it because it's "just renaming." It's the first thing every new session sees.

**ryg:** From the GPU side: 3, 4, and 12 are my priorities. Stop allocating 213MB for disabled grass. Unify particles so the blend states are coherent. Cap decals so the draw budget is predictable. Those three changes make the rendering pipeline honest — what runs is what the player sees, and nothing else.

**Ive:** Then we have our ordering. Execute 1, 2, 3 immediately — they're trivial and unanimous. Execute 4 next — it's the proof-of-concept for renderer.js decomposition. Then 5-8 as a naming and gating pass. Then 9-13 as structural improvements.

**Ive:** One final thought. This codebase was built by one person with extraordinary focus. It works. It runs. The issues we've identified are not failures — they're the natural sediment of rapid development. The goal of this review isn't to criticize. It's to prepare the foundation for what comes next. A codebase that one person can hold in their head needs to become a codebase that *any* reader can understand in thirty seconds. That's the work.

**Carmack:** Agreed. Ship the game. Clean as you go.

**Muratori:** Show me the data flow and I'm happy. Right now I can't see it. Fix that.

**ryg:** Make the pipeline legible. Every draw call should have a name, a budget, and a reason to exist.

**Ive:** Phase 6 complete. Back to you, Levi.
