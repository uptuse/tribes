/* ──────────────────────────────────────────────────────────────────
 * Anchor Studio — terrain.js  (v0.6 Terrain Studio tab)
 *
 * Self-contained terrain editor module. Owns its own THREE scene,
 * renderer, camera, controls, and DOM event wiring. Boots only when
 * the terrain tab is first activated; tab-switch toggles its render
 * loop. Persists state to localStorage["anchor_studio.v2"].terrain.
 *
 * Data model (in localStorage, under .terrain):
 *   {
 *     name:       "untitled",
 *     gridSize:   128,                  // N: vertices per side (N×N)
 *     cellSize:   2,                    // metres per cell
 *     heightmap:  number[N*N],          // float metres, row-major
 *     splat:      [number[N*N], number[N*N], number[N*N]], // grass/rock/snow weights
 *     view:       { tool, brushSize, brushStrength, stamp, wire, view3p1p },
 *     character:  { assetPath?, position?, yaw? } | null
 *   }
 *
 * Export contract — terrain.refs.json:
 *   {
 *     kind: "terrain",
 *     version: 1,
 *     name: "...",
 *     gridSize: N,
 *     cellSize: meters,
 *     extent:   N * cellSize,
 *     heightmap: { encoding: "float-array", data: number[N*N] },
 *     splat:     { layers: ["grass","rock","snow"],
 *                  encoding: "uint8-array-rgb", data: number[N*N*3] }
 *   }
 *
 * Coordinate convention: grid (gx, gz) ∈ [0, N-1].
 *   worldX = (gx - (N-1)/2) * cellSize
 *   worldZ = (gz - (N-1)/2) * cellSize
 *   worldY = heightmap[gz * N + gx]
 * ────────────────────────────────────────────────────────────────── */

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader }    from 'three/addons/loaders/GLTFLoader.js';

/* ── Pointer/navigation philosophy ─────────────────────────────────
 * Mirror the in-game Firewolf shell's mouse mapping (see client/shell.js):
 *   • LEFT button   → reserved for the active tool (paint/sculpt/nav-pan)
 *   • RIGHT button  → orbit (always, regardless of tool)
 *   • MIDDLE button → pan   (always, regardless of tool)
 *   • Wheel         → zoom  (always)
 * Plus hand-tool semantics:
 *   • Tool 'nav'    → LEFT also pans (true hand tool); brush is muted.
 *   • Hold SPACE    → temporary nav (LEFT pans even while a brush is active)
 *   • Hold ALT      → temporary orbit on LEFT
 *   • H key         → toggle nav as the sticky tool
 *   • F key         → frame view
 * OrbitControls receives the LEFT button only when nav is in effect; it
 * always receives RIGHT (rotate) and MIDDLE (pan).
 * ─────────────────────────────────────────────────────────────── */

const STORAGE_KEY  = 'anchor_studio.v2';
const RAW          = (path) => `https://raw.githubusercontent.com/uptuse/tribes/master/${path}`;
const SCHEMA_VER   = 1;

const DEFAULTS = {
    name: 'untitled',
    gridSize: 128,
    cellSize: 2,
    view: {
        tool: 'nav',  // default to hand/nav so the user can orbit immediately
        brushSize: 12,
        brushStrength: 1.5,
        stamp: 'hill',
        wire: false,
        viewMode: 'off',  // 'off' | '3p' | '1p'
    },
    character: null,
};

const LAYER_NAMES = ['grass', 'rock', 'snow'];
const LAYER_COLORS = [
    new THREE.Color(0x6a8c4a),  // grass
    new THREE.Color(0x7a6a55),  // rock
    new THREE.Color(0xeaeef2),  // snow
];

/* ── Persistence ──────────────────────────────────────────────────── */
function loadAllRoot() {
    try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}'); }
    catch { return {}; }
}
function saveAllRoot(s) { localStorage.setItem(STORAGE_KEY, JSON.stringify(s)); }

function loadTerrain() {
    const root = loadAllRoot();
    return root.terrain || null;
}
function saveTerrain(t) {
    const root = loadAllRoot();
    root.terrain = t;
    saveAllRoot(root);
}

/* ── Module-level state ───────────────────────────────────────────── */
let renderer, scene, camera, controls, raycaster, pointer;
let mesh, wireMesh;
let geometry;          // THREE.PlaneGeometry, holds height in attribute Y
let heightmap;         // Float32Array(N*N)
let splat;             // [Float32Array(N*N), Float32Array(N*N), Float32Array(N*N)]
let vertexColorAttr;   // Float32Array attribute for splat-blended vertex colors
let N, CELL;
let stateView = { ...DEFAULTS.view };
let nameStr = DEFAULTS.name;

let charObj = null;          // THREE.Group for character preview
let charAssetPath = null;
let charPos = new THREE.Vector3(0, 0, 0);
let charYaw = 0;

let undoStack = [];
let redoStack = [];
const UNDO_LIMIT = 30;

let booted = false;
let active = false;
let rafHandle = null;
let dirty = false;
let saveDebounce = null;

let els = {};
let dragInfo = null;       // { lastX, lastY, button, isPainting }
let pickedAssetPaths = []; // populated from app.js on demand

/* Modifier-key state. Updated by global keydown/keyup. */
const mods = { space: false, alt: false };

let onTerrainExportRequest = null;  // optional callback hook

/* ── Initial state factory ────────────────────────────────────────── */
function newGrid(gridSize) {
    const total = gridSize * gridSize;
    const h = new Float32Array(total);
    const s = [
        new Float32Array(total),
        new Float32Array(total),
        new Float32Array(total),
    ];
    s[0].fill(1.0);  // default fully grass
    return { h, s };
}

