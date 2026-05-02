# Anchor Studio v0.5 — todo

## Per-asset scale (current)
- [x] `loadScaleForAsset` / `saveScaleForAsset` helpers
- [x] Apply on `addInstance` (wrapper.scale = per-asset scale)
- [x] Scale banner element in HTML (above anchor list)
- [x] Register banner DOM refs in `els`
- [x] Include `scale` in `buildJsonForFocused()` output
- [ ] Wire scale slider/number/reset events
- [ ] On scale change: update ALL instances of asset path live
- [ ] Show/hide banner with focus, sync value when focus changes
- [ ] Re-fit anchor arrow length when scale changes (rebuildAnchorVisualsForAsset)

## Reference-asset concept
- [ ] Storage: top-level `referenceAssetPath` in saved state (`loadAll().referenceAssetPath`)
- [ ] Helper `getReferenceAssetPath()` / `setReferenceAssetPath(path|null)`
- [ ] Banner shows a "★ ref" toggle: clicking marks/unmarks current asset as reference
- [ ] When asset IS reference: scale forced to 1.0, slider shows "reference (1.0)" and is disabled
- [ ] When asset IS NOT reference and a reference exists: show "× character" multiplier next to the absolute value
- [ ] Scene-row label: append `★` next to the reference asset
- [ ] Persist across reloads
- [ ] Include `isReference: true` in refs.json for the reference asset (optional metadata)

## Drag-to-attach
- [ ] Add pointerdown on anchor dot that initiates a drag
- [ ] During drag: draw amber line from start anchor to cursor (raycast for hover target anchor on a different instance)
- [ ] On pointerup over a valid target anchor: create attachment with default mode `position`
- [ ] On pointerup elsewhere: cancel
- [ ] Cycle prevention reused
- [ ] Visual: hovered candidate anchor pulses

## Polish
- [x] Bump cache-bust to 20260502-1100
- [x] Bump build stamp to v0.5
- [ ] CSS for `.asset-scale-banner`, `.scale-banner-label`, ref toggle
- [ ] Restart dev server on :8766
- [ ] Browser smoke test
- [ ] git add / commit / push
