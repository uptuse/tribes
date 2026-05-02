# Anchor Studio — Handoff Document

> **Audience:** A new AI session, or a future-you with a cleared token, picking up this tool with no prior context. Read this end-to-end before touching code.
>
> **Last verified build:** `v0.5 · 20260502-1115` (commit `aa46451` on `uptuse/tribes@master`).

---

## 1. What Anchor Studio is, in one paragraph

Anchor Studio is a single-page browser tool for authoring **named coordinate-frames** ("anchors") on GLB assets that live in the `uptuse/tribes` repository. An anchor is a position (and optionally a forward axis) expressed in the GLB's authored local space. The tool also lets you assemble multiple GLBs into a scene, attach one to another via anchor-to-anchor pairings, and per-asset uniformly scale them — all with the goal of producing small `*.refs.json` companion files that the `tribes` runtime can load alongside the GLB to know where the gun goes in the character's hand, where the muzzle is, where projectiles spawn, etc.

It deliberately does **not** modify the GLBs. Anchors are metadata.

---

## 2. File layout

```
tools/anchor-studio/
├── HANDOFF.md      ← this file
├── README.md       ← short user-facing overview (older; this doc supersedes it)
├── todo.md         ← what's done and what's next
├── index.html      ← shell, header, three columns (scene · viewport · inspector)
├── styles.css      ← all CSS; design tokens at the top in :root
└── app.js          ← single-file vanilla-JS module (no bundler, no framework)
```

It is served as static files. During development run `python3 -m http.server 8766` from this directory. The app pulls assets and asset listings directly from GitHub at runtime, which means: **no backend, no API key, but it is rate-limited by GitHub's anonymous-API quota (60 req/h per IP).** If listing fails or stalls, that's almost always why.

There is no build step. `index.html` cache-busts `app.js` and `styles.css` with a `?v=YYYYMMDD-HHMM` query string and prints the same stamp in the footer. **Bump all three when you ship a change**, or you and the user will spend ten minutes wondering why a fix isn't taking effect.

---

## 3. Runtime architecture

The app is one ES module (`app.js`) loaded as `<script type="module">`. It uses three.js r161 from unpkg via an importmap. There is no React, no virtual DOM, no reactive store — every state mutation calls a `render*()` function explicitly. This is intentional and should be preserved; adding a framework would balloon the file size and obscure the data flow.

The high-level pipeline is:

```
GitHub API ──▶ asset list ──▶ Library tree ──┐
                                              ▼
              user click ─────▶ addInstance(assetPath)
                                              │
                                              ▼
                  GLTFLoader ──▶ THREE.Group ──▶ scene root
                                              │
                                              ▼
              loadAnchorsForAsset(path) ──▶ anchor dots/arrows
                                              │
                                              ▼
              user interaction ──▶ state mutation ──▶ render*()
                                              │
                                              ▼
                          localStorage save  +  refs.json export
```

`requestAnimationFrame` drives only the orbit-controls + renderer; everything else is event-driven.

---

## 4. Data model

### 4.1 The single source of truth: `localStorage["anchor_studio.v2"]`