/* ── Resampling when the grid is changed ──────────────────────────── */
function resampleArray(srcArr, srcN, dstN) {
    const dst = new Float32Array(dstN * dstN);
    for (let dy = 0; dy < dstN; dy++) {
        for (let dx = 0; dx < dstN; dx++) {
            const sx = (dx / Math.max(1, dstN - 1)) * (srcN - 1);
            const sy = (dy / Math.max(1, dstN - 1)) * (srcN - 1);
            const x0 = Math.floor(sx), y0 = Math.floor(sy);
            const x1 = Math.min(srcN - 1, x0 + 1);
            const y1 = Math.min(srcN - 1, y0 + 1);
            const fx = sx - x0, fy = sy - y0;
            const a = srcArr[y0 * srcN + x0];
            const b = srcArr[y0 * srcN + x1];
            const c = srcArr[y1 * srcN + x0];
            const d = srcArr[y1 * srcN + x1];
            const top = a * (1 - fx) + b * fx;
            const bot = c * (1 - fx) + d * fx;
            dst[dy * dstN + dx] = top * (1 - fy) + bot * fy;
        }
    }
    return dst;
}

/* ── Mesh build ───────────────────────────────────────────────────── */
function buildMesh() {
    if (mesh) {
        scene.remove(mesh);
        mesh.geometry.dispose();
        mesh.material.dispose();
        mesh = null;
    }
    if (wireMesh) {
        scene.remove(wireMesh);
        wireMesh.geometry.dispose();
        wireMesh.material.dispose();
        wireMesh = null;
    }

    const extent = N * CELL;
    geometry = new THREE.PlaneGeometry(extent, extent, N - 1, N - 1);
    geometry.rotateX(-Math.PI / 2);  // make it horizontal (XZ plane, Y up)

    const total = N * N;
    vertexColorAttr = new Float32Array(total * 3);
    geometry.setAttribute('color', new THREE.BufferAttribute(vertexColorAttr, 3));

    const mat = new THREE.MeshStandardMaterial({
        vertexColors: true,
        roughness: 0.95,
        metalness: 0.0,
        flatShading: false,
    });
    mesh = new THREE.Mesh(geometry, mat);
    mesh.receiveShadow = true;
    scene.add(mesh);

    const wireMat = new THREE.MeshBasicMaterial({
        color: 0x000000,
        wireframe: true,
        transparent: true,
        opacity: 0.18,
    });
    wireMesh = new THREE.Mesh(geometry, wireMat);
    wireMesh.visible = stateView.wire;
    scene.add(wireMesh);

    syncMeshFromArrays();
}

function syncMeshFromArrays() {
    const pos = geometry.attributes.position;
    // PlaneGeometry vertex order matches our (gx, gz) row-major after rotateX.
    // Vertex i is at (gx, gz) = (i % N, Math.floor(i / N)). y attribute = height.
    for (let i = 0; i < N * N; i++) pos.array[i * 3 + 1] = heightmap[i];
    pos.needsUpdate = true;
    geometry.computeVertexNormals();

    // Update vertex colors from splat
    for (let i = 0; i < N * N; i++) {
        let r = 0, g = 0, b = 0;
        let total = splat[0][i] + splat[1][i] + splat[2][i];
        if (total < 1e-4) total = 1;  // fall back to grass
        for (let l = 0; l < 3; l++) {
            const w = (l === 0 && total < 1e-4 ? 1 : splat[l][i] / total);
            r += LAYER_COLORS[l].r * w;
            g += LAYER_COLORS[l].g * w;
            b += LAYER_COLORS[l].b * w;
        }
        vertexColorAttr[i * 3]     = r;
        vertexColorAttr[i * 3 + 1] = g;
        vertexColorAttr[i * 3 + 2] = b;
    }
    geometry.attributes.color.needsUpdate = true;
}

/* ── Brush math ───────────────────────────────────────────────────── */
function gridFromWorld(x, z) {
    const half = (N - 1) * 0.5;
    const gx = (x / CELL) + half;
    const gz = (z / CELL) + half;
    return { gx, gz };
}
function worldFromGrid(gx, gz) {
    const half = (N - 1) * 0.5;
    return { x: (gx - half) * CELL, z: (gz - half) * CELL };
}

/* Smooth radial falloff: 1 at center, 0 at edge. */
function falloff(dist, radius) {
    if (dist >= radius) return 0;
    const t = dist / radius;
    return 0.5 * (1 + Math.cos(Math.PI * t));
}

