# Character Model Pipeline Rules

## Source Models
- Format: FBX from Meshy.ai (full quality, ~766k verts, 4K textures)
- Store originals in `assets/models/source/` — never modify source files
- Full PBR texture set: albedo, normal, metallic, roughness, emission

## Decimation Rules
- Use Blender headless (`/tmp/blender-4.3.0-linux-x64/blender --background --python`)
- Decimate modifier with `COLLAPSE` mode
- **Protect joint areas**: more geometry at knees, elbows, hips, neck, shoulders
- **Preserve UV seams**: avoid collapsing edges along texture boundaries
- **Preserve sharp edges**: maintain silhouette-defining edges
- Generate 4 outputs per model:
  - **50k tris** — rigging source (used for Mixamo upload + weight painting)
  - **LOD0 ~10k tris** — in-game close range (0-50m)
  - **LOD1 ~3k tris** — in-game mid range (50-150m)
  - **LOD2 ~500 tris** — in-game far range (150m+, billboard candidate)

## Texture Rules
- **NEVER** let Blender re-encode textures as JPEG on export
- Always use `export_image_format='NONE'` or `export_image_format='PNG'`
- Keep 4K textures for LOD0
- Downscale to 2048 for LOD1, 512 for LOD2
- Emission maps are small — keep original size for all LODs

## Rigging Rules
- Rig the 50k version (not full 766k — too heavy for Mixamo, too heavy for realtime)
- Mixamo auto-rig is the gold standard — use it when possible (requires bearer token)
- Fallback: Blender Rigify with proximity-based vertex weighting (quality is lower)
- **Mixamo skeleton naming**: keep whatever Mixamo assigns, never rename bones
- All models must share the same skeleton for animation interchangeability
- One animation set downloaded once, reused across all models

## Animation Rules
- Download animations once from Mixamo (with skin=false, FBX format)
- Required animations: idle, run_fwd, run_back, strafe_l, strafe_r, jump, fall, land, ski, jet, fire_disc, fire_chain, death, flag_carry
- All animations embedded in final GLB
- 30 FPS, no keyframe reduction

## Export Rules
- Final format: GLB with embedded animations and all PBR textures
- Output naming: `{model_name}_lod0.glb`, `_lod1.glb`, `_lod2.glb`
- 1 unit = 1 meter, Y-up
- `team_color` material slot for runtime team tinting

## Mech Models (Reverse-Joint Legs)
- Upper body: standard Mixamo rig + animations
- Legs: procedural IK at runtime (not pre-baked animations)
- Rig upper body only through Mixamo, custom leg bones in Blender

## Performance Budget (128 players)
- LOD0: 8-10k tris max per character
- LOD1: 2-3k tris
- LOD2: 500 tris or billboard
- Instanced rendering for LOD2 (far players)
- GPU skinning for LOD0/LOD1

## Pipeline Order
1. Download from Google Drive → `assets/models/source/`
2. Decimate → 50k, 10k, 3k, 500
3. Rig 50k version (Mixamo or Blender)
4. Bake animations into rigged mesh
5. Transfer rig to each LOD level
6. Export final GLBs with full PBR textures
7. Integrate into Firewolf renderer with LOD switching
