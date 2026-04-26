# Building Tribes Browser Edition

## Prerequisites

- [Emscripten SDK](https://emscripten.org/docs/getting_started/downloads.html) installed at `/Users/jkoshy/emsdk/`
- Tribes 1 game assets (DTS models) in `assets/`

## Assets

Drop these DTS files from a Tribes 1.40+ install into `assets/`:

- `larmor.dts` — Light armor model
- `marmor.dts` — Medium armor model
- `harmor.DTS` — Heavy armor model
- `discb.DTS` — Spinfusor disc projectile
- `chaingun.DTS` — Chaingun model
- `grenade.DTS` — Grenade model
- `tower.DTS` — Flag tower structure

These binary assets are `.gitignore`d. Generated headers (`raindance_heightmap.h`, `raindance_mission.h`) are committed source code.

## Build & Deploy

```bash
./build.sh
```

This compiles `program/code/wasm_main.cpp` to WASM, bundles assets, and copies output to the repo root for GitHub Pages.

## Renderer flag (R17+)

By default, the game uses the **Three.js renderer** (introduced R15, default
in R17). To fall back to the legacy hand-rolled WebGL renderer (sunset
planned R18.1), append `?renderer=legacy` to the URL:

```
https://uptuse.github.io/tribes/                    # Three.js (default)
https://uptuse.github.io/tribes/?renderer=legacy    # legacy WebGL
```

The legacy renderer lives in `program/code/wasm_main.cpp` behind the
`if(g_renderMode != 0) return;` guard. The Three.js renderer lives in
`renderer.js` at the repo root, loaded as an ES module via importmap.

## Local Testing

```bash
cd build && python3 -m http.server 8080
# Open http://localhost:8080/tribes.html
```

## Source Files

| File | Description |
|------|-------------|
| `program/code/wasm_main.cpp` | Entire game (~1500 lines) |
| `program/code/dts_loader.h` | DTS model parser (header-only) |
| `program/code/raindance_heightmap.h` | 257x257 heightmap data |
| `program/code/raindance_mission.h` | Flag/building/turret positions |
| `shell.html` | Emscripten HTML shell with Tribes 1 UI |
