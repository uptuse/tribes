# Anchor Studio — todo

## v0.5 (shipped 20260502-1115)
- [x] Per-asset scale persisted in refs.json
- [x] Reference asset (★) with × multiplier readout
- [x] Drag-to-attach
- [x] Shift-click to place anchor in orbit mode
- [x] Auto-select after place

## v0.6 — Terrain Studio tab + handoff doc

### Documentation
- [ ] HANDOFF.md — full context dump for a fresh AI session:
  data model (localStorage shape + refs.json contract), file layout,
  rendering pipeline (three.js scene graph), interaction modes,
  anchor coordinate spaces, runtime contract for the game side
  (parent.worldScale × child.refsScale rule), how to add a new tab,
  known gotchas (e.g. listGlbsRecursively rate limits, axis modes,
  cycle prevention).

### Terrain core
- [ ] Top-level tab system: `[ ANCHORS ] [ TERRAIN ]` next to brand
- [ ] Persist active tab in localStorage; bookmarkable via #hash
- [ ] Terrain mode: own scene root, swapped on tab change
- [ ] Configurable world extent: default 256m × 256m, user-resizable;
      resampling preserves existing edits
- [ ] Height grid (default 128×128 over the extent) stored as Float32Array
- [ ] Splat layers: grass / rock / snow as 3 weight channels
- [ ] Brushes: raise / lower / smooth / flatten / noise / paint-grass /
      paint-rock / paint-snow / stamp
- [ ] Brush size [, brush strength , Shift inverts, Ctrl smooths
- [ ] Stamp library: 3 built-in stamps (hill, crater, ridge)
- [ ] Undo / redo (~20 deep), per-stroke not per-cell
- [ ] localStorage persistence (chunked / debounced)
- [ ] Export terrain.refs.json (heightmap + splat + bounds + version)
- [ ] Import terrain.refs.json (drag-drop or file picker)

### Character preview
- [ ] Pick any rigged character from the asset library, drop onto terrain
- [ ] Walk mode (WASD over terrain surface, gravity stuck to height)
- [ ] Toggle 1p (camera at character eye) / 3p (camera behind)
- [ ] Show character scale relative to terrain extent

### Cleanup
- [ ] Bump build stamp to 20260502-XXXX
- [ ] Smoke test in browser
- [ ] Commit + push
