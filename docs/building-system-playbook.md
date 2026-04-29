# Modular Building System — Playbook

## Architecture

```
catalog.json           → Defines piece types (GLB path, collision shapes, grid size)
layouts.json           → Defines buildings (world position, list of pieces with grid coords)
renderer_buildings.js  → Runtime: loads catalog + layouts, places meshes, registers Rapier colliders
```

## Grid System

- **XZ unit**: 4.0 meters (1 grid cell = 4m × 4m)
- **Y unit**: 4.25 meters (1 floor = 4.25m height)
- Pieces snap to grid positions: `worldPos = buildingOrigin + grid * [4, 4.25, 4]`
- Rotation is 0°, 90°, 180°, or 270° around Y axis

## How to add a new building

1. Edit `assets/buildings/layouts.json`
2. Add a new object to the `buildings` array:
```json
{
  "name": "my-bunker",
  "pos": [worldX, worldY, worldZ],
  "rot": 0,
  "pieces": [
    { "id": "corridor", "grid": [0, 0, 0], "rot": 0 },
    { "id": "room-small", "grid": [0, 0, 1], "rot": 0 }
  ]
}
```
3. `pos` is world coordinates (same as .dis building positions from WASM)
4. `grid` is [x, y, z] in grid units relative to building origin
5. `id` must match a key in `catalog.json → pieces`

## How to add a new piece type

1. Place the .glb file in `assets/buildings/kenney-modular/`
2. Add an entry to `catalog.json → pieces`:
```json
"my-piece": {
  "glb": "my-piece.glb",
  "gridSize": [1, 1, 1],
  "bounds": [4.0, 4.25, 4.0],
  "colliders": [
    { "type": "box", "pos": [0, 0, 0], "size": [4.0, 0.2, 4.0], "role": "floor" }
  ],
  "openings": ["+z", "-z"]
}
```
3. Collider `pos` is relative to piece center. `size` is full size (not half-extents).
4. `role` is for debug coloring: "floor" = green, "ceiling" = blue, "wall" = red
5. `openings` lists which faces have doorways (for future WFC/connectivity validation)

## Available Kenney pieces (Modular Space Kit, CC0)

| Piece ID | Grid Size | Description |
|----------|-----------|-------------|
| corridor | 1×1×1 | Narrow corridor, open +Z/-Z |
| corridor-corner | 1×1×1 | 90° turn |
| corridor-end | 1×1×1 | Dead end (open -Z only) |
| corridor-intersection | 1×1×1 | 4-way crossing |
| corridor-junction | 1×1×1 | T-junction |
| corridor-wide | 2×1×2 | Wide corridor |
| corridor-wide-corner | 2×1×2 | Wide 90° turn |
| corridor-wide-end | 2×1×2 | Wide dead end |
| corridor-wide-intersection | 2×1×2 | Wide 4-way |
| corridor-wide-junction | 2×1×2 | Wide T-junction |
| corridor-transition | 2×1×2 | Narrow-to-wide transition |
| room-small | 3×1×3 | 12m room |
| room-small-variation | 3×1×3 | 12m room alt |
| room-large | 5×1×5 | 20m room |
| room-large-variation | 5×1×5 | 20m room alt |
| room-wide | 5×1×3 | 20×12m room |
| room-wide-variation | 5×1×3 | 20×12m room alt |
| room-corner | 3×1×3 | L-shaped room |
| stairs | 1×2×2 | Staircase (spans 2 floors) |
| stairs-wide | 2×2×2 | Wide staircase |
| gate | 1×1×0 | Gate frame |
| gate-door | 1×1×0 | Gate with door |
| gate-door-window | 1×1×0 | Gate with door + window |
| gate-lasers | 1×1×0 | Gate with laser barrier |

## Collision approach

Each piece defines box colliders for floor, ceiling, and walls. These are registered as Rapier fixed rigid bodies with cuboid shapes. No trimesh needed — all collision is axis-aligned boxes.

For stairs/ramps: currently a single angled box. If that doesn't feel right, replace with a stepped series of thin boxes.

## Visual overlay (Option C)

The Kenney meshes can be hidden (`opts.visible = false` in init). The collision still works. To add Tribes-style visuals:

1. Read the layout data
2. For each piece, generate or place a Tribes-styled mesh at the same position
3. The Kenney collision handles physics; your meshes handle appearance

## Integration with existing code

In `renderer.js`, after Rapier is initialized:
```js
import * as Buildings from './renderer_buildings.js';
await Buildings.init(scene, rapierWorld, RAPIER, { visible: true, debug: false });
```

The buildings group is added to the scene automatically. Toggle visibility:
```js
Buildings.getGroup().visible = false; // hide Kenney visuals
```

## Debug mode

Pass `{ debug: true }` to `init()` to render wireframe boxes at every collider position:
- Green = floor
- Blue = ceiling
- Red = wall