```jsonc
{
  // Per-asset metadata, keyed by the asset's repo-relative path.
  // Anchors and scale belong to the asset itself, not to a particular
  // instance, because the runtime will look them up by asset path.
  "byAsset": {
    "assets/weapons/aurora_pulse_blaster.glb": {
      "anchors": [
        {
          "id":   "<uuid>",            // editor-only, never exported
          "name": "muzzle",            // exported as the key in refs.json
          "p":    [0.0, 0.04, 0.78],   // local-space position, metres
          "axis": [0, 0, 1],           // OPTIONAL unit vector, local space
          "note": "barrel tip"         // OPTIONAL free-text
        }
      ],
      "scale":     0.85,               // per-asset uniform scale
      "updatedAt": 1746210000000
    }
  },

  // OPTIONAL: at most one path is the "size reference" (= 1.0).
  // Other assets' scales are interpreted as multiples of this one.
  "referenceAssetPath": "assets/models/auric_phoenix_rigged.glb",

  // The current editor scene (which instances are loaded, where they
  // sit, what's focused). Persisted so a refresh restores the workspace.
  "scene": {
    "instances": [
      {
        "id":         "<uuid>",
        "assetPath":  "assets/weapons/aurora_pulse_blaster.glb",
        "name":       "aurora_pulse_blaster",
        "t":          [0, 0, 0],       // translation in scene space, metres
        "r":          [0, 0, 0],       // euler XYZ, radians
        "s":          1.0,             // mirrored from byAsset[].scale
        "attachment": null             // see §4.4
      }
    ],
    "focusedId": "<uuid or null>"
  }
}
```

`STORAGE_KEY = "anchor_studio.v2"`. If you change the shape, bump to `v3` and migrate, or you will silently corrupt user state on reload.

### 4.2 Anchor coordinate space (read this twice)

An anchor's `p` and `axis` are in the **GLB's authored local space**, exactly as it sits when you `loadAsync()` it without any transform. They are **not** affected by the editor's per-asset scale, instance translation, or attachment chain. This is what makes them stable: re-export, re-import, attach, scale — the muzzle is always at the same `p` relative to the gun's mesh.

Anchor *visuals* in the editor (the dot and the arrow) **do** account for the per-asset scale: the dot is drawn at world position `instanceWorldMatrix · diag(s) · p`, and the arrow length is divided by `s` so it stays the same screen size regardless of how the gun was scaled. This is in `rebuildAnchorVisualsForAsset()`.

### 4.3 Per-asset scale — semantics

`byAsset[path].scale` is **the asset's authored real-world size** as the author chose it. It is not "how big this thing happens to look in the editor right now"; it's "how big this thing should be when handed to the game." In code:

- Every loaded `THREE.Group` for that asset path has `wrapper.scale.setScalar(s)` applied immediately in `addInstance()`.
- Changing the slider runs `applyAssetScaleToAll(path)`, which iterates `state.instances`, sets `inst.three.scale.setScalar(s)` on every match, and rebuilds anchor visuals so arrow lengths stay consistent.
- The value is exported in `refs.json` as the top-level `scale` field.

### 4.4 Reference asset — semantics

At most one asset is "the reference". Its scale is forced to `1.0` and its slider is locked in the inspector. In the scene tree it gets a `★` glyph next to its name. Other assets show their scale as `× N.NNN ref` next to the absolute slider so you can sanity-check proportions ("the gun is 0.12× the size of the character"). Marking a different asset as ref clears the previous one. Persisted at the top level as `referenceAssetPath`. Exported into the *reference asset's own* refs.json as `"isReference": true`.

The runtime contract this enables is described in §6.

### 4.5 Attachment

When you drag one asset's anchor onto another asset's anchor, the child instance gets:

```jsonc
"attachment": {
  "parentInstanceId":  "<uuid>",
  "parentAnchorName":  "right_hand_grip",
  "childAnchorName":   "grip",
  "mode":              "position",    // | "axis-anti" | "axis-parallel"
  "rollDeg":           0,             // only used in axis modes
  "extraOffset":       [0, 0, 0]      // not yet exposed in UI
}
```

