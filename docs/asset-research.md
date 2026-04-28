# Phase 6: Asset Modernization Research (R32.76)

## Free 3D Asset Sources

### 1. Kenney Game Assets (⭐ Best fit)
- **URL**: https://kenney.nl / https://kenney.itch.io/kenney-game-assets
- **License**: CC0 (public domain)
- **Content**: 60,000+ assets — sci-fi kit, space kit, modular buildings
- **Format**: GLB/GLTF, FBX, OBJ
- **Pros**: Coherent art style, low-poly, game-ready, no attribution required
- **Cons**: Stylized (may need adaptation to Tribes aesthetic)
- **Verdict**: ✅ Start here for modular buildings, vehicles, props

### 2. Sketchfab CC0 Collections
- **URL**: https://sketchfab.com (filter: downloadable, CC0)
- **Notable**: @unityfan777 — Sci-Fi LOD sets, vehicles, buildings (all CC0)
- **Pros**: Wide variety, ready to download as GLB
- **Cons**: Inconsistent quality/style across creators
- **Verdict**: ✅ Good for specific hero assets (vehicles, turrets)

### 3. Poly Haven
- **URL**: https://polyhaven.com
- **License**: CC0
- **Content**: Primarily PBR textures and HDRIs, some 3D models
- **Pros**: Industry-quality PBR textures for existing meshes
- **Cons**: Few sci-fi 3D models
- **Verdict**: ✅ Use for texture upgrades on existing geometry

### 4. OpenGameArt.org
- **URL**: https://opengameart.org
- **License**: Mixed (CC0, CC-BY, GPL — check per asset)
- **Content**: Game-focused assets, some sci-fi
- **Pros**: Game-ready, community vetted
- **Cons**: Mixed licenses, inconsistent quality

### 5. NASA 3D Resources
- **URL**: https://science.nasa.gov/3d-resources/
- **License**: Public domain (US Government work)
- **Content**: Spacecraft, stations, planets
- **Pros**: Authentic sci-fi reference, free
- **Cons**: High-poly, not game-optimized

## Asset Priorities for Tribes

1. **Player armor models** — Replace current capsules with armored soldier meshes
   - Need 3 variants (light/medium/heavy armor)
   - Low-poly (2-5k tris), rigged for basic animations
   - Source: Sketchfab CC0 sci-fi soldiers, or Kenney character kit

2. **Vehicle models** — Shrike, ground vehicles
   - Source: Sketchfab @unityfan777 sci-fi vehicles (CC0)

3. **Building/station upgrades** — Replace procedural boxes with detailed interiors
   - Source: Kenney modular sci-fi kit

4. **Weapon viewmodels** — First-person weapon meshes
   - Source: Kenney weapon kit or Sketchfab CC0 sci-fi weapons

## Asset Pipeline

1. Download GLB from source
2. Optimize in Blender (decimate to target poly count)
3. Export as GLB with Draco compression
4. Place in `assets/models/` directory
5. Load via Three.js GLTFLoader (already vendored)

## Asset Editor Concept

A web-based tool that:
- Loads the Raindance heightmap
- Allows drag-and-drop placement of GLB models
- Exports position/rotation/scale as JSON overlay
- Integrates with canonical.json format

Could be built as a separate HTML page using the same Three.js setup.
