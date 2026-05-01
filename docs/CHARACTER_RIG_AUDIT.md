# Character Rig Audit — R32.277

**Date:** 1 May 2026  
**Purpose:** Record every model's rigging convention, scale, and re-export status so the runtime can classify them correctly and the asset pipeline has a clear backlog.

---

## Classification

| Model | File | Kind | Skins | Meshes | Root scale | Notes |
|---|---|---|---|---|---|---|
| crimson_sentinel | `crimson_sentinel_rigged.glb` | **skinned** | 1 | 1 | 1.0 (Armature child is 0.01) | Only fully drivable model. Boot default. |
| auric_phoenix | `auric_phoenix_rigged.glb` | rigid — **no mesh** | 0 | 0 | 1.0 | Downloaded animation-only from Mixamo. Has clip tracks, no geometry. Invisible at runtime. **Needs full re-export with skin.** |
| crimson_titan | `crimson_titan_rigged.glb` | rigid — **no mesh** | 0 | 0 | 1.0 | Same as auric_phoenix. Invisible. **Needs full re-export with skin.** |
| emerald_sentinel | `emerald_sentinel_rigged.glb` | rigid — mesh, no skin | 0 | 1 | 1.0 | Static silhouette. Renders but cannot be animated via SkinnedMesh. **Needs skin binding re-export.** |
| midnight_sentinel | `midnight_sentinel_rigged.glb` | rigid — mesh, no skin | 0 | 1 | 1.0 | Same as emerald_sentinel. **Needs skin binding re-export.** |
| obsidian_vanguard | `obsidian_vanguard_rigged.glb` | rigid — mesh, no skin | 0 | 1 | 1.0 | Same as emerald_sentinel. **Needs skin binding re-export.** |

---

## Models not yet in roster (pending Mixamo re-export)

| Model | Source FBX | Status |
|---|---|---|
| aegis_sentinel | `assets/models/aegis_sentinel_50k.fbx` (original, unrigged) | Needs Mixamo upload + "with skin" download |
| crimson_warforged | `assets/models/crimson_warforged_50k.fbx` | Same |
| golden_phoenix | `assets/models/golden_phoenix_50k.fbx` | Same |
| iron_wolf | `assets/models/iron_wolf_50k.fbx` | Same |
| neon_wolf | `assets/models/neon_wolf_50k.fbx` | Same |
| violet_phoenix | `assets/models/violet_phoenix_50k.fbx` | Same |
| wolf_sentinel | `wolf_sentinel_rigged.glb` (origin unknown) | Needs audit |

---

## Re-export instructions

For each model listed as "Needs re-export":

1. Go to [mixamo.com](https://www.mixamo.com)
2. Upload the `*_50k.glb` converted to OBJ (use `tools/glb_to_obj.py`)
3. Auto-rig, then download: **Format = FBX, Skin = With Skin, Frames per Second = 30, Keyframe Reduction = None**
4. Place the FBX in `tools/obj_export/`
5. Run: `/usr/bin/arch -x86_64 ~/.npm-global/lib/node_modules/fbx2gltf/bin/Darwin/FBX2glTF --input <name>.fbx --output assets/models/<name>_rigged --binary`
6. Add the id to `ROSTER` in `renderer_characters.js`

---

## Coordinate convention reference

Mixamo exports with a double-fixup in the GLB hierarchy:
- `Armature` node: rotation `[+90° X]` (glTF Y-up correction)
- `mixamorigHips` child: rotation `[-90° X]` (Mixamo internal convention)

The two cancel when **both are preserved**. Any code that overwrites the root rotation of the loaded scene (even to "zero it") destroys this cancellation and causes the character to appear face-down.

**Rule:** Never call `model.rotation.set(...)` on the inner loaded GLB scene. Always wrap it in a `THREE.Group` and drive the wrapper.