/* Apply a brush stroke at world (x, z). Returns true if anything changed. */
function applyBrush(x, z, modifiers) {
    const { gx: cx, gz: cz } = gridFromWorld(x, z);
    const radiusCells = stateView.brushSize;
    const strength    = stateView.brushStrength * (modifiers.shift && stateView.tool === 'raise' ? -1 : 1);
    const tool        = stateView.tool;

    const minX = Math.max(0, Math.floor(cx - radiusCells));
    const maxX = Math.min(N - 1, Math.ceil(cx + radiusCells));
    const minZ = Math.max(0, Math.floor(cz - radiusCells));
    const maxZ = Math.min(N - 1, Math.ceil(cz + radiusCells));

    let changed = false;
    let flattenH = null;

    if (tool === 'flatten') {
        // sample center height
        const ix = Math.round(cx), iz = Math.round(cz);
        if (ix >= 0 && ix < N && iz >= 0 && iz < N) {
            flattenH = heightmap[iz * N + ix];
        }
    }

    for (let gz = minZ; gz <= maxZ; gz++) {
        for (let gx = minX; gx <= maxX; gx++) {
            const dx = gx - cx, dz = gz - cz;
            const d  = Math.hypot(dx, dz);
            const k  = falloff(d, radiusCells);
            if (k <= 0) continue;
            const i = gz * N + gx;

            switch (tool) {
                case 'raise':
                case 'lower': {
                    const dir = tool === 'lower' ? -1 : 1;
                    heightmap[i] += dir * strength * k * 0.06;
                    changed = true;
                    break;
                }
                case 'smooth': {
                    let sum = 0, n = 0;
                    for (let oz = -1; oz <= 1; oz++) {
                        for (let ox = -1; ox <= 1; ox++) {
                            const nx = gx + ox, nz = gz + oz;
                            if (nx < 0 || nx >= N || nz < 0 || nz >= N) continue;
                            sum += heightmap[nz * N + nx];
                            n++;
                        }
                    }
                    const target = sum / Math.max(1, n);
                    heightmap[i] += (target - heightmap[i]) * k * Math.min(1, stateView.brushStrength * 0.3);
                    changed = true;
                    break;
                }
                case 'flatten': {
                    if (flattenH !== null) {
                        heightmap[i] += (flattenH - heightmap[i]) * k * Math.min(1, stateView.brushStrength * 0.4);
                        changed = true;
                    }
                    break;
                }
                case 'noise': {
                    const r = (Math.random() - 0.5) * 2;
                    heightmap[i] += r * strength * k * 0.05;
                    changed = true;
                    break;
                }
                case 'paint-grass':
                case 'paint-rock':
                case 'paint-snow': {
                    const layer = tool === 'paint-grass' ? 0 : tool === 'paint-rock' ? 1 : 2;
                    const add = strength * k * 0.05;
                    splat[layer][i] = Math.min(1, splat[layer][i] + add);
                    // Reduce others proportionally so weights stay sane
                    const others = [0, 1, 2].filter(l => l !== layer);
                    for (const l of others) {
                        splat[l][i] = Math.max(0, splat[l][i] - add * 0.5);
                    }
                    changed = true;
                    break;
                }
                case 'stamp': {
                    // Handled separately on click, not on drag
                    break;
                }
            }
        }
    }
    return changed;
}

/* Stamp library: each is a function that returns a delta to add to height
 * inside a square region centered on (cx, cz) with given radius. */
const STAMP_FNS = {
    hill: (dx, dz, r) => {
        const d = Math.hypot(dx, dz);
        if (d >= r) return 0;
        const t = d / r;
        return Math.cos(t * Math.PI * 0.5) * r * 0.3;
    },
    crater: (dx, dz, r) => {
        const d = Math.hypot(dx, dz);
        if (d >= r) return 0;
        const t = d / r;
        // ring up around the rim, dip in the middle
        const ring = Math.exp(-Math.pow((t - 0.85) / 0.18, 2)) * r * 0.18;
        const dip  = -Math.exp(-Math.pow(t / 0.5, 2)) * r * 0.25;
        return ring + dip;
    },
    ridge: (dx, dz, r) => {
        if (Math.abs(dx) >= r) return 0;
        // long thin ridge along z axis
        const t = Math.abs(dx) / r;
        const fade = Math.max(0, 1 - Math.abs(dz) / (r * 1.6));
        return Math.cos(t * Math.PI * 0.5) * r * 0.25 * fade;
    },
};
function applyStamp(x, z) {
    const { gx: cx, gz: cz } = gridFromWorld(x, z);
    const r  = stateView.brushSize;
    const fn = STAMP_FNS[stateView.stamp] || STAMP_FNS.hill;
    const minX = Math.max(0, Math.floor(cx - r * 1.6));
    const maxX = Math.min(N - 1, Math.ceil(cx + r * 1.6));
    const minZ = Math.max(0, Math.floor(cz - r * 1.6));
    const maxZ = Math.min(N - 1, Math.ceil(cz + r * 1.6));
    for (let gz = minZ; gz <= maxZ; gz++) {
        for (let gx = minX; gx <= maxX; gx++) {
            const dx = gx - cx, dz = gz - cz;
            const dh = fn(dx, dz, r) * (stateView.brushStrength * 0.5);
            heightmap[gz * N + gx] += dh;
        }
    }
}

/* ── Undo / redo ──────────────────────────────────────────────────── */
function snapshotPush() {
    const snap = {
        h: new Float32Array(heightmap),
        s: [new Float32Array(splat[0]), new Float32Array(splat[1]), new Float32Array(splat[2])],
    };
    undoStack.push(snap);
    if (undoStack.length > UNDO_LIMIT) undoStack.shift();
    redoStack.length = 0;
    syncUndoCount();
}
function undo() {
    if (undoStack.length < 1) return;
    redoStack.push({
        h: new Float32Array(heightmap),
        s: [new Float32Array(splat[0]), new Float32Array(splat[1]), new Float32Array(splat[2])],
    });
    const snap = undoStack.pop();
    heightmap.set(snap.h);
    for (let l = 0; l < 3; l++) splat[l].set(snap.s[l]);
    syncMeshFromArrays();
    syncStats();
    queueSave();
    syncUndoCount();
}
function redo() {
    if (redoStack.length < 1) return;
    undoStack.push({
        h: new Float32Array(heightmap),
        s: [new Float32Array(splat[0]), new Float32Array(splat[1]), new Float32Array(splat[2])],
    });
    const snap = redoStack.pop();
    heightmap.set(snap.h);
    for (let l = 0; l < 3; l++) splat[l].set(snap.s[l]);
    syncMeshFromArrays();
    syncStats();
    queueSave();
    syncUndoCount();
}
function syncUndoCount() {
    if (els.undoCount) els.undoCount.textContent = `${undoStack.length}/${UNDO_LIMIT}`;
}

