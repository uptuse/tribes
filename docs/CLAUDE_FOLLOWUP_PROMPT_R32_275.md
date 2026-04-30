# Follow-up prompt for Claude — R32.275 (close-out of editor shell)

**Read this prompt in full before writing any code.** This session is purely follow-through on the R32.274 shipment. Do not start new work and do not redesign anything visual — the design tokens, wordmark, welcome card, mode tiles, and copy are correct as shipped. The work below is functional only.

The full review is at `docs/Claude_Shipment_Review_R32_274.md`. This prompt summarises the work order and acceptance bar.

---

## Operator-confirmed defect (top priority)

When the operator opens the panel and clicks any mode tile, **nothing visible happens**. The mode-tile click does fire `switchMode()` correctly, the camera does detach, and the per-mode palette div does receive the `.open` class. But the palette is anchored at `position: absolute; left: 10px;` and slides in from the **left edge of the viewport**, while the panel-with-tiles is anchored on the right. The operator never sees the controls because they appear roughly 1000+ pixels away from where the click happened. The editor looks broken.

This is the single biggest fix and it lands first.

### Task 1 — consolidate the palette into the right-side panel

The right panel (`#fw-panel`, 340px) currently contains: the 12-tile mode grid, a small `#fw-mode-body` desc/tip div, and a footer. **Add a new region between `#fw-mode-body` and the footer** that hosts the active mode's palette content. Use a single shared element — call it `#fw-palette-host`.

Rewrite the palette flow:

1. Delete `_buildPalettes()` entirely. Delete the `.fw-palette` CSS rules (the slide-in-from-left ones). Delete the eleven separate palette divs.
2. In `_buildPanel()`, add `<div id="fw-palette-host"></div>` between the mode-body and the footer.
3. In `registerMode(id, mod)`, **stop calling `mod.buildPalette()` at registration time**. Just store the module reference.
4. In `_enterPalette(id)` (rename it to `_mountPalette` for clarity), get the host, clear it, and call `_modes[id].buildPalette(host)` against the empty host.
5. In `_leavePalette(id)` (rename to `_unmountPalette`), get the host and clear its children.
6. Each editor module's `buildPalette(root)` continues to work — but now `root` is the live host element, not a wrapper div. Update each module to write directly into `root` instead of looking for `#fw-palette-body-edit-XYZ` inside it. Drop the `if (!body) return;` guard since `root` is guaranteed non-null.

After this change: every editor module is one line shorter (no querySelector for body), the panel is the single visual surface, and the left-edge floating palette goes away entirely. **The editor should now look and feel like the prototype, where everything happens in one column on the right.**

Verify by running through every mode: click each of the 11 edit tiles, confirm content populates immediately in the right panel under the desc/tip line.

---

## Task 2 — make the WASM bridge real

The CI rebuild after R32.274 produced a new `tribes.wasm` but the regenerated `tribes.js` only contains `_setPhysicsTuning`. `Module._pause`, `Module._teleportPlayer`, and `Module._reloadBuildings` are not bound. Today these calls silently no-op (because of `?.`-guarded calls), which means physics keeps running underneath the editor and Shift+P teleport is dead.

Trigger a clean Emscripten build (clear cache, re-run `build.sh`) and verify with this assertion at the top of `Shell.init()`:

```js
const required = ['_pause', '_teleportPlayer', '_reloadBuildings', '_setPhysicsTuning'];
const missing = required.filter(fn => typeof window.Module?.[fn] !== 'function');
if (missing.length) console.error('[Shell] Missing WASM exports:', missing);
```

Commit the rebuilt `tribes.js` + `tribes.wasm`. The console must be silent on this assertion before you ship.

---

## Task 3 — remove the legacy editor panel

`index.html` still contains:
```js
import('./client/editor_panel.js').then(...)
```

Delete that block. Move `client/editor_panel.js` to `client/_legacy/editor_panel.js`. The new shell fully supersedes it. The `P` key should now do exactly one thing (or nothing — your call, but pick one).

