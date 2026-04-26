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