/* ── Persistence ──────────────────────────────────────────────────── */
function queueSave() {
    dirty = true;
    if (saveDebounce) clearTimeout(saveDebounce);
    saveDebounce = setTimeout(() => {
        saveTerrain({
            name: nameStr,
            gridSize: N,
            cellSize: CELL,
            heightmap: Array.from(heightmap),
            splat: [Array.from(splat[0]), Array.from(splat[1]), Array.from(splat[2])],
            view: { ...stateView },
            character: charAssetPath ? {
                assetPath: charAssetPath,
                position:  [charPos.x, charPos.y, charPos.z],
                yaw:       charYaw,
            } : null,
        });
        dirty = false;
    }, 600);
}

function loadFromStorageOrFresh() {
    const t = loadTerrain();
    if (t && t.gridSize && t.cellSize && Array.isArray(t.heightmap)) {
        N = t.gridSize;
        CELL = t.cellSize;
        nameStr = t.name || DEFAULTS.name;
        heightmap = Float32Array.from(t.heightmap);
        if (Array.isArray(t.splat) && t.splat.length === 3) {
            splat = t.splat.map(arr => Float32Array.from(arr));
        } else {
            splat = newGrid(N).s;
        }
        if (t.view) stateView = { ...DEFAULTS.view, ...t.view };
        if (t.character) {
            charAssetPath = t.character.assetPath || null;
            if (Array.isArray(t.character.position) && t.character.position.length === 3) {
                charPos.set(...t.character.position);
            }
            charYaw = +t.character.yaw || 0;
        }
    } else {
        N = DEFAULTS.gridSize;
        CELL = DEFAULTS.cellSize;
        const g = newGrid(N);
        heightmap = g.h;
        splat = g.s;
    }
}

/* ── Three.js setup ───────────────────────────────────────────────── */
function initThree(canvas) {
    renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false });
    renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    renderer.setClearColor(0x0c1014);
    renderer.outputColorSpace = THREE.SRGBColorSpace;

    scene = new THREE.Scene();
    scene.fog = new THREE.Fog(0x0c1014, 200, 1200);

    camera = new THREE.PerspectiveCamera(55, 1, 0.1, 4000);
    camera.position.set(120, 90, 160);
    camera.lookAt(0, 0, 0);

    const sun = new THREE.DirectionalLight(0xfff4d8, 1.2);
    sun.position.set(120, 220, 80);
    scene.add(sun);
    const fill = new THREE.HemisphereLight(0xbcd6ff, 0x4a3a25, 0.55);
    scene.add(fill);

    controls = new OrbitControls(camera, canvas);
    controls.target.set(0, 0, 0);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.maxPolarAngle = Math.PI * 0.49;
    controls.screenSpacePanning = true;
    controls.panSpeed = 1.0;
    controls.zoomSpeed = 1.1;
    controls.rotateSpeed = 0.9;
    // In-game-style mouse mapping: LEFT is owned by the tool (we toggle it on
    // dynamically when nav is in effect); RIGHT always orbits; MIDDLE always pans.
    controls.mouseButtons = {
        LEFT:   null,
        MIDDLE: THREE.MOUSE.PAN,
        RIGHT:  THREE.MOUSE.ROTATE,
    };
    controls.touches = { ONE: null, TWO: THREE.TOUCH.DOLLY_PAN };

    raycaster = new THREE.Raycaster();
    pointer   = new THREE.Vector2();

    resize();
    window.addEventListener('resize', resize);
}

function resize() {
    if (!renderer || !active) return;
    const wrap = renderer.domElement.parentElement;
    const w = wrap.clientWidth;
    const h = wrap.clientHeight;
    if (w === 0 || h === 0) return;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
}

/* ── Pointer / brush interaction ──────────────────────────────────── */
function pointerToWorld(ev) {
    const rect = renderer.domElement.getBoundingClientRect();
    pointer.x = ((ev.clientX - rect.left) / rect.width) * 2 - 1;
    pointer.y = -((ev.clientY - rect.top) / rect.height) * 2 + 1;
    raycaster.setFromCamera(pointer, camera);
    const hits = raycaster.intersectObject(mesh, false);
    return hits.length ? hits[0].point : null;
}

/* Decide what a left-drag means right now: 'nav-pan', 'nav-orbit', or 'paint'.
 * Right and middle buttons are always nav (handled by OrbitControls directly). */
function resolveLeftAction() {
    if (mods.alt)            return 'nav-orbit';
    if (mods.space)          return 'nav-pan';
    if (stateView.tool === 'nav') return 'nav-pan';
    return 'paint';
}

/* Toggle whether OrbitControls owns the LEFT button. */
function setLeftMouseToControls(action) {
    if (!controls) return;
    if (action === 'nav-pan')   controls.mouseButtons.LEFT = THREE.MOUSE.PAN;
    else if (action === 'nav-orbit') controls.mouseButtons.LEFT = THREE.MOUSE.ROTATE;
    else                        controls.mouseButtons.LEFT = null;
}

function updateCanvasCursor() {
    if (!els.canvas) return;
    let c = 'crosshair';
    if (mods.alt)             c = 'grab';
    else if (mods.space)      c = 'grab';
    else if (stateView.tool === 'nav') c = 'grab';
    els.canvas.style.cursor = c;
}

