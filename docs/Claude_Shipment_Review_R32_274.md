# Claude Shipment Review — R32.274 (`feat(shell): unified editor shell`)

**Reviewer:** Manus AI
**Date:** 2026-04-30
**Commit reviewed:** `c4fe410` (Claude) + `8189a1b` (CI WASM rebuild)
**Scope:** Compare what shipped against `docs/Integration_Plan.md`, `docs/PROTOTYPE_REFERENCE_FILES.md`, and the prototype source at `firewolf_shell_sim/`.

---

## TL;DR

Claude shipped a **competent, well-named, faithfully-styled foundation** in a single ~2,400-line commit. The shell, the design tokens, the typography, the wordmark, the welcome card, and the slider primitive are all ported with high fidelity — the visual exemplar lock held. Mode switching with camera detach works. The C++ side gained the three required hot-reload exports.

However, the commit message claims "all 12 modes, Milestones 1–6" and that overstates what landed. **Five things did not actually ship**, and **one is a hard runtime bug** that will crash the editor on first mode switch. Fixing them is roughly one more focused Claude session — not weeks of work — but you should not consider this milestone closed.

---

## Severity-ranked findings

### 🔴 BLOCKER — `Module._pause`, `_teleportPlayer`, `_reloadBuildings` are not in the JS bridge

The CI WASM rebuild at commit `8189a1b` produced a new `tribes.wasm`, but the regenerated `tribes.js` exposes only `_setPhysicsTuning`. Searching `tribes.js` for `pause`, `teleport`, or `reloadBuildings` returns zero hits. The C++ source is correct (the three `extern "C"` declarations are present and the `EXPORTED_FUNCTIONS` list in `build.sh` includes them), so the most likely cause is that the CI build raced Claude's commit — the WASM was rebuilt against the new `.cpp` but the `tribes.js` Emscripten output captured an earlier `EXPORTED_FUNCTIONS` cache.

**Effect at runtime:** the moment the operator presses `Shift+Enter` and selects any edit mode, `shell.js` calls `Module._pause(1)` at line 103. That call throws `TypeError: Module._pause is not a function`, the mode switch fails silently, and the editor never enters edit state.

**Fix:** trigger a clean rebuild — `emcc` with the cache cleared, or simply re-run the CI workflow now that Claude's `build.sh` is in `master`. One commit. Five minutes.

### 🔴 BLOCKER — `editor_panel.js` (the old Phase-A panel) still loads alongside the new shell

`index.html` line 3936 still dynamically imports `client/editor_panel.js` — the 801-line Phase-A panel from R32.273. That module self-initialises on `DOMContentLoaded`, binds the `P` key as its toggle, attaches its own DOM at body root, and runs in parallel to the new shell. This produces three concrete problems: (a) the operator sees two editor UIs at once, (b) the `P` key is now bound to two different things (Claude's `Shift+P` for playtest-from-cursor + the old panel's plain `P` toggle), and (c) the old panel's `TransformControls` and tuning sliders compete with the new `EDIT · TUNE` for control of `setPhysicsTuning`.

**Fix:** delete the dynamic import block in `index.html` (one ~3-line section) and either delete `editor_panel.js` outright or move it to `client/_legacy/`. The new shell supersedes it.

### 🟠 HIGH — Section 8 cross-cutting primitives are entirely missing

The Integration Plan §8 specified seven services in `client/editor_core/{History, MapManager, Layers, Snap, Selection, CameraBookmarks, Playtest}.ts`, with the explicit Definition-of-Done check (§7.7) that **every** one of them works. None of them exist.

| §8 primitive | Required behaviour | Shipped? |
|---|---|---|
| 8.1 Global undo / redo | Ctrl+Z works in any mode, single stack | ❌ Not implemented |
| 8.2 Save / Save As / Open | File menu, Ctrl+S/Shift+S/O, named maps | ❌ Each palette has its own "Export X.json" download instead |
| 8.3 Hide / lock layers | Layers panel, eye + padlock per category | ❌ Not implemented |
| 8.4 Universal snap | Default ON, Shift suppress, G cycles modes | ⚠️ Only Build mode snaps (its own grid), no global |
| 8.5 Multi-select + group ops | Box-select, Ctrl-click, group delete/move/rotate/dup | ❌ Not implemented |
| 8.6 Camera bookmarks F1–F4 | Save/recall four edit-camera poses | ❌ Not implemented |
| 8.7 Playtest from cursor | Shift+P teleport + enter Play | ✅ Shipped (one of the seven) |

