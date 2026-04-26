# Tribes Map Format (`.tribes-map`) — R25

A `.tribes-map` is a plain JSON document that describes every piece of state needed to reproduce a playable Tribes match: terrain elevation, structure layout, gameplay points (flags / spawns / inventory stations), and atmosphere (sky / sun / fog).

R25 ships JSON files unencoded. Production builds may serve them with HTTP `gzip` content encoding for transport savings; the file format itself remains plain JSON for inspectability and editor round-trip.

## Top-level shape

```jsonc
{
  "schemaVersion": 1,
  "id": "raindance",                      // stable string id (filename minus extension)
  "name": "Raindance",                    // display name
  "author": "Dynamix (port)",             // attribution
  "maxPlayers": 16,                       // recommended player cap
  "recommendedMix": { "L": 4, "M": 4, "H": 0 },  // suggested class distribution per team

  "terrain": {
    "size": 256,                          // grid resolution N×N
    "worldScale": 8.0,                    // metres per grid cell
    "encoding": "int16-base64",           // "int16-base64" | "float-array"
    "quantStep": 0.1,                     // metres per int16 step (encoding == int16-base64)
    "data": "<base64 string>"             // base64 of N*N int16 little-endian (encoding == int16-base64)
                                          //   OR a plain JS array of floats (encoding == float-array)
  },

  "structures": [
    { "type": 0, "pos": [10, 0, -5], "halfSize": [4,3,4], "color": [0.38,0.36,0.33], "rot": 0 },
    // type IDs match renderer.js:
    //   0 = interior  1 = tower  2 = generator  3 = turret  4 = station  5 = rock
  ],

  "gameplay": {
    "flags": [
      { "team": 0, "pos": [-100, 30, -50] },
      { "team": 1, "pos": [ 100, 30,  50] }
    ],
    "spawns": [
      { "team": 0, "pos": [-95, 30, -45] },   // optional; falls back to flag±random
      { "team": 1, "pos": [ 95, 30,  45] }
    ],
    "stations": [                              // inventory stations (visual hint; gameplay uses structure type 4)
      { "team": 0, "pos": [-90, 30, -50] }
    ]
  },

  "atmosphere": {
    "skyTopColor":   "#9bb5d6",
    "skyHorizColor": "#cfe0ee",
    "sunAngleDeg":   55,                       // elevation above horizon
    "sunAzimuthDeg": 200,                      // compass bearing of the sun
    "fogColor":      "#a8b8c8",
    "fogDensity":    0.0008,
    "ambient":       0.45                      // hemi light intensity (0..1.5)
  }
}
```

## Sizing

- A 256×256 Int16 heightmap base64-encoded is ≈175 KB — fits well under the 500 KB total target for the three launch maps.
- The full document gzipped (HTTP transport encoding) is typically 30–60 KB per map.
- Raw `float-array` encoding is permitted for the editor's working state but should be re-encoded as `int16-base64` before publish to keep file sizes predictable.

## Validation rules

- `schemaVersion` must be `1` (R25). Future revisions will bump and the loader is expected to migrate.
- `terrain.size` must be a power of two between 64 and 512.
- `gameplay.flags` must contain exactly one entry per team (teams 0 and 1).
- Structure positions are clamped to `[-size*worldScale/2 + 10, +size*worldScale/2 - 10]` to leave a 10 m boundary buffer.
- A spawn point that lands inside a structure AABB is silently nudged 5 m along the X axis until clear.

## Server-side honoured fields (R25)

The Bun server in `server/sim.ts` reads `gameplay.flags` (mandatory) and `gameplay.spawns` (optional). It does NOT yet read `terrain` or `structures`; those drive the renderer/editor only. Server collision still runs on the WASM-resident hardcoded Raindance building set when a custom map is loaded, which is a known R25 limitation. R26 will route structures through a new C++ `setMapBuildings(count, packedFloatArray)` export so that custom-map AABBs become authoritative.

## Editor round-trip

`MAP EDITOR` exports the working state as a `float-array` encoded `.tribes-map`. The `tools/genmap.ts` CLI re-encodes float arrays into `int16-base64` for publishing.