function onPointerDown(ev) {
    if (!active) return;
    // Right and middle: let OrbitControls handle entirely.
    if (ev.button === 1 || ev.button === 2) return;
    if (ev.button !== 0) return;

    const action = resolveLeftAction();
    setLeftMouseToControls(action);
    if (action !== 'paint') {
        // Nav drag — give the cursor a grabbing hint.
        if (els.canvas) els.canvas.style.cursor = 'grabbing';
        return;  // do NOT preventDefault; OrbitControls needs the event
    }

    // Painting path:
    if (charObj && stateView.viewMode === '1p') return;  // disable sculpt in 1p
    const wp = pointerToWorld(ev);
    if (!wp) return;
    snapshotPush();
    if (stateView.tool === 'stamp') {
        applyStamp(wp.x, wp.z);
        syncMeshFromArrays();
        syncStats();
        queueSave();
        return;
    }
    dragInfo = { lastX: wp.x, lastZ: wp.z, shift: ev.shiftKey };
    applyBrush(wp.x, wp.z, { shift: ev.shiftKey });
    syncMeshFromArrays();
    syncStats();
}
function onPointerMove(ev) {
    if (!active) return;
    if (!dragInfo) {
        // hover readout
        const wp = pointerToWorld(ev);
        if (wp && els.hudCoords) {
            els.hudCoords.textContent = `x ${wp.x.toFixed(1)}m · z ${wp.z.toFixed(1)}m · h ${wp.y.toFixed(1)}m`;
        }
        return;
    }
    const wp = pointerToWorld(ev);
    if (!wp) return;
    // stroke between last and current point
    const dx = wp.x - dragInfo.lastX;
    const dz = wp.z - dragInfo.lastZ;
    const dist = Math.hypot(dx, dz);
    const stepPx = Math.max(1, stateView.brushSize * CELL * 0.4);
    const steps = Math.max(1, Math.ceil(dist / stepPx));
    for (let i = 1; i <= steps; i++) {
        const t = i / steps;
        applyBrush(dragInfo.lastX + dx * t, dragInfo.lastZ + dz * t, { shift: dragInfo.shift });
    }
    dragInfo.lastX = wp.x;
    dragInfo.lastZ = wp.z;
    syncMeshFromArrays();
    syncStats();
}
function onPointerUp() {
    if (dragInfo) {
        dragInfo = null;
        queueSave();
    }
    updateCanvasCursor();
}

/* ── Stats / readouts ─────────────────────────────────────────────── */
function syncStats() {
    if (!els.hRead || !els.splatRead || !els.stats) return;
    let minH = Infinity, maxH = -Infinity;
    let s0 = 0, s1 = 0, s2 = 0;
    for (let i = 0; i < N * N; i++) {
        const h = heightmap[i];
        if (h < minH) minH = h;
        if (h > maxH) maxH = h;
        s0 += splat[0][i]; s1 += splat[1][i]; s2 += splat[2][i];
    }
    if (!isFinite(minH)) { minH = 0; maxH = 0; }
    const total = Math.max(1, s0 + s1 + s2);
    els.hRead.textContent = `${minH.toFixed(2)} · ${maxH.toFixed(2)} m`;
    els.splatRead.textContent = `grass ${Math.round(100 * s0 / total)}% · rock ${Math.round(100 * s1 / total)}% · snow ${Math.round(100 * s2 / total)}%`;
    els.stats.textContent = `${N}×${N} · ${(N * CELL).toFixed(0)}m · ${stateView.tool}`;
    if (els.hudTool) els.hudTool.textContent = `${stateView.tool} · ${stateView.brushSize} · ${stateView.brushStrength.toFixed(2)}`;
    if (els.worldCount) els.worldCount.textContent = `${(N * CELL).toFixed(0)}m`;
    if (els.extentReadout) els.extentReadout.textContent = `${(N * CELL).toFixed(0)} × ${(N * CELL).toFixed(0)} m`;
    syncExportPreview();
}

/* ── Export ───────────────────────────────────────────────────────── */
function buildExportObject() {
    // Quantize splat to uint8 RGB for a more compact export.
    const total = N * N;
    const splatU8 = new Array(total * 3);
    for (let i = 0; i < total; i++) {
        const sum = Math.max(1e-4, splat[0][i] + splat[1][i] + splat[2][i]);
        splatU8[i * 3]     = Math.round(255 * splat[0][i] / sum);
        splatU8[i * 3 + 1] = Math.round(255 * splat[1][i] / sum);
        splatU8[i * 3 + 2] = Math.round(255 * splat[2][i] / sum);
    }
    return {
        kind: 'terrain',
        version: SCHEMA_VER,
        name: nameStr,
        gridSize: N,
        cellSize: CELL,
        extent: N * CELL,
        heightmap: { encoding: 'float-array', data: Array.from(heightmap, v => +v.toFixed(4)) },
        splat: { layers: LAYER_NAMES, encoding: 'uint8-array-rgb', data: splatU8 },
    };
}
function syncExportPreview() {
    if (!els.exportPreview) return;
    // Show a redacted version (no giant arrays) for the on-screen preview.
    const obj = buildExportObject();
    const preview = {
        ...obj,
        heightmap: { ...obj.heightmap, data: `[${obj.heightmap.data.length} floats]` },
        splat:     { ...obj.splat,     data: `[${obj.splat.data.length} u8 (rgb)]` },
    };
    els.exportPreview.textContent = JSON.stringify(preview, null, 2);
}