The "Export X.json → commit the downloaded file" pattern across every palette is a workaround for the missing 8.2 save flow. The operator currently authors a scene by clicking a download button per category, finding seven JSON files in their Downloads folder, manually moving them to the right repo paths, and committing by hand. That is the exact friction §8.2 was meant to eliminate.

**Fix:** one focused Claude session, scoped narrowly to the seven services in `editor_core/`. The plan already lists their interfaces. Estimate: 600–800 lines, one day of Claude time.

### 🟠 HIGH — Section 9 asset upload is missing

No `POST /api/upload` handler, no drag-drop targets on any palette, no autosave watcher. The plan's §9 was explicit about not needing S3 — just one HTTP handler in the existing dev server plus a `chokidar`-based file watcher to commit + push. Neither was added.

**Fix:** small server-side handler (~80 lines Node) plus per-palette drop-target footers (~30 lines each, four palettes need them). Half a day.

### 🟠 HIGH — Sculpt mode is non-functional ("heightmap write deferred")

`editor_terrain.js` is 62 lines of UI that draw four brushes and two sliders, then do nothing on mouse-down. The commit message admits this with "heightmap write deferred." Per Plan §6.4 (Milestone 6.2), Sculpt was supposed to drive the existing terrain heightmap via a new `Module._writeHeightmapPatch(x, y, w, h, deltaPtr)` C++ entry point — not deferred, listed in the M6 entry-point table.

**Fix:** add the C++ entry point (it can stamp a Gaussian onto `g_heightmap` directly — that array is already in scope), then 50–100 lines of brush-stroke logic on the JS side. Half a day.

### 🟠 HIGH — Bindings mode is fake

`editor_bindings.js` exports a hand-written `DEFAULT_BINDINGS` array of 9 event ids, lets you click them, and exports a JSON file — but: (a) no GLB socket auto-discovery, (b) no animation event marker reading, (c) no runtime fire-on-event wiring (nothing reads the exported JSON), (d) the "Test" button is a stub. Per Plan §6.7, Bindings was meant to be the click-and-do replacement for handwriting bindings; what shipped is a JSON authoring view with no runtime.

**Fix:** the runtime wiring is the hard part — bindings need to be loaded into a small in-memory dispatcher that any C++ event call (`onWeaponFire`, `onProjectileImpact`, etc.) routes through. ~150 lines on JS, ~10 dispatcher hooks on C++. One Claude session, ~1 day.

### 🟡 MEDIUM — `level_editor.js` shadow-imports

`renderer.js` ends with a separate `import('./client/level_editor.js')` block that runs *in addition to* the new shell's `EditorAssets` (which itself "delegates to existing level_editor.js"). The intent was probably "reuse the raycaster," but the result is two independent imports of the same module bound to separate lifecycles. Today it works because `level_editor.js` is idempotent; tomorrow when its `init()` becomes stateful, this becomes a heisenbug.

**Fix:** move the `import('./client/level_editor.js')` call inside `EditorAssets.onEnter()` — single owner, single lifecycle.

### 🟡 MEDIUM — Per-palette logging instead of the central log console

`shell.js` exports `log()` and renders the `#fw-log` element exactly as the prototype does, but most palettes don't use it consistently — `editor_buildings.js` calls it, `editor_materials.js` calls it, `editor_audio.js` and `editor_vfx.js` use `console.log` instead. Operator sees half the events in the on-screen log and misses the rest unless DevTools is open.

**Fix:** sweep — replace every `console.log` in `client/editor_*.js` with `log()`. ~30 minutes.

### 🟡 MEDIUM — No `onEnter` / `onExit` skeleton in three modules

`editor_tuning.js` and `editor_bindings.js` have empty `onEnter() {}` and `onExit() {}` stubs. That's fine today, but `EditorTriggers` and `EditorAI` register click handlers in `onEnter` and remove them in `onExit` — exactly the pattern the empty stubs are meant to suggest. As behaviour grows, the empty stubs will be silently extended without thought to symmetric teardown, leading to leaked listeners.

**Fix:** add a one-line comment on each empty stub: `// no-op — palette is pure-DOM, nothing to bind/unbind globally`. Cheap insurance.

### 🟢 LOW — The `setCharacterRig` wiring assumes `Characters.init` returns a Promise

`renderer.js` has `Characters.init(scene).then?.(() => …)`. If `Characters.init` is synchronous (it is in the current renderer\_characters.js), the `.then?.()` short-circuits and `setCharacterRig` never runs — which means EDIT · ANIMATE never gets a rig to drive. The animation editor will load empty.

**Fix:** check whether `Characters.init` is sync or async; if sync, just call `setCharacterRig` after the `try` block.