---

## Task 4 — implement the seven Section 8 cross-cutting primitives

Create `client/editor_core/` and add seven small ES modules. Each is plain JS, no framework. Wire each palette to use them.

| File | Surface | Bindings |
|---|---|---|
| `History.js` | `push(action)`, `undo()`, `redo()`, single global stack | `Ctrl+Z`, `Ctrl+Shift+Z` (or `Ctrl+Y`) |
| `MapManager.js` | `newMap()`, `openMap(slug)`, `saveMap()`, `saveMapAs(slug)`, `listMaps()` | `Ctrl+S`, `Ctrl+Shift+S`, `Ctrl+O`. Adds File menu to top bar |
| `Layers.js` | toggle visibility + edit-lock per category (props, buildings, triggers, vfx, bots, sound listeners). Renders a small Layers card pinned bottom-left of the panel | none |
| `Snap.js` | global snap, default ON, holding `Shift` suppresses, pressing `G` cycles modes (off / 0.5m / 1m / 4m). Replaces buildings.js's local snap | `Shift` (modifier), `G` (cycle) |
| `Selection.js` | `add(obj)`, `remove(obj)`, `clear()`, `boxSelect(rect)`, `forEach(cb)`, group ops (delete, move, rotate, duplicate) | drag for box, `Ctrl+click` to add, `Delete` to remove, `D` to duplicate |
| `CameraBookmarks.js` | save/restore four edit-camera poses | `Shift+F1..F4` to save, `F1..F4` to restore |
| `Playtest.js` | already exists in shell.js as `Shift+P`; extract into this module for cleanliness | `Shift+P` |

Acceptance: after this task, the operator can place 5 buildings, press `Ctrl+Z` 5 times, and watch them all undo. Can press `Ctrl+S` to save, edit, press `Ctrl+Shift+S` to save-as. Can press `Shift+F2` while looking at the flag, walk to the rocks, press `F2`, and snap back. None of these work today.

---

## Task 5 — implement Section 9 asset upload

Add one server-side handler and per-palette drop targets:

1. **Server**: in the existing dev server (Express or whatever ships with the repo), add `POST /api/upload` that accepts `multipart/form-data` with fields `category` (string: `models`, `audio`, `images`) and `file`. Write to `assets/uploads/<category>/<basename>.<contentHash8>.<ext>`. Return JSON `{ ok: true, path: 'assets/uploads/...' }`.
2. **Watcher**: a `chokidar` daemon or simple `fs.watch` loop that diffs `assets/uploads/`, `data/maps/`, `data/triggers/`, `data/bots/`, `data/bindings.json` every 2 seconds. On change, `git add` + `git commit -m "autosave: <slug>"` + `git push`. Document the daemon in `docs/Asset_Upload.md`.
3. **Drop targets**: at the bottom of EDIT · ASSETS, EDIT · AUDIO, EDIT · VFX (textures), and EDIT · BINDINGS, add a 60px-tall dashed-border drop zone with the copy "Drop files here to upload." On drop, POST to `/api/upload`, then invalidate the relevant palette's asset list so the new file appears.

Acceptance: drag a `.glb` from the Finder onto EDIT · ASSETS; the file appears in the asset list within ~3 seconds and is committed to GitHub.

---

## Task 6 — make Sculpt real

Today `editor_terrain.js` is 62 lines of UI that draw four brushes and two sliders, then do nothing on mousedown.

Add a C++ entry point:

```c
extern "C" void writeHeightmapPatch(int cx, int cy, int radius,
                                    float strength, int modeFlag) {
    // modeFlag: 0=raise, 1=lower, 2=smooth, 3=flatten
    // stamp Gaussian onto g_heightmap around (cx, cy), respecting radius/strength
    // then call recomputeTerrainNormals() so the existing renderer sees the change
}
```

