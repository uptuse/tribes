# Anchor Studio — todo

## v0.6.1 — Terrain navigation fix (in progress)

- [ ] Add `nav` (hand/pan/orbit) tool button to brush toolbar; default when terrain tab opens
- [ ] When `nav` is active: OrbitControls fully on. LMB = orbit, RMB = pan, wheel = zoom, middle = pan. No painting.
- [ ] When a brush tool is active: LMB-drag paints, but
  - [ ] hold `Space` while dragging → temporary nav (pan with LMB)
  - [ ] hold `Alt` while dragging → temporary orbit
  - [ ] RMB-drag → always orbit (regardless of mode)
  - [ ] middle-drag → always pan
  - [ ] wheel → always zoom
- [ ] Cursor feedback: grab/grabbing for nav, crosshair for paint, brush ghost shown only in paint
- [ ] Press `H` → nav mode shortcut (Photoshop muscle memory)
- [ ] Update on-screen hint text to teach the controls
- [ ] Bump build stamp
- [ ] Browser smoke test: orbit, pan, zoom, paint, hold-Space-to-pan-during-paint
- [ ] Commit + push

## v0.6 — Terrain tab (shipped 20260502-1330)
- [x] Top-level tab strip (Anchors / Terrain)
- [x] Terrain module (terrain.js) self-contained scene
- [x] Configurable world extent (grid + cell, resample on apply)
- [x] Brushes: raise / lower / smooth / flatten / noise
- [x] Material paint: grass / rock / snow
- [x] Stamps: hill / crater / ridge
- [x] Undo/redo (30 deep), Ctrl+Z / Ctrl+Shift+Z
- [x] localStorage persistence
- [x] terrain.refs.json export + import
- [x] Character preview (pick rigged GLB, 1p/3p, WASD walk)
- [x] HANDOFF.md

## v0.5 — Anchor scale + drag-to-attach (shipped 20260502-1115)
- [x] Per-asset scale persisted in refs.json
- [x] Reference asset (★) with × multiplier readout
- [x] Drag-to-attach
- [x] Shift-click to place anchor in orbit mode
- [x] Auto-select after place
