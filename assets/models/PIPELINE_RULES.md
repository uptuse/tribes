# Model Processing Pipeline Rules

## Decimation Rules
1. **Always import from FBX** — Meshy exports FBX with embedded textures + separate high-res PNGs
2. **Use Blender headless** (`/tmp/blender-4.3.0-linux-x64/blender --background --python script.py`)
3. **Joint protection** — Create a vertex group weighting joint zones (ankles, knees, hips, elbows, shoulders, neck) higher so the decimator preserves geometry there
4. **Decimate modifier** — Use `COLLAPSE` mode with `use_collapse_triangulate = True`
5. **Vertex group factor** — Set to 0.5 for moderate joint influence; invert the group so high weight = protected
6. **Two-pass if needed** — If first pass overshoots target by >20%, apply a second decimation pass

## LOD Tiers
| Level | Tris Target | Texture Size | Use Case |
|-------|------------|-------------|----------|
| LOD0  | ~10,000    | 2048x2048   | Close range (0-50m) |
| LOD1  | ~3,000     | 1024x1024   | Mid range (50-150m) |
| LOD2  | ~500       | 512x512     | Far range (150m+) |
| 50k   | ~50,000    | 4096x4096   | Rigging source (not shipped) |

## Texture Rules
1. **Use external PNGs** from Meshy, not the embedded FBX textures (FBX embeds JPGs, lower quality)
2. **Resize per LOD** — `img.scale(size, size)` in Blender before packing
3. **Pack textures** — Call `img.pack()` so they embed into GLB
4. **Export format** — Use `export_image_format='WEBP'` (best quality-per-byte for GLB; Blender 4.3 does not support PNG export in GLB, only AUTO/JPEG/WEBP/NONE)
5. **Never use JPEG** — it crushes quality, especially on normal maps
6. **Color spaces** — albedo/emission = 'sRGB', normal/metallic/roughness = 'Non-Color'

## PBR Material Setup
1. Clear existing FBX materials
2. Create new Principled BSDF material
3. Connect all 5 texture maps:
   - Albedo → Base Color
   - Normal → NormalMap node → Normal
   - Metallic → Metallic
   - Roughness → Roughness
   - Emission → Emission Color (strength = 1.0)
4. Blender auto-merges metallic+roughness into one image on export (glTF spec)

## Export Settings (Blender 4.3)
```python
bpy.ops.export_scene.gltf(
    filepath=output_path,
    export_format='GLB',
    export_image_format='WEBP',
    export_materials='EXPORT',
    export_normals=True,
    export_tangents=True,
    use_active_scene=True,
)
```
**Do NOT use:** `export_colors` (unrecognized), `export_image_format='PNG'` (not available)

## Mesh Cleanup
After decimation, always:
1. Remove doubles (threshold=0.0001)
2. Recalculate normals (outside)
3. Remove non-mesh objects (FBX empties, cameras, lights)

## File Naming
- Source: `assets/models/source/<model_name>/` (not committed to git)
- LODs: `assets/models/<model_name>_lod0.glb`, `_lod1.glb`, `_lod2.glb`
- Rigging source: `assets/models/<model_name>_50k.glb` (only if source is >50k tris)

## Important Discovery (Updated 2026-04-28)
**CORRECTION:** The Meshy FBX "texture" exports are actually **high-poly** — ranging from ~329k to ~1.48M tris depending on the model. The pipeline correctly decimates them down through all 4 LOD tiers.

### Source Tri Counts (from batch run)
| Model | Source Tris | Team |
|-------|-----------|------|
| crimson_warforged | 1,389,709 | Blood Eagle |
| crimson_sentinel | 347,647 | Blood Eagle |
| crimson_titan | 769,963 | Blood Eagle |
| aegis_sentinel | 731,859 | Diamond Sword |
| obsidian_vanguard | 709,207 | Diamond Sword |
| midnight_sentinel | 329,235 | Diamond Sword |
| golden_phoenix | 411,681 | Phoenix |
| violet_phoenix | 1,133,663 | Phoenix |
| auric_phoenix | 777,119 | Phoenix |
| iron_wolf | 1,479,679 | Starwolf |
| emerald_sentinel | 878,704 | Starwolf |
| neon_wolf | 406,466 | Starwolf |

The pipeline decimates from these high-poly sources → 50k → 10k → 3k → 500 tris, with WEBP textures at 4K/2K/1K/512 respectively. Final LOD0 files are 1.1–1.9 MB (vs 68MB with the old PNG pipeline).
