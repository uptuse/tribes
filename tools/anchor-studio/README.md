# Anchor Studio

A browser-based reference-point editor for the GLB assets in this repo.

## What it does

You open the page, pick a GLB from the asset tree on the left, click on
the model in the 3D viewport to drop a named anchor (muzzle, grip, hand
target, jet exhaust, anything), and download a sidecar `*.refs.json`
that you commit alongside the GLB. Game code reads the JSON at runtime
and uses the anchors as positions, attachment points, IK targets, FX
origins, etc.

The whole tool is a single static HTML page. No build step. No backend.
It pulls GLBs straight from `https://raw.githubusercontent.com/uptuse/tribes/master/...`
and lists assets via the GitHub contents API.

## Why this exists

Tuning a GLB's placement, muzzle, grip, or hand-IK target by hand
("position.set(0.05, -0.06, -0.32)…") is guess-and-check. Each round trip
with Claude burns iterations. With anchors:

- **You** click on the muzzle once. The JSON has a named coordinate.
- **Claude** reads `getAnchor('muzzle')` from the JSON. No guessing.
- **Both** of you talk about anchors by name, not by coordinates.

## Run it

### Locally
```bash
cd tools/anchor-studio
python3 -m http.server 8080
# open http://localhost:8080
```

### Hosted (recommended)
Serve the `tools/anchor-studio/` folder via GitHub Pages, Vercel, or any
static host. The tool is fully client-side — there is nothing to deploy.

## Output format

For an asset at `assets/weapons/aurora_pulse_blaster.glb`, the tool
writes `aurora_pulse_blaster.refs.json` (you commit it next to the GLB):

```json
{
  "asset": "assets/weapons/aurora_pulse_blaster.glb",
  "version": 1,
  "anchors": {
    "muzzle":     { "p": [0, 0.02, -0.18], "axis": [0, 0, -1] },
    "grip":       { "p": [0, -0.04, 0.02] },
    "sight_front":{ "p": [0, 0.05, -0.10], "note": "front sight bead" }
  }
}
```

- `p` — position in the asset's local coordinate frame (the GLB's root
  scene, before any in-game scale or rotation).
- `axis` (optional) — unit-ish forward direction for things that need
  orientation (a muzzle has a "where the bullet comes out" direction).
- `note` (optional) — free-text reminder, never used by code.

## Reading anchors at runtime

Drop a tiny helper next to your renderer:

```js
// renderer_anchors.js
const _refsCache = new Map();

export async function loadAnchors(assetPath) {
    if (_refsCache.has(assetPath)) return _refsCache.get(assetPath);
    const refsPath = assetPath.replace(/\.glb$/i, '.refs.json');
    const res = await fetch('./' + refsPath);
    if (!res.ok) { _refsCache.set(assetPath, null); return null; }
    const json = await res.json();
    _refsCache.set(assetPath, json.anchors || {});
    return json.anchors || {};
}

export function anchorVector(anchors, name, out = new THREE.Vector3()) {
    const a = anchors?.[name];
    if (!a) return out.set(0,0,0);
    return out.set(a.p[0], a.p[1], a.p[2]);
}

export function anchorObject3D(anchors, name) {
    const a = anchors?.[name];
    if (!a) return null;
    const obj = new THREE.Object3D();
    obj.name = `anchor:${name}`;
    obj.position.set(a.p[0], a.p[1], a.p[2]);
    if (a.axis) {
        obj.lookAt(a.p[0] + a.axis[0], a.p[1] + a.axis[1], a.p[2] + a.axis[2]);
    }
    return obj;
}
```

Then in your loader callback:

```js
loader.load(RAW(asset), async (gltf) => {
    const refs = await loadAnchors(asset);
    if (refs) {
        const muzzle = anchorObject3D(refs, 'muzzle');
        if (muzzle) gltf.scene.add(muzzle);
        window._weaponMuzzleAnchor = muzzle || gltf.scene;
    }
    scene.add(gltf.scene);
});
```

## Hotkeys

| Key | Action |
|---|---|
| `O` | Orbit mode (drag to rotate, gizmo on selected anchor) |
| `P` | Place mode (click to drop a new anchor) |
| `A` | Axis mode (click to set forward direction on selected anchor) |
| `F` | Frame the asset in the camera |
| `G` | Toggle grid + axes helper |
| `Delete` / `Backspace` | Delete selected anchor |

## Persistence

Your work is saved to `localStorage` per asset path, so closing and
reopening the tool brings everything back. The "download" button is
the source of truth for sharing — commit the JSON next to the GLB.

The badge next to each asset in the left tree is amber-green (`●`) when
that asset has anchors saved locally, otherwise it shows the file size.

## Tech

- Three.js 0.161 from unpkg via import map
- Vanilla JS, no framework
- GitHub Contents API + raw.githubusercontent.com (public repo only)
- localStorage for between-session work
- File download for the canonical export

## Adding it to a different repo

Edit the constants at the top of `app.js`:

```js
const REPO   = 'uptuse/tribes';
const BRANCH = 'master';
```

Anything else (asset folder, file extension filter, anchor schema)
is also in `app.js` near the top.