function downloadExport() {
    const obj = buildExportObject();
    const blob = new Blob([JSON.stringify(obj)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${(nameStr || 'terrain').replace(/[^a-z0-9_-]/gi, '_')}.terrain.refs.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function copyExport() {
    const obj = buildExportObject();
    navigator.clipboard.writeText(JSON.stringify(obj, null, 2));
}
function importFromFile(file) {
    const reader = new FileReader();
    reader.onload = (e) => {
        try {
            const obj = JSON.parse(e.target.result);
            if (obj.kind !== 'terrain') throw new Error('not a terrain file');
            snapshotPush();
            N    = obj.gridSize;
            CELL = obj.cellSize;
            nameStr = obj.name || nameStr;
            heightmap = Float32Array.from(obj.heightmap.data);
            if (obj.splat?.encoding === 'uint8-array-rgb') {
                const total = N * N;
                splat = [new Float32Array(total), new Float32Array(total), new Float32Array(total)];
                for (let i = 0; i < total; i++) {
                    splat[0][i] = (obj.splat.data[i * 3]     || 0) / 255;
                    splat[1][i] = (obj.splat.data[i * 3 + 1] || 0) / 255;
                    splat[2][i] = (obj.splat.data[i * 3 + 2] || 0) / 255;
                }
            } else {
                splat = newGrid(N).s;
            }
            buildMesh();
            syncStats();
            queueSave();
        } catch (err) {
            console.error('Terrain import failed:', err);
            alert('Could not import: ' + err.message);
        }
    };
    reader.readAsText(file);
}

/* ── World resize / resample ──────────────────────────────────────── */
function applyWorldChange(newGridSize, newCellSize) {
    if (newGridSize === N && newCellSize === CELL) return;
    snapshotPush();
    if (newGridSize !== N) {
        const nh = resampleArray(heightmap, N, newGridSize);
        const ns = splat.map(arr => resampleArray(arr, N, newGridSize));
        N = newGridSize;
        heightmap = nh;
        splat = ns;
    }
    CELL = newCellSize;
    buildMesh();
    syncStats();
    queueSave();
    frame();
}

/* ── Frame the view ──────────────────────────────────────────────── */
function frame() {
    const extent = N * CELL;
    const dist = extent * 0.9;
    camera.position.set(dist * 0.6, dist * 0.5, dist * 0.6);
    controls.target.set(0, 0, 0);
    camera.updateProjectionMatrix();
}

/* ── Character preview ───────────────────────────────────────────── */
const _gltfLoader = new GLTFLoader();

async function loadCharacter(assetPath) {
    if (!assetPath) return;
    try {
        const gltf = await _gltfLoader.loadAsync(RAW(assetPath));
        if (charObj) {
            scene.remove(charObj);
        }
        charObj = gltf.scene;
        // Apply per-asset scale from the anchor-side store, if present
        const root = loadAllRoot();
        const s = root.byAsset?.[assetPath]?.scale ?? 1.0;
        charObj.scale.setScalar(s);
        scene.add(charObj);
        charAssetPath = assetPath;
        if (charPos.length() === 0) {
            // Place at origin on the terrain surface
            charPos.set(0, sampleHeight(0, 0), 0);
        }
        applyCharTransform();
        if (els.charRow) els.charRow.hidden = false;
        if (els.viewToggle) els.viewToggle.hidden = false;
        if (els.charName) els.charName.textContent = assetPath.split('/').pop();
        if (els.charHint) els.charHint.hidden = false;
        queueSave();
    } catch (err) {
        console.error('Failed to load character:', err);
        alert('Could not load character: ' + err.message);
    }
}
function clearCharacter() {
    if (charObj) {
        scene.remove(charObj);
        charObj = null;
    }
    charAssetPath = null;
    if (els.charRow) els.charRow.hidden = true;
    if (els.viewToggle) els.viewToggle.hidden = true;
    if (els.charHint) els.charHint.hidden = true;
    stateView.viewMode = 'off';
    syncViewToggle();
    queueSave();
}
function sampleHeight(x, z) {
    const { gx, gz } = gridFromWorld(x, z);
    const ix = Math.max(0, Math.min(N - 1, Math.round(gx)));
    const iz = Math.max(0, Math.min(N - 1, Math.round(gz)));
    return heightmap[iz * N + ix];
}
function applyCharTransform() {
    if (!charObj) return;
    charPos.y = sampleHeight(charPos.x, charPos.z);
    charObj.position.copy(charPos);
    charObj.rotation.y = charYaw;
}

/* WASD walk + view toggle */
const keys = new Set();
let walkLastTime = 0;
function tickWalk(dt) {
    if (!charObj) return;
    if (stateView.viewMode === 'off') return;
    const speed = 6.0; // m/s
    let dx = 0, dz = 0;
    if (keys.has('w')) dz -= 1;
    if (keys.has('s')) dz += 1;
    if (keys.has('a')) dx -= 1;
    if (keys.has('d')) dx += 1;
    if (dx !== 0 || dz !== 0) {
        const yaw = controls.getAzimuthalAngle();
        const cos = Math.cos(yaw), sin = Math.sin(yaw);
        const wx = dx * cos + dz * sin;
        const wz = -dx * sin + dz * cos;
        const len = Math.hypot(wx, wz) || 1;
        charPos.x += (wx / len) * speed * dt;
        charPos.z += (wz / len) * speed * dt;
        charYaw = Math.atan2(-wx, -wz);
    }
    applyCharTransform();
    if (stateView.viewMode === '3p') {
        const back = 4.0, up = 2.5;
        const yaw = controls.getAzimuthalAngle();
        controls.target.copy(charPos).y += 1.4;
        camera.position.set(
            charPos.x + Math.sin(yaw) * back,
            charPos.y + up,
            charPos.z + Math.cos(yaw) * back,
        );
    } else if (stateView.viewMode === '1p') {
        const eye = 1.65;
        const yaw = controls.getAzimuthalAngle();
        camera.position.set(charPos.x, charPos.y + eye, charPos.z);
        controls.target.set(
            charPos.x - Math.sin(yaw) * 5,
            charPos.y + eye,
            charPos.z - Math.cos(yaw) * 5,
        );
    }
}

/* ── Render loop ──────────────────────────────────────────────────── */
function loop(t) {
    if (!active) { rafHandle = null; return; }
    rafHandle = requestAnimationFrame(loop);
    const dt = walkLastTime ? Math.min(0.05, (t - walkLastTime) / 1000) : 0;
    walkLastTime = t;
    controls.update();
    tickWalk(dt);
    renderer.render(scene, camera);
}

/* ── DOM wiring ──────────────────────────────────────────────────── */
function gatherEls() {
    const $ = (id) => document.getElementById(id);
    els = {
        canvas:       $('ter-viewport'),
        title:        $('ter-title'),
        stats:        $('ter-stats'),
        hudCoords:    $('ter-hud-coords'),
        hudTool:      $('ter-hud-tool'),

        gridSize:     $('ter-grid-size'),
        cellSize:     $('ter-cell-size'),
        extentReadout:$('ter-extent-readout'),
        applyWorld:   $('ter-apply-world'),
        worldCount:   $('terrain-world-count'),
        toolBar:      $('ter-tools'),
        brushSize:    $('ter-brush-size'),
        brushSizeR:   $('ter-brush-size-readout'),
        brushStr:     $('ter-brush-strength'),
        brushStrR:    $('ter-brush-strength-readout'),
        stampDivider: $('ter-stamp-divider'),
        stamps:       $('ter-stamps'),
        btnUndo:      $('ter-btn-undo'),
        btnRedo:      $('ter-btn-redo'),
        btnFrame:     $('ter-btn-frame'),
        btnWire:      $('ter-btn-wire'),
        nameInput:    $('ter-name'),
        hRead:        $('ter-h-readout'),
        splatRead:    $('ter-splat-readout'),
        exportPreview:$('ter-export-preview'),
        btnCopy:      $('ter-btn-copy'),
        btnDownload:  $('ter-btn-download'),
        importFile:   $('ter-import-file'),
        btnClear:     $('ter-btn-clear'),
        undoCount:    $('ter-undo-count'),
        charPick:     $('ter-char-pick'),
        charRow:      $('ter-char-row'),
        charName:     $('ter-char-name'),
        charClear:    $('ter-char-clear'),
        viewToggle:   $('ter-view-toggle'),
        charHint:     $('ter-char-hint'),
        navHint:      $('ter-nav-hint'),
        terMain:      document.querySelector('main[data-tab="terrain"]'),
    };
}

function syncToolbarUI() {
    els.toolBar?.querySelectorAll('[data-ter-tool]').forEach(b => {
        b.classList.toggle('active', b.dataset.terTool === stateView.tool);
    });
    els.stamps?.querySelectorAll('[data-ter-stamp]').forEach(b => {
        b.classList.toggle('active', b.dataset.terStamp === stateView.stamp);
    });
    const showStamps = stateView.tool === 'stamp';
    if (els.stampDivider) els.stampDivider.hidden = !showStamps;
    if (els.stamps)       els.stamps.hidden       = !showStamps;
    els.brushSize.value = stateView.brushSize;
    els.brushStr.value  = stateView.brushStrength;
    els.brushSizeR.textContent = String(stateView.brushSize);
    els.brushStrR.textContent  = stateView.brushStrength.toFixed(2);
    els.gridSize.value = String(N);
    els.cellSize.value = String(CELL);
    els.nameInput.value = nameStr;
    if (els.btnWire) els.btnWire.classList.toggle('active', !!stateView.wire);
}
function syncViewToggle() {
    els.viewToggle?.querySelectorAll('[data-ter-view]').forEach(b => {
        b.classList.toggle('active', b.dataset.terView === stateView.viewMode);
    });
    if (stateView.viewMode === 'off') {
        // restore freelook
        controls.enableRotate = true;
        controls.enablePan = true;
    } else {
        controls.enableRotate = true;
        controls.enablePan = false;
    }
}

function syncToolStateExtras() {
    // Keep the LEFT-button mapping fresh whenever the tool changes (without a drag),
    // so e.g. a single click in nav mode pans on press rather than after first move.
    setLeftMouseToControls(resolveLeftAction());
    updateCanvasCursor();
    if (els.navHint) {
        const tool = stateView.tool;
        if (tool === 'nav') {
            els.navHint.textContent = 'drag = pan · right-drag = orbit · wheel = zoom · H toggles nav';
        } else {
            els.navHint.textContent = `${tool} · right-drag orbit · middle-drag pan · Space-drag pan · Alt-drag orbit · wheel zoom`;
        }
    }
}

function wire() {
    // Tool buttons
    els.toolBar?.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-ter-tool]');
        if (!btn) return;
        stateView.tool = btn.dataset.terTool;
        syncToolbarUI();
        syncToolStateExtras();
        syncStats();
        queueSave();
    });
    els.stamps?.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-ter-stamp]');
        if (!btn) return;
        stateView.stamp = btn.dataset.terStamp;
        syncToolbarUI();
        queueSave();
    });
    // Brush sliders
    const onSize = () => {
        stateView.brushSize = +els.brushSize.value;
        els.brushSizeR.textContent = String(stateView.brushSize);
        syncStats();
        queueSave();
    };
    const onStr = () => {
        stateView.brushStrength = +els.brushStr.value;
        els.brushStrR.textContent = stateView.brushStrength.toFixed(2);
        syncStats();
        queueSave();
    };
    els.brushSize.addEventListener('input', onSize);
    els.brushStr.addEventListener('input', onStr);
    // World controls
    els.applyWorld.addEventListener('click', () => {
        const newN = Math.max(8, Math.min(1024, +els.gridSize.value | 0));
        const newC = Math.max(0.25, +els.cellSize.value);
        applyWorldChange(newN, newC);
    });
    els.gridSize.addEventListener('change', () => {
        const ext = (+els.gridSize.value) * (+els.cellSize.value);
        els.extentReadout.textContent = `${ext.toFixed(0)} × ${ext.toFixed(0)} m`;
    });
    els.cellSize.addEventListener('input', () => {
        const ext = (+els.gridSize.value) * (+els.cellSize.value);
        els.extentReadout.textContent = `${ext.toFixed(0)} × ${ext.toFixed(0)} m`;
    });
    // Toolbar
    els.btnUndo.addEventListener('click', undo);
    els.btnRedo.addEventListener('click', redo);
    els.btnFrame.addEventListener('click', frame);
    els.btnWire.addEventListener('click', () => {
        stateView.wire = !stateView.wire;
        if (wireMesh) wireMesh.visible = stateView.wire;
        syncToolbarUI();
        queueSave();
    });
    // Name
    els.nameInput.addEventListener('input', () => {
        nameStr = els.nameInput.value;
        syncStats();
        queueSave();
    });
    // Export
    els.btnCopy.addEventListener('click', copyExport);
    els.btnDownload.addEventListener('click', downloadExport);
    els.importFile.addEventListener('change', (e) => {
        const f = e.target.files?.[0];
        if (f) importFromFile(f);
        e.target.value = '';
    });
    els.btnClear.addEventListener('click', () => {
        if (!confirm('Clear terrain to a flat grass plane?')) return;
        snapshotPush();
        const g = newGrid(N);
        heightmap.set(g.h);
        for (let l = 0; l < 3; l++) splat[l].set(g.s[l]);
        syncMeshFromArrays();
        syncStats();
        queueSave();
    });
    // Character
    els.charPick.addEventListener('click', async () => {
        const path = await pickCharacterAssetPath();
        if (path) loadCharacter(path);
    });
    els.charClear.addEventListener('click', clearCharacter);
    els.viewToggle?.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-ter-view]');
        if (!btn) return;
        stateView.viewMode = btn.dataset.terView;
        syncViewToggle();
        queueSave();
    });
    // Pointer
    els.canvas.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
    // Suppress the browser context menu so right-drag-to-orbit feels right.
    els.canvas.addEventListener('contextmenu', (e) => { e.preventDefault(); });
    // Keys
    window.addEventListener('keydown', (e) => {
        if (!active) return;
        const tag = (e.target.tagName || '').toLowerCase();
        if (tag === 'input' || tag === 'textarea' || tag === 'select') return;
        if (e.key === 'z' && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            if (e.shiftKey) redo(); else undo();
        } else if (e.key === '[') {
            stateView.brushSize = Math.max(1, stateView.brushSize - 1);
            syncToolbarUI(); syncStats(); queueSave();
        } else if (e.key === ']') {
            stateView.brushSize = Math.min(64, stateView.brushSize + 1);
            syncToolbarUI(); syncStats(); queueSave();
        } else if (e.key.toLowerCase() === 'f') {
            frame();
        } else if (e.key.toLowerCase() === 'h') {
            // Toggle the sticky nav (hand) tool
            stateView.tool = (stateView.tool === 'nav') ? 'raise' : 'nav';
            syncToolbarUI();
            syncToolStateExtras();
            syncStats();
            queueSave();
        } else if (e.code === 'Space') {
            // Hold-space → temporary nav-pan
            if (!mods.space) {
                mods.space = true;
                e.preventDefault();
                syncToolStateExtras();
            }
        } else if (e.key === 'Alt') {
            if (!mods.alt) { mods.alt = true; syncToolStateExtras(); }
        } else if (['w','a','s','d'].includes(e.key.toLowerCase())) {
            keys.add(e.key.toLowerCase());
        }
    });
    window.addEventListener('keyup', (e) => {
        if (['w','a','s','d'].includes(e.key.toLowerCase())) keys.delete(e.key.toLowerCase());
        if (e.code === 'Space') { mods.space = false; syncToolStateExtras(); }
        if (e.key === 'Alt')    { mods.alt   = false; syncToolStateExtras(); }
    });
    // If the window loses focus mid-drag, drop modifier state to avoid sticky pan.
    window.addEventListener('blur', () => {
        mods.space = false;
        mods.alt = false;
        if (active) syncToolStateExtras();
    });
}