A topological sort in `rebuildAttachmentLines()` and the per-frame `applyAttachments()` resolves chains so a held muzzle can itself parent a scope. `wouldCreateCycle()` blocks circular attachments. **Attachments live only in the scene state, not in `byAsset`**, because they describe a particular composition, not the asset itself. (Multi-asset rig export — `rig.json` — is intentionally Phase B; it doesn't exist yet.)

---

## 5. The export contract — `*.refs.json`

For each asset, the "Download .refs.json" button writes a file shaped like:

```json
{
  "asset":   "assets/weapons/aurora_pulse_blaster.glb",
  "version": 1,
  "scale":   0.85,
  "isReference": true,
  "anchors": {
    "muzzle":      { "p": [0.0, 0.04, 0.78], "axis": [0, 0, 1] },
    "grip":        { "p": [0.0, -0.05, 0.10] },
    "ejection":    { "p": [0.03, 0.02, 0.30], "note": "shells eject here" }
  }
}
```

Rules the runtime can rely on:

| Field | Type | Required | Meaning |
|---|---|---|---|
| `asset` | string | yes | Repo-relative path; the loader can use this to assert it loaded the right GLB. |
| `version` | int | yes | `SCHEMA_VERSION` constant in `app.js`. Bump when the shape changes. |
| `scale` | float | yes | Authored uniform scale. The runtime applies this on top of the GLB's intrinsic transform. |
| `isReference` | bool | optional | Only present (and `true`) on the asset chosen as the reference. |
| `anchors` | object | yes | Map from anchor `name` to `{ p, axis?, note? }`. Names are unique per asset. |
| `anchors[].p` | `[x,y,z]` | yes | Local-space position in metres. |
| `anchors[].axis` | `[x,y,z]` | optional | Local-space unit forward direction (used by axis-mode attachments). |
| `anchors[].note` | string | optional | Free-text; ignored by the runtime. |

Filename convention: `<glb-stem>.refs.json` (sibling to the GLB). `refsFilenameFor()` enforces this.

---

## 6. Runtime contract for the game side

This is the rule the game's loader should implement. It is the whole point of the per-asset scale + reference asset features.

> **When attaching `child` to `parent` via anchors:**
>
> 1. Place the child so that `child_local_anchor` (after applying `child.refsScale`) lands at `parent_local_anchor` (after applying `parent.refsScale`), expressed in `parent`'s world frame.
> 2. The child inherits `parent.worldScale`, then multiplies by `child.refsScale` to get its own world scale.
> 3. If the runtime later resizes the parent (e.g. fits a character to a target world height `K`), the child rides along automatically because its world scale was derived from the parent's.

In pseudo-code:

```ts
function attachChildToParent(child, parent, childAnchorName, parentAnchorName) {
  const ca = child.refs.anchors[childAnchorName];
  const pa = parent.refs.anchors[parentAnchorName];

  // World scale = parent world scale * child's authored scale.
  const childWorldScale = parent.object3D.getWorldScale(new Vector3())
                          .multiplyScalar(child.refs.scale);

  // Parent the THREE node so transforms compose automatically:
  parent.object3D.add(child.object3D);
  child.object3D.scale.set(child.refs.scale,
                           child.refs.scale,
                           child.refs.scale);

  // Position the child so its anchor coincides with the parent's anchor,
  // both expressed in the parent's local space.
  const parentAnchorLocal = new Vector3(...pa.p);          // already accounts for nothing
  const childAnchorLocal  = new Vector3(...ca.p);          // in child's local space
  // Child's local frame is scaled by child.refs.scale relative to parent local.
  // So in parent local space, child's anchor sits at:
  //     childPosLocal + (childAnchorLocal * child.refs.scale)
  // We want that to equal parentAnchorLocal:
  child.object3D.position.copy(parentAnchorLocal)
                          .sub(childAnchorLocal.multiplyScalar(child.refs.scale));

  // Optional axis modes: re-orient the child so its axis aligns
  // (parallel or antiparallel) to the parent's axis. Use rollDeg for spin.
}
```

The reference-asset concept does **not** add any runtime computation; it's purely an authoring convenience. It just means the per-asset scales the author chose are guaranteed to be consistent with one canonical asset. The game does not need to know which asset was the reference.

---

## 7. Interaction modes (UI)

The toolbar has three modes:

- **ORBIT** — `OrbitControls` rotate/pan/zoom. Click an anchor dot to select; the `TransformControls` gizmo appears so you can drag the anchor in local space. **Shift+click on a mesh** drops a new anchor without leaving orbit.
- **PLACE** — Click on the focused asset's mesh to drop an anchor at the hit point (raycast against the wrapper, then `worldToLocal` to get the local-space `p`). Auto-selects the new anchor.
- **AXIS** — Click on the focused asset to set the `axis` of the *currently selected* anchor to a unit vector pointing from the anchor outward to the click point. Used to define forward/up directions for axis-mode attachments.

Drag-to-attach is mode-independent: pressing on an anchor and dragging onto another anchor on a different instance attaches them, regardless of orbit/place/axis. A pure click (no drag) still selects.

Keyboard:
- `P` / `O` / `V` switch to place / orbit / axis.
- `F` frames the focused asset (or the whole scene if nothing focused).
- `Delete` / `Backspace` removes the selected anchor.
- `Shift+click` in orbit mode drops an anchor on the hit point.

---

## 8. Important functions, by file region

`app.js` is long but flat. Use these landmarks:

| Lines (approx.) | Region |
|---|---|
| 1 – 38 | Header doc block, imports, constants (`REPO`, `BRANCH`, `STORAGE_KEY`, `SCHEMA_VERSION`). |
| 40 – 95 | DOM `els` map. **Add new element refs here** when you add UI. |
| 97 – 110 | In-memory `state` object. |
| 110 – 165 | `loadAll`/`saveAll`, `loadAnchorsForAsset`/`saveAnchorsForAsset`, `loadScaleForAsset`/`saveScaleForAsset`, `getReferenceAssetPath`/`setReferenceAssetPath`. |
| 195 – 340 | Attachment logic: `wouldCreateCycle`, `attachInstance`, `updateAttachment`, `detachInstance`, `applyAttachments`, `rebuildAttachmentLines`. |
| 341 – 376 | `listGlbsRecursively` — walks `assets/` via the GitHub contents API. |
| 378 – 470 | Library tree rendering (left panel). |
| 470 – 565 | Three.js scene init + helpers (grid, axes, camera, raycaster). |
| 565 – 660 | `addInstance`, `removeInstance`, `focusInstance`, `frame`. |
| 660 – 760 | Scene-tree rendering (right of library). |
| 760 – 950 | Anchor visuals (`rebuildAnchorVisualsForAsset`), pointer interaction, gizmo wiring. |
| 950 – 1010 | `addAnchor`, `deleteAnchor`, `selectAnchor`. |
| 1010 – 1150 | Inspector panel + attachment block. |
| 1150 – 1220 | Export builders (`buildJsonForFocused`, `refsFilenameFor`, `renderExport`). |
| 1300 – 1500 | Boot, library refresh, asset filter. |
| 1500 – 1600 | v0.5 scale banner: `applyAssetScaleToAll`, `syncScaleBanner`, ref-toggle wiring. |
| 1600 – end | v0.5 drag-to-attach: `dragState`, `startDragAttach`, `updateDragAttach`, `finishDragAttach`. |

---

## 9. Known gotchas

1. **GitHub anonymous API rate limit.** First boot lists `assets/` recursively. If you've reloaded the page ~20 times in an hour you'll start hitting 403s and the library will silently say "Loading from GitHub…" forever. The fix is to wait an hour, or — when this becomes a real problem — drop a `GITHUB_TOKEN` constant and switch `API()` to authenticated requests.
2. **localStorage corruption from schema drift.** If you change the shape of `byAsset[].anchors[i]`, old saved data will deserialize into a half-broken state. Either bump `STORAGE_KEY` (forces a fresh state) or write a one-shot migration in `loadAll()`.
3. **Anchor visuals vs per-asset scale.** When you change `s`, you must call `rebuildAnchorVisualsForAsset(path)` so the dot+arrow re-derive their world transforms. `applyAssetScaleToAll` already does this; if you write a new path that mutates `s`, do the same.
4. **Attachment cycles.** `wouldCreateCycle(childId, parentId)` walks up the parent chain with a safety counter of 32. If you ever add multiple-parent semantics you'll have to switch to a real DAG check.
5. **Cache-bust.** `index.html` references `app.js?v=...` and `styles.css?v=...` and prints the same stamp in the footer. Bump all three on every shipped change. The user's first sanity check is reading the stamp.
6. **`els.canvas` capture-phase pointerdown.** v0.5 added a capture-phase `pointerdown` listener so it sees the press *before* the existing one that records `downX/downY`. If you reorder these, drag-to-attach will mis-trigger as a click.
7. **`loadGLB` caches by path.** Two instances of the same asset share one cached GLTF; do not mutate the loaded scene graph in place — clone it (`SkeletonUtils.clone` for rigged assets) before adding to the scene.
8. **`focusedInstance()` returns `null` when nothing is loaded.** Every code path that calls it must guard for this. The existing functions all do; preserve that pattern.
9. **Three.js version is pinned via importmap.** Don't `pnpm add three` — it would be ignored. To upgrade, bump the version in the importmap inside `index.html`.

---

## 10. How to add a new top-level tab (for the upcoming Terrain Studio)

The intended pattern (planned for v0.6, not yet implemented as of `aa46451`):

1. Add a tab strip to the header in `index.html` with two buttons (`Anchors`, `Terrain`) and a hash-bound active state (`location.hash = '#terrain'`).
2. Wrap the existing `<main>` body in `<section data-tab="anchors">` and add an empty `<section data-tab="terrain" hidden>` next to it. CSS toggles `[hidden]`.
3. In `app.js`, factor the existing boot into `bootAnchors()` and add `bootTerrain()`. A small `setActiveTab(name)` swaps which section is visible and which scene root is attached to the renderer.
4. Three.js renderer, camera, and orbit controls can be **shared** across tabs — only the scene contents change. Disposing/swapping the scene is enough.
5. Persist the active tab in `localStorage["anchor_studio.v2"].activeTab`. Read it on boot, default to `"anchors"`.
6. Keep terrain state under its own subkey `terrain: { worldExtent, gridSize, heightmap, splat, … }` so it can't collide with anchor data.

---

## 11. How to ship a change

1. Edit code under `tools/anchor-studio/`.
2. Bump the build stamp in three places in `index.html`: the `?v=...` on `styles.css`, the footer's `v0.X · build YYYYMMDD-HHMM`, and the `?v=...` on `app.js`.
3. From the repo root: `cd /home/ubuntu/tribes && git add tools/anchor-studio && git commit -m '...' && git pull --rebase && git push`.
4. The dev server on `:8766` is just `python3 -m http.server`; restart it only if you've changed `index.html`'s static structure heavily, otherwise a hard-refresh is enough.

---

## 12. Glossary

- **Anchor.** A named local-space coordinate frame on an asset. Has `p`, optional `axis`, optional `note`.
- **Asset path.** Repo-relative path like `assets/weapons/aurora_pulse_blaster.glb`. The stable identity for everything in the data model.
- **Instance.** A `THREE.Group` representing one occurrence of an asset in the editor scene. Multiple instances of the same asset share an anchor list.
- **Per-asset scale.** A uniform scalar applied to every instance of an asset. Persists in `byAsset[].scale` and exports as `scale` in `refs.json`.
- **Reference asset.** The single asset chosen as the size unit. Its scale is locked to `1.0`. Other assets display their scale as a multiple of the reference's. Marked `★` in the scene tree, `isReference: true` in its own `refs.json`.
- **Attachment.** A scene-only relation: child's anchor is pinned to parent's anchor, with a mode (`position` | `axis-anti` | `axis-parallel`).
- **`refs.json`.** The output file consumed by the runtime. One per asset. Contains the asset path, schema version, scale, optional reference flag, and the anchor table.

— end of handoff —