On the JS side, when in Sculpt mode and the operator drags on the terrain, raycast the cursor to terrain coords each frame and call `Module._writeHeightmapPatch(cx, cy, brushRadius, brushStrength * dt, modeFlag)`. After each call, refresh the terrain mesh's vertex buffer from `Module._getHeightmapPtr()`.

Acceptance: drag the cursor across the ground in Sculpt mode and watch a hill rise under it. Switch to Play, walk over the hill, feel the new collision.

---

## Task 7 — make Bindings real

Today `editor_bindings.js` exports a hand-written list of 9 event ids and lets the operator click them, but nothing reads the exported JSON and there's no socket/animation-event auto-discovery.

Build a minimal runtime:

1. **Loader**: at boot, `fetch('/data/bindings.json')` and pass to a new `client/event_bus.js` module.
2. **EventBus**: `on(eventId, handler)`, `fire(eventId, payload)`. On boot, register each binding's reactions (e.g. spawn VFX preset X at socket Y, play audio event Z) as handlers.
3. **C++ hooks**: at the existing weapon-fire / projectile-impact / footstep / land / jump / flag-pickup callsites in `wasm_main.cpp`, call out to the JS-side `EventBus.fire()` via an exported JS callback (already pattern-established for audio).
4. **GLB socket auto-discovery**: when an asset is loaded, walk its scene graph and surface any node named `muzzle*`, `eject*`, `socket_*` to the Bindings palette as attach point options (no UI for sockets needed at v1 — auto-pick the first match).
5. **Animation event auto-discovery**: when an animation clip is loaded, parse its `userData.events` (or trailing `_evt` markers) and surface as event ids prefixed with `<asset>.<clip>.<frame>`.

Acceptance: bind `disc_launcher.on_fire` → `audio:weapon_fire` + `vfx:muzzle_flash`. Switch to Play. Fire the disc launcher. Hear the sound, see the flash on the muzzle. None of this works today.

---

## Task 8 — small sweeps

- **Logging**: `client/editor_*.js` currently mixes `log()` (the shell-provided on-screen log) with `console.log`. Replace every `console.log` with `log()` in the editor modules. ~30 minutes.
- **Single owner for `level_editor.js`**: today `renderer.js` imports it dynamically, and `editor_assets.js` also delegates to it. Move the import inside `EditorAssets.onEnter()` so the module has a single owner with a clear lifecycle.
- **`Characters.init` rig wiring**: today `renderer.js` does `Characters.init(scene).then?.(...)`. If `Characters.init` is synchronous, the `.then?.()` short-circuits and `setCharacterRig()` never runs, so EDIT · ANIMATE has nothing to drive. Confirm sync vs async; if sync, just call `setCharacterRig()` after the `try` block.
- **Animation editor profile note**: write `docs/animation_editor_profile.md` summarising what `assets/models/animation_editor.html` does end-to-end and which parts were preserved verbatim in `editor_animations.js`. ~200 words.
- **`.claude/settings.json`**: gitignore it.

---

## Acceptance bar before pushing

1. Open the game. Click. Game runs.
2. `Shift+Enter`. Panel slides in from the right with all 12 mode tiles.
3. Click `Build`. The Build palette content (asset list, snap toggle, rotate hint) appears in the same right panel under the desc/tip line. **Visible. No hunt.**
4. Click each of the other 10 edit modes. Each populates immediately. No empty bodies, no silent failures.
5. DevTools console shows zero errors and zero warnings from `[Shell]`.
6. `Ctrl+Z` undoes the last placement in any mode.
7. `Ctrl+S` saves the current map. Reload the page. Map persists.
8. Drag a `.glb` onto EDIT · ASSETS. File uploads, appears in the list, is committed to GitHub within ~3 seconds.
9. In Sculpt, drag on the ground. Terrain visibly deforms.
10. Bind `disc_launcher.on_fire → audio + vfx`. Fire disc launcher in Play. Hear sound, see flash.

If all ten pass, commit as **R32.275** and push.

— Manus AI, 2026-04-30
