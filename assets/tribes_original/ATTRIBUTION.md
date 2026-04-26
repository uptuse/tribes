# Original Starsiege: Tribes Asset Archive

## Source

This directory is a verbatim snapshot of a Starsiege: Tribes v1.11 install,
sourced from the community-maintained archive at:

- **https://github.com/levizoesch/tribes.game** (forked from kingtomato/tribes.game)

## Contents

- `base/` — original Tribes 1 game volumes (.vol = PVOL archive format)
  - `base/missions/` — mission scripts (.MIS, plain TorqueScript text), terrain (.ted, binary), per-mission lighting (.vol)
  - `base/*.vol` — biome volumes (lush/desert/ice/mars/mud/savana/alien) containing 3D models, textures, materials
  - `base/Entities.vol` — generic entity definitions (turret, generator, inventory station, etc.)
  - `base/sound.vol` — audio
  - `base/Shell.vol`, `base/Interface.vol`, `base/gui.vol` — UI
- `config/` — original game configuration files
- `console.cs`, `missionlighting.cs` — TorqueScript source
- `ORIGINAL_EULA.txt` — the 1998 Sierra/Dynamix EULA shipped with the game

## Provenance and IP

The game was developed by **Dynamix** and published by **Sierra Studios** in 1998.
Subsequent IP holders include Activision, then Hi-Rez Studios (under license).
The archive has been freely circulating on the web since the early 2000s and
the original Sierra/Dynamix v1.11 patcher was made available as a free download.

We are vendoring this archive as a **reference asset set** for our community
recreation of Tribes 1 in the browser. We are not redistributing modified or
re-encoded versions of the original game; we are mirroring an unmodified
snapshot of the historical install for asset extraction (heightmaps, mission
coordinates, building dimensions, lighting parameters).

If a current rights holder objects to the inclusion of any specific file,
contact the repo owner and the file will be removed.

## How we use these assets

- **Heightmaps:** Parse `base/missions/Raindance.ted` (PVOL container holding the 256×256 8-bit heightfield) into our C++ baked array.
- **Coordinates:** Parse `base/missions/Raindance.MIS` text for canonical positions of flag stands, drop points, generators, inventory stations, vehicle pads, control points, lighting, sky, and weather.
- **Models:** Reference the .dts model dimensions inside .vol archives to size our own Three.js procedural meshes accurately.
- **Audio:** Reference the .wav files inside `sound.vol` to source-match weapon, jet, and impact sounds (we may resynthesize rather than redistribute).

## File formats encountered

- `.vol` — Dynamix PVOL archive (4-byte magic `PVOL`, then `VBLK` chunks with `GFIL`/`GBLK` entries holding compressed file data)
- `.ted` — Tribes 1 binary terrain (PVOL-wrapped, contains a `block-N` heightmap dataset and metadata)
- `.MIS` — TorqueScript mission file, plain ASCII text
- `.dsc` — TorqueScript mission description, plain ASCII text
- `.dts` — Dynamix Three Space (model)
- `.dml` — Dynamix Material List (texture set descriptor)
- `.bmp` / `.png` — textures
- `.cs` — TorqueScript source

— Vendored 2026-04-26 by the Tribes Browser Edition project
