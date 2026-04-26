# Asset Credits

## R18 (visual quality cascade) — procedural-composite strategy

R18's brief recommended sourcing CC0 character/building assets from
Quaternius and Kenney. After review, those packs are **not available via
the approved CDNs** (unpkg / jsdelivr / local), and the R18 guardrail
explicitly forbids hotlinking from artist sites:

> "All asset URLs must be either local (`assets/...`) or from a stable
> CDN (unpkg, jsdelivr) — no hotlinking from artist sites"

The chosen path: **all R18 visuals are procedurally generated in
`renderer.js`** — composite Three.js primitive meshes for players and
buildings; canvas-rendered noise textures for terrain (diffuse + normal);
soft-circle billboard for particles. No third-party glTF, FBX, or texture
files are loaded.

## Third-party software

- **Three.js r170** — MIT License — https://threejs.org
  - Loaded via importmap from `https://unpkg.com/three@0.170.0/`
  - Uses: `WebGLRenderer`, `MeshStandardMaterial`, `Sky` (addons), `EffectComposer`, `UnrealBloomPass` (addons)

- **Emscripten** — MIT License — https://emscripten.org
  - Used to compile the C++ simulation in `program/code/wasm_main.cpp` to WASM

- **Bun** (server runtime, R16 scaffold) — MIT License — https://bun.sh

## C++ engine reference

- **Darkstar engine** (Tribes 1, 1998, Dynamix/Sierra) — clean-room
  reference for game logic (movement physics, weapon stats, mission
  data, building positions). Source code referenced for porting only;
  no Darkstar binary code is included in this build.

## DTS model assets (legacy WebGL renderer only — sunsetting R18.1)

The legacy WebGL render path loads `.dts` files from a Tribes 1.40+
install (sourced by the user from their own copy of Starsiege: Tribes).
These files are `.gitignore`d and not redistributed in this repository.

The Three.js renderer (default since R17) does NOT load any `.dts`
files — it generates all geometry procedurally.

## Future asset acquisition

When R18+ rounds want real glTF character/building/weapon models, the
intended path is:

1. Add candidate packs to `assets/models/` after verifying license
   compatibility (CC0 or CC-BY with attribution recorded here).
2. Update `assets/CREDITS.md` with each pack's name, author URL, and license.
3. Load via `GLTFLoader` from `three/addons/loaders/GLTFLoader.js`.