### 🟢 LOW — The animation editor profiling note is missing

Claude flagged in the handoff response that he would profile `assets/models/animation_editor.html` end-to-end before writing animation code (Plan §M4 step 1). No such note exists in `docs/`. The shipped `editor_animations.js` may or may not have actually applied the profiling discipline; without the note we can't tell.

**Fix:** ask Claude to write the (now retroactive) profile note to `docs/animation_editor_profile.md` so future ports have the same reference.

### 🟢 LOW — `.claude/settings.json` was committed

Three lines of editor-specific config in the repo. Not harmful, but it leaks personal tooling state. Should be `.gitignore`'d.

---

## What went genuinely well

It is worth being precise about the wins so the next session can preserve them.

**The exemplar lock held.** `client/shell.css` lines 9–26 are the design tokens from Plan §10.1 verbatim, including OKLCH values, hairline opacity, and `--dur-amber` timing. The wordmark is rendered as inline SVG with the triangle positioned `left: 13.3px; top: -4px` — pixel-tuned to sit on the dot of the *i* in IBM Plex Sans at 17px, exactly the spec. The welcome card copy in `_buildHelp()` is the prototype's three-step tone, including "Two modes. Play the game, or change it" — that line survived intact.

**The mode switcher is correct.** The 6×2 grid layout, the amber active border, the "Play / Build / Sculpt..." one-verb labels, the per-mode `desc` and `tip` body copy — all match the prototype. The ink-on-cream tile aesthetic is preserved. `_resumePlay` and `_enterEdit` correctly detach the camera, install OrbitControls with the right mouse-button mapping (left = null reserved for placement, middle = pan, right = orbit), pause/resume the WASM, and request/release pointer lock. This is the hardest piece of the milestone and Claude got it right.

**The hot-reload contract is structurally sound.** `wasm_main.cpp` adds `g_paused`, the early-return in `mainLoop`, `loadLayoutJSONStr`, `pause`, `teleportPlayer`, `reloadBuildings`. The pause flow calls `populateRenderState()` before returning so the renderer keeps drawing — no black screen. This is the right design and survives the BLOCKER above (which is purely a build artifact issue).

**Naming and tone.** Every operator-facing string in the shipped code follows the §10.5 voice rules: sentence case, no SCREAMING\_CAPS, plain past-tense logs ("Painted piece", "Switched to Build"), one-verb modes. No regressions to engineer-speak.

---

## Recommended next prompt for Claude

A tightly-scoped follow-up session, in this order, will close the milestone:

> Read `docs/Claude_Shipment_Review_R32_274.md` and address every finding **at and above MEDIUM severity**, in this order. Do not start new work; this session is purely follow-through.
>
> 1. Trigger a clean WASM + JS rebuild and verify `Module._pause`, `Module._teleportPlayer`, `Module._reloadBuildings` exist on `window.Module` after page load. Add a `console.assert` in `shell.js init()` that fails loudly if any of the three is missing.
> 2. Remove the `editor_panel.js` dynamic import from `index.html` and move the file to `client/_legacy/editor_panel.js`. Verify the `P` key now only does what the new shell binds (or nothing).
> 3. Implement the seven Section 8 primitives in `client/editor_core/`. Their interfaces are in the plan; implement them as plain ES modules. Wire each palette to `History` for undo, `Snap` for placement, `Selection` for multi-select. Add the File menu (Save / Save As / Open) to the top bar.
> 4. Implement Section 9 asset upload — one Express handler in the dev server, one autosave-watcher daemon, drop-target footers on EDIT · ASSETS / AUDIO / VFX / BINDINGS.
> 5. Implement real Sculpt — add `_writeHeightmapPatch` C++ entry point, ~80 lines of brush-stroke logic in `editor_terrain.js`.
> 6. Implement real Bindings runtime — load the bindings JSON at boot, dispatch via a small `EventBus` consumed by C++ event hooks (`onWeaponFire`, etc.).
> 7. Sweep `client/editor_*.js` and replace `console.log` with `log()` from the shell.
> 8. Move `level_editor.js` import inside `EditorAssets.onEnter` (single owner).
>
> Do not touch the visual exemplars. Do not redesign anything. The visuals are correct; the gaps are functional.

---

## Ship verdict

**Not ready.** The shell is real and the styling is excellent, but the editor will crash on first mode switch, the old Phase-A panel ships alongside the new one, no undo / save / snap / multi-select / bookmarks exist, and three of the twelve modes (Sculpt, Bindings, partially AI) are placeholder UI without a real backend. Estimate one more focused Claude session to close — call it 1.5 days of his time.

— Manus AI, 2026-04-30
