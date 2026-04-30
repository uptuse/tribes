# Animation Editor Profile — `assets/models/animation_editor.html`

**Profiled:** 2026-04-30 during R32.275 port.

## Rendering stack
Vanilla Three.js (r170, same vendored copy as the main game). Creates its own `THREE.Scene`, `WebGLRenderer`, and `OrbitControls` — these were discarded during the port. The production `editor_animations.js` drives the live Characters skeleton instead.

## Clip data format
`THREE.AnimationClip` objects, extracted from a user-selected GLTF/GLB file via `GLTFLoader`. Clips are stored in `allClips` (name → AnimationClip). Track names follow Three.js convention: `"sanitizedBoneName.quaternion"`, `"sanitizedBoneName.position"`, `"sanitizedBoneName.scale"`.

## Skeleton loading
User drops a `.glb` file. `GLTFLoader` parses it and populates `skeleton` (`THREE.Skeleton`) and `boneMap` (sanitized bone name → `THREE.Bone`). In production this is replaced by the live Characters rig from `renderer_characters.js`.

## Animation evaluation — what was preserved verbatim
The editor does **not** use `AnimationMixer.crossFade`. Instead it implements multi-track weighted blending with upper/lower body masks:

1. `captureBindPose()` — records each bone's rest transforms.
2. `resetToBindPose()` — restores all bones to rest each evaluation frame.
3. `sampleClip(clipName, localTime)` — creates a per-track `interpolant` (cached in `_interpCache`) and evaluates it at `localTime`, returning bone transforms keyed by sanitized bone name.
4. `evaluateTimeline()` — iterates all timeline tracks, accumulates bone weights, blends each bone via `quaternion.slerp()` / `position.lerp()` / `scale.lerp()` using the track's weight and mask (`all` / `upper` / `lower`).

This system is preserved verbatim in `client/editor_animations.js`. The `_interpCache` avoids recreating interpolants every frame. The slerp blend weight formula (`w / (existingW + w)`) correctly handles additive layering across multiple tracks.