/* ── Character picker — defer to a UI provided by app.js ─────────── */
async function pickCharacterAssetPath() {
    // Use a simple prompt with the list of asset paths that look like
    // characters. The host app can pass its known-asset list via setAssetList().
    const list = pickedAssetPaths.length
        ? pickedAssetPaths
        : ['assets/glb/auric_phoenix_rigged.glb',
           'assets/glb/cosmic_specter_rigged.glb'];
    const candidates = list.filter(p => /(rigged|character|player)/i.test(p));
    if (candidates.length === 0) {
        alert('No rigged character assets found in the library.\n(Anchors tab: open Library to populate the list, then return.)');
        return null;
    }
    if (candidates.length === 1) return candidates[0];
    const labels = candidates.map((p, i) => `${i + 1}. ${p.split('/').pop()}`).join('\n');
    const ans = prompt(`Pick a character (1–${candidates.length}):\n${labels}`, '1');
    const idx = (parseInt(ans, 10) || 0) - 1;
    return candidates[idx] || null;
}

/* ── Public API ──────────────────────────────────────────────────── */
export function bootTerrain() {
    if (booted) return;
    booted = true;
    gatherEls();
    if (!els.canvas) {
        console.warn('[terrain] missing #ter-viewport canvas, refusing to boot');
        return;
    }
    loadFromStorageOrFresh();
    initThree(els.canvas);
    buildMesh();
    syncToolbarUI();
    syncStats();
    syncUndoCount();
    syncViewToggle();
    wire();
    syncToolStateExtras();
    if (charAssetPath) loadCharacter(charAssetPath);
    frame();
}

export function activateTerrain() {
    active = true;
    if (!booted) bootTerrain();
    walkLastTime = 0;
    resize();
    if (rafHandle == null) rafHandle = requestAnimationFrame(loop);
}
export function deactivateTerrain() {
    active = false;
    if (rafHandle) {
        cancelAnimationFrame(rafHandle);
        rafHandle = null;
    }
}

/* Called by app.js when the asset library has populated, so the
 * character picker can offer real options. */
export function setAssetList(paths) {
    if (Array.isArray(paths)) pickedAssetPaths = paths;
}
