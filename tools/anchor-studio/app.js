/* ──────────────────────────────────────────────────────────────────
 * Anchor Studio — app.js  (v0.2 multi-asset)
 *
 * Scene = list of asset INSTANCES. Each instance is one loaded GLB
 * with its own transform (in scene space) and its own anchor list
 * (in the instance's local space, i.e. the GLB's authored frame).
 *
 * Identity:
 *   - assetPath     stable string ("assets/weapons/aurora.glb")
 *   - instanceId    short uuid; multiple instances of same asset OK
 *
 * Persistence:
 *   - localStorage key STORAGE_KEY:
 *       { byAsset: { [path]: { anchors: [...] } },
 *         scene:   { instances: [{id, assetPath, t, r, s}],
 *                    focusedId } }
 *   - Anchors are stored per-asset-path (not per-instance) because
 *     they describe the asset itself. Multiple instances of the same
 *     asset share one anchor list.
 *
 * Export:
 *   - "download .refs.json" exports the focused asset's anchors as
 *     <asset>.refs.json. (Multi-asset rig.json export is Phase B.)
 * ────────────────────────────────────────────────────────────────── */

import * as THREE from 'three';
import { GLTFLoader }      from 'three/addons/loaders/GLTFLoader.js';
import { OrbitControls }   from 'three/addons/controls/OrbitControls.js';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { bootTerrain, activateTerrain, deactivateTerrain, setAssetList } from './terrain.js?v=20260502-1330';

const REPO   = 'uptuse/tribes';
const BRANCH = 'master';
const RAW    = (path) => `https://raw.githubusercontent.com/${REPO}/${BRANCH}/${path}`;
const API    = (path) => `https://api.github.com/repos/${REPO}/contents/${path}?ref=${BRANCH}`;
const STORAGE_KEY    = 'anchor_studio.v2';
const SCHEMA_VERSION = 1;

/* ── DOM ──────────────────────────────────────────────────────────── */
const $ = (id) => document.getElementById(id);
const els = {
    status:        $('status'),
    refresh:       $('btn-refresh'),
    libraryTree:   $('library-tree'),
    libraryCount:  $('library-count'),
    libraryToggle: $('library-toggle'),
    libraryDrawer: $('library-drawer'),
    assetFilter:   $('asset-filter'),
    sceneTree:     $('scene-tree'),
    sceneCount:    $('scene-count'),
    canvas:        $('viewport'),
    canvasWrap:    $('viewport').parentElement,
    overlay:       $('viewport-overlay'),
    overlayHint:   $('viewport-overlay').querySelector('.overlay-hint'),
    currentName:   $('current-instance-name'),
    currentHint:   $('current-instance-hint'),
    hudCoords:     $('hud-coords'),
    hudAnchor:     $('hud-anchor'),
    btnOrbit:      $('btn-mode-orbit'),
    btnPlace:      $('btn-mode-place'),
    btnAxis:       $('btn-mode-axis'),
    btnFrame:      $('btn-frame'),
    btnGrid:       $('btn-grid'),
    anchorList:    $('anchor-list'),
    anchorCount:   $('anchor-count'),
    inspector:     $('inspector-detail'),
    attachmentBlock: $('attachment-block'),
    attachmentPair:  $('attachment-pair'),
    attModeEdit:     $('att-mode-edit'),
    attRollEdit:     $('att-roll-edit'),
    attRollEditNum:  $('att-roll-edit-num'),
    attRollEditRow:  $('att-roll-edit-row'),
    attDetachBtn:    $('att-detach-btn'),
    anchorName:    $('anchor-name'),
    anchorX:       $('anchor-x'),
    anchorY:       $('anchor-y'),
    anchorZ:       $('anchor-z'),
    anchorHasAxis: $('anchor-has-axis'),
    axisGrid:      $('axis-grid'),
    anchorAx:      $('anchor-ax'),
    anchorAy:      $('anchor-ay'),
    anchorAz:      $('anchor-az'),
    anchorNote:    $('anchor-note'),
    btnDelete:     $('btn-delete-anchor'),
    scaleBanner:   $('asset-scale-banner'),
    scaleRange:    $('asset-scale-range'),
    scaleNum:      $('asset-scale-num'),
    scaleReset:    $('asset-scale-reset'),
    scaleMult:     $('asset-scale-mult'),
    refToggle:     $('asset-ref-toggle'),
    exportPreview: $('export-preview'),
    btnCopy:       $('btn-copy'),
    btnDownload:   $('btn-download'),
    footerTip:     $('footer-tip'),
};

/* ── State ────────────────────────────────────────────────────────── */
const state = {
    assets:       [],     // [{path, name, dir, size, hasRefs}]
    instances:    [],     // [{id, assetPath, name, t:[x,y,z], r:[x,y,z], s, three:Group}]
    focusedId:    null,
    selectedAnchorId: null,
    mode:         'place',
    showGrid:     true,
    exportTab:    'json',
    libraryOpen:  false,
};

/* ── Persistence ──────────────────────────────────────────────────── */
function loadAll() {
    try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}'); }
    catch { return {}; }
}
function saveAll(s) { localStorage.setItem(STORAGE_KEY, JSON.stringify(s)); }

function loadAnchorsForAsset(path) {
    return loadAll().byAsset?.[path]?.anchors ?? [];
}
function saveAnchorsForAsset(path, anchors) {
    const s = loadAll();
    s.byAsset ??= {};
    const prev = s.byAsset[path] || {};
    s.byAsset[path] = { ...prev, anchors, updatedAt: Date.now() };
    saveAll(s);
}
// Per-asset uniform scale (not per-instance). Applies to every loaded
// instance of `path` and is exported in refs.json. Default 1.0.
function loadScaleForAsset(path) {
    const v = loadAll().byAsset?.[path]?.scale;
    return (typeof v === 'number' && isFinite(v) && v > 0) ? v : 1.0;
}
function saveScaleForAsset(path, scale) {
    const s = loadAll();
    s.byAsset ??= {};
    const prev = s.byAsset[path] || {};
    s.byAsset[path] = { ...prev, scale: +scale, updatedAt: Date.now() };
    saveAll(s);
}
// Reference asset: at most one path is marked as the "reference" (scale := 1.0).
// Other assets' scales are interpreted as multiples of the reference's size.
// Stored at top level so it's shared across all assets.
function getReferenceAssetPath() {
    return loadAll().referenceAssetPath || null;
}
function setReferenceAssetPath(path) {
    const s = loadAll();
    if (path == null) delete s.referenceAssetPath;
    else s.referenceAssetPath = path;
    saveAll(s);
}
function loadScene() {
    return loadAll().scene ?? { instances: [], focusedId: null };
}
function saveScene() {
    const s = loadAll();
    s.scene = {
        instances: state.instances.map(i => ({
            id: i.id, assetPath: i.assetPath, name: i.name,
            t: i.t.slice(), r: i.r.slice(), s: i.s,
            attachment: i.attachment ? { ...i.attachment } : null,
        })),
        focusedId: state.focusedId,
    };
    saveAll(s);
}

/* Single source of truth: anchors for an asset are stored once and shared
 * by all instances of that asset. Looked up by assetPath. */
function getAnchorsForFocusedAsset() {
    const inst = focusedInstance();
    return inst ? loadAnchorsForAsset(inst.assetPath) : [];
}
// eslint-disable-next-line no-unused-vars
function setAnchorsForFocusedAsset(anchors) {
    const inst = focusedInstance();
    if (!inst) return;
    saveAnchorsForAsset(inst.assetPath, anchors);
    rebuildAllAnchorVisuals();
}

function focusedInstance() {
    return state.instances.find(i => i.id === state.focusedId) || null;
}
function instanceById(id) {
    return state.instances.find(i => i.id === id) || null;
}
function findAnchorByName(assetPath, name) {
    return loadAnchorsForAsset(assetPath).find(a => a.name === name) || null;
}

/* ── Attachment helpers (Phase B) ─────────────────────────────────
 * Each instance MAY carry instance.attachment = {
 *     parentInstanceId, parentAnchorName, childAnchorName,
 *     rollDeg (0 in v1), extraOffset [0,0,0] in v1
 * }
 * The child's world position is recomputed every frame so its
 * childAnchor coincides with parent's parentAnchor (in world space).
 * Cycle prevention: walking up the chain from `child` must not hit `child`.
 */
function wouldCreateCycle(childId, parentId) {
    let cur = parentId;
    let safety = 32;
    while (cur && safety-- > 0) {
        if (cur === childId) return true;
        const p = instanceById(cur);
        cur = p?.attachment?.parentInstanceId || null;
    }
    return false;
}
const _tmpV3a = new THREE.Vector3();
const _tmpV3b = new THREE.Vector3();
const _tmpV3c = new THREE.Vector3();
const _tmpV3d = new THREE.Vector3();
const _tmpQa  = new THREE.Quaternion();
const _tmpQb  = new THREE.Quaternion();
const _tmpQc  = new THREE.Quaternion();
const _tmpMat = new THREE.Matrix4();

/* Compute child world transform such that:
 *  1. childAnchor.position (in world) == parentAnchor.position (in world)
 *  2. (mode includes 'axis')
 *     childAnchor.axis (in world) is parallel/anti-parallel to parentAnchor.axis (in world)
 *  3. (mode includes 'axis') optional roll around the aligned axis.
 */
function applyAttachmentsTick() {
    const remaining = state.instances.filter(i => i.attachment);
    const resolved = new Set();
    let changed = true;
    while (changed) {
        changed = false;
        for (const child of remaining) {
            if (resolved.has(child.id)) continue;
            const att = child.attachment;
            const parent = instanceById(att.parentInstanceId);
            if (!parent) { resolved.add(child.id); continue; }
            if (parent.attachment && !resolved.has(parent.id)) continue;
            const pa = findAnchorByName(parent.assetPath, att.parentAnchorName);
            const ca = findAnchorByName(child.assetPath,  att.childAnchorName);
            if (!pa || !ca) { resolved.add(child.id); continue; }
            parent.three.updateMatrixWorld(true);

            const wantAxis = (att.mode === 'axis-anti' || att.mode === 'axis-parallel') && pa.axis && ca.axis;
            const sign = (att.mode === 'axis-parallel') ? 1 : -1; // anti by default
            const scale = child.s || 1;
            child.three.scale.setScalar(scale);

            // Step 1: compute desired child quaternion
            if (wantAxis) {
                // Parent axis in world (rotate the local axis by parent's world quaternion)
                parent.three.getWorldQuaternion(_tmpQa);
                _tmpV3a.set(...pa.axis).applyQuaternion(_tmpQa).normalize();      // P_w (parent forward in world)
                // Child's local anchor axis (we'll rotate this into world)
                _tmpV3b.set(...ca.axis).normalize();
                const target = _tmpV3a.clone().multiplyScalar(sign).normalize();   // desired world dir
                // Quaternion that rotates child-local axis (in child local) onto target (world).
                // setFromUnitVectors handles antipodal/colinear cases internally.
                _tmpQb.setFromUnitVectors(_tmpV3b, target);
                // Optional roll around the aligned axis (in world space)
                if (att.rollDeg) {
                    _tmpQc.setFromAxisAngle(target, THREE.MathUtils.degToRad(att.rollDeg));
                    _tmpQb.premultiply(_tmpQc);
                }
                child.three.quaternion.copy(_tmpQb);
            } else {
                child.three.quaternion.identity();
            }
            child.three.updateMatrixWorld(true);

            // Step 2: position child so its anchor coincides with parent's
            // World pos of parent anchor:
            _tmpV3c.set(...pa.p).applyMatrix4(parent.three.matrixWorld);
            // World offset of child anchor relative to child origin (before translation):
            // childAnchor in world space when child.position = (0,0,0):
            // = childRot * (childAnchor.p * scale)
            _tmpV3d.set(...ca.p).multiplyScalar(scale).applyQuaternion(child.three.quaternion);
            child.three.position.copy(_tmpV3c).sub(_tmpV3d);
            child.three.updateMatrixWorld(true);
            resolved.add(child.id);
            changed = true;
        }
    }
}

function attachInstance(childId, parentId, childAnchorName, parentAnchorName, opts = {}) {
    if (childId === parentId) { flashFooter('cannot attach to self'); return; }
    if (wouldCreateCycle(childId, parentId)) { flashFooter('would create cycle'); return; }
    const child  = instanceById(childId);
    const parent = instanceById(parentId);
    if (!child || !parent) return;
    const pa = findAnchorByName(parent.assetPath, parentAnchorName);
    const ca = findAnchorByName(child.assetPath,  childAnchorName);
    let mode = opts.mode || 'position'; // 'position' | 'axis-anti' | 'axis-parallel'
    if (mode !== 'position' && (!pa?.axis || !ca?.axis)) {
        flashFooter('axis mode needs both anchors to have a direction set');
        mode = 'position';
    }
    child.attachment = {
        parentInstanceId: parentId,
        parentAnchorName,
        childAnchorName,
        mode,
        rollDeg: opts.rollDeg || 0,
        extraOffset: [0, 0, 0],
    };
    saveScene();
    rebuildAttachmentLines();
    renderScene();
    syncInspectorFromState();
    flashFooter(`attached ${child.name}.${childAnchorName} → ${parent.name}.${parentAnchorName}`);
}

/* Update an existing attachment in place (mode change, roll change). */
function updateAttachment(childId, patch) {
    const child = instanceById(childId);
    if (!child || !child.attachment) return;
    Object.assign(child.attachment, patch);
    if (child.attachment.mode !== 'position') {
        const parent = instanceById(child.attachment.parentInstanceId);
        const pa = parent && findAnchorByName(parent.assetPath, child.attachment.parentAnchorName);
        const ca = findAnchorByName(child.assetPath, child.attachment.childAnchorName);
        if (!pa?.axis || !ca?.axis) {
            child.attachment.mode = 'position';
            flashFooter('axis mode needs both anchors to have a direction set');
        }
    }
    saveScene();
    syncInspectorFromState();
    renderScene();
}
function detachInstance(childId) {
    const child = instanceById(childId);
    if (!child || !child.attachment) return;
    delete child.attachment;
    saveScene();
    rebuildAttachmentLines();
    renderScene();
    flashFooter(`detached ${child.name}`);
}

/* ── GitHub library ───────────────────────────────────────────────── */
async function listGlbsRecursively(dirPath = 'assets') {
    setStatus('busy', 'listing assets…');
    const out = [];
    async function walk(p) {
        let entries;
        try {
            const res = await fetch(API(p));
            if (!res.ok) throw new Error(res.status);
            entries = await res.json();
        } catch (e) {
            console.warn('[anchor-studio] list failed for', p, e);
            return;
        }
        for (const e of entries) {
            if (e.type === 'dir') await walk(e.path);
            else if (e.type === 'file' && /\.glb$/i.test(e.name)) {
                out.push({ path: e.path, name: e.name,
                           dir: e.path.replace(/\/[^/]+$/, ''), size: e.size });
            }
        }
    }
    await walk(dirPath);
    out.sort((a, b) => a.path.localeCompare(b.path));
    state.assets = out;
    const all = loadAll().byAsset || {};
    for (const a of out) a.hasRefs = !!all[a.path]?.anchors?.length;
    setStatus('ready', `${out.length} assets`);
    els.libraryCount.textContent = out.length;
    return out;
}

function setStatus(level, text) {
    els.status.className = 'status-pill ' + level;
    els.status.textContent = text;
}

/* ── Library tree ─────────────────────────────────────────────────── */
function renderLibrary() {
    const filter = (els.assetFilter.value || '').toLowerCase().trim();
    const visible = filter
        ? state.assets.filter(a => a.path.toLowerCase().includes(filter))
        : state.assets;
    els.libraryTree.innerHTML = '';
    if (!visible.length) {
        els.libraryTree.innerHTML = '<div class="empty">No GLB files found.</div>';
        return;
    }
    const byDir = new Map();
    for (const a of visible) {
        if (!byDir.has(a.dir)) byDir.set(a.dir, []);
        byDir.get(a.dir).push(a);
    }
    for (const [dir, items] of byDir.entries()) {
        const folder = document.createElement('div');
        folder.className = 'tree-folder';
        folder.textContent = dir;
        els.libraryTree.appendChild(folder);
        for (const a of items) {
            const row = document.createElement('div');
            row.className = 'tree-item';
            const inUseCount = state.instances.filter(i => i.assetPath === a.path).length;
            row.innerHTML = `
                <span>${a.name}</span>
                <span class="badge ${a.hasRefs ? 'has-refs' : ''}">${
                    inUseCount > 0 ? ('×' + inUseCount) :
                    (a.hasRefs ? '●' : (Math.round(a.size / 1024) + 'k'))
                }</span>
            `;
            row.title = `Click to add to scene\n${a.path}`;
            row.addEventListener('click', () => addInstance(a.path));
            els.libraryTree.appendChild(row);
        }
    }
}

function toggleLibrary(open) {
    state.libraryOpen = (open === undefined) ? !state.libraryOpen : open;
    els.libraryDrawer.hidden = !state.libraryOpen;
    els.libraryToggle.setAttribute('aria-expanded', state.libraryOpen ? 'true' : 'false');
}
els.libraryToggle.addEventListener('click', () => toggleLibrary());

/* ── Three.js scene ──────────────────────────────────────────────── */
const renderer = new THREE.WebGLRenderer({ canvas: els.canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x14171d);

const pmremGen = new THREE.PMREMGenerator(renderer);
const env = pmremGen.fromScene(new RoomEnvironment(), 0.04);
scene.environment = env.texture;

const camera = new THREE.PerspectiveCamera(35, 1, 0.001, 200);
camera.position.set(1.5, 1.0, 2.0);

scene.add(new THREE.AmbientLight(0xffffff, 0.25));
const keyLight = new THREE.DirectionalLight(0xffffff, 1.6);
keyLight.position.set(3, 4, 2);
scene.add(keyLight);
const rimLight = new THREE.DirectionalLight(0x6db4ff, 0.4);
rimLight.position.set(-3, 1, -2);
scene.add(rimLight);

const grid = new THREE.GridHelper(4, 16, 0x2a3140, 0x1b1f27);
scene.add(grid);
const axesHelper = new THREE.AxesHelper(0.3);
scene.add(axesHelper);

const orbit = new OrbitControls(camera, els.canvas);
orbit.enableDamping = true;
orbit.dampingFactor = 0.08;
orbit.target.set(0, 0.5, 0);

const transformer = new TransformControls(camera, els.canvas);
transformer.size = 0.8;
transformer.addEventListener('dragging-changed', (e) => {
    orbit.enabled = !e.value;
    els.canvas.classList.toggle('dragging', e.value);
});
transformer.addEventListener('objectChange', () => {
    // The transformer may be attached to either an anchor visual or an
    // instance root. Inspect what it owns and write back to state.
    const tgt = transformer.object;
    if (!tgt) return;
    if (tgt._anchorId) {
        // anchor moved (in instance-local space; tgt's parent is instance.group)
        const inst = state.instances.find(i => i.id === tgt._instanceId);
        if (!inst) return;
        const anchors = loadAnchorsForAsset(inst.assetPath);
        const a = anchors.find(x => x.id === tgt._anchorId);
        if (!a) return;
        a.p = [tgt.position.x, tgt.position.y, tgt.position.z].map(n => +n.toFixed(4));
        saveAnchorsForAsset(inst.assetPath, anchors);
        rebuildAnchorVisualsForAsset(inst.assetPath);
        syncInspectorFromState();
    }
});
scene.add(transformer);

// Layer for the amber lines that connect attached anchor pairs.
const attachmentLinesGroup = new THREE.Group();
attachmentLinesGroup.name = 'attachmentLines';
scene.add(attachmentLinesGroup);
function clearAttachmentLines() {
    while (attachmentLinesGroup.children.length) {
        const c = attachmentLinesGroup.children.pop();
        if (c.geometry) c.geometry.dispose();
        if (c.material) c.material.dispose();
    }
}
function rebuildAttachmentLines() {
    clearAttachmentLines();
    for (const child of state.instances) {
        if (!child.attachment) continue;
        const lineMat = new THREE.LineDashedMaterial({
            color: 0xf5a524, dashSize: 0.02, gapSize: 0.012, transparent: true, opacity: 0.85, depthTest: false,
        });
        const geom = new THREE.BufferGeometry().setFromPoints([
            new THREE.Vector3(), new THREE.Vector3(),
        ]);
        const line = new THREE.Line(geom, lineMat);
        line.renderOrder = 999;
        line._childId = child.id;
        attachmentLinesGroup.add(line);
    }
}
function updateAttachmentLines() {
    for (const line of attachmentLinesGroup.children) {
        const child = instanceById(line._childId);
        if (!child || !child.attachment) continue;
        const parent = instanceById(child.attachment.parentInstanceId);
        const pa = parent && findAnchorByName(parent.assetPath, child.attachment.parentAnchorName);
        const ca = findAnchorByName(child.assetPath, child.attachment.childAnchorName);
        if (!parent || !pa || !ca) continue;
        parent.three.updateMatrixWorld(true);
        child.three.updateMatrixWorld(true);
        const pw = new THREE.Vector3(...pa.p).applyMatrix4(parent.three.matrixWorld);
        const cw = new THREE.Vector3(...ca.p).applyMatrix4(child.three.matrixWorld);
        const arr = line.geometry.attributes.position.array;
        arr[0] = pw.x; arr[1] = pw.y; arr[2] = pw.z;
        arr[3] = cw.x; arr[4] = cw.y; arr[5] = cw.z;
        line.geometry.attributes.position.needsUpdate = true;
        line.computeLineDistances();
    }
}

const loader = new GLTFLoader();
const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();

/* ── Instance management ──────────────────────────────────────────── */
async function addInstance(assetPath) {
    setStatus('busy', `loading ${assetPath.split('/').pop()}…`);
    let gltf;
    try {
        gltf = await loader.loadAsync(RAW(assetPath));
    } catch (e) {
        console.error(e);
        setStatus('error', 'load failed');
        flashFooter('failed to load — see console');
        return;
    }
    const id = crypto.randomUUID();
    const wrapper = new THREE.Group();
    wrapper.name = `instance:${id}`;
    wrapper._instanceId = id;
    const inner = gltf.scene;
    inner.traverse(n => {
        if (n.isMesh) { n.frustumCulled = true; n._instanceId = id; }
    });
    wrapper.add(inner);

    // Anchor visuals layer (sibling of inner, inside wrapper, so anchors
    // share the instance's transform)
    const anchorLayer = new THREE.Group();
    anchorLayer.name = 'anchorLayer';
    anchorLayer._isAnchorLayer = true;
    wrapper.add(anchorLayer);

    scene.add(wrapper);

    // Initial position: stagger new instances on +X so they don't pile up
    const offsetX = state.instances.length * 1.0;

    const assetScale = loadScaleForAsset(assetPath);
    const instance = {
        id,
        assetPath,
        name: assetPath.split('/').pop().replace(/\.glb$/i, ''),
        t: [offsetX, 0, 0],
        r: [0, 0, 0],
        s: assetScale, // mirrors per-asset scale; kept on instance for convenience
        three: wrapper,
        innerScene: inner,
        anchorLayer,
    };
    wrapper.position.set(...instance.t);
    wrapper.rotation.set(...instance.r);
    wrapper.scale.setScalar(assetScale);
    state.instances.push(instance);
    state.focusedId = id;
    setStatus('ready', 'loaded');
    els.overlay.classList.add('hidden');

    rebuildAnchorVisualsForAsset(assetPath);
    renderScene();
    renderLibrary();
    renderAnchorList();
    syncInspectorFromState();
    syncScaleBanner();
    saveScene();
    if (state.instances.length === 1) frameAll();
}

function removeInstance(id) {
    const idx = state.instances.findIndex(i => i.id === id);
    if (idx < 0) return;
    const inst = state.instances[idx];
    scene.remove(inst.three);
    disposeNode(inst.three);
    state.instances.splice(idx, 1);
    if (state.focusedId === id) {
        state.focusedId = state.instances[0]?.id || null;
    }
    transformer.detach();
    state.selectedAnchorId = null;
    renderScene();
    renderLibrary();
    renderAnchorList();
    syncInspectorFromState();
    saveScene();
    if (!state.instances.length) {
        els.overlay.classList.remove('hidden');
        els.overlayHint.textContent = 'Open Library and add an asset';
    }
}

function focusInstance(id) {
    state.focusedId = id;
    state.selectedAnchorId = null;
    transformer.detach();
    rebuildAllAnchorVisuals();   // recolor anchors so focused=orange, others=blue
    renderScene();
    renderAnchorList();
    syncInspectorFromState();
    syncScaleBanner();
    saveScene();
}

function disposeNode(root) {
    root.traverse((n) => {
        if (n.geometry) n.geometry.dispose();
        if (n.material) {
            const mats = Array.isArray(n.material) ? n.material : [n.material];
            mats.forEach((m) => {
                for (const k in m) {
                    const v = m[k];
                    if (v && v.isTexture) v.dispose();
                }
                m.dispose();
            });
        }
    });
}

/* ── Scene tree ──────────────────────────────────────────────────── */
function renderScene() {
    els.sceneCount.textContent = state.instances.length;
    els.sceneTree.innerHTML = '';
    if (!state.instances.length) {
        els.sceneTree.innerHTML = '<div class="empty">No assets loaded.<br/>Open the library below to add one.</div>';
        els.currentName.textContent = 'Empty scene';
        els.currentHint.textContent = '';
        return;
    }
    // Build hierarchy: roots first, then children indented under their parents.
    const childrenOf = new Map();
    const roots = [];
    for (const inst of state.instances) {
        if (inst.attachment?.parentInstanceId) {
            const p = inst.attachment.parentInstanceId;
            if (!childrenOf.has(p)) childrenOf.set(p, []);
            childrenOf.get(p).push(inst);
        } else {
            roots.push(inst);
        }
    }
    function addRow(inst, depth) {
        const row = document.createElement('div');
        row.className = 'scene-row' + (inst.id === state.focusedId ? ' focused' : '');
        row.dataset.id = inst.id;
        row.style.paddingLeft = (14 + depth * 16) + 'px';
        const anchorsCount = loadAnchorsForAsset(inst.assetPath).length;
        const linkLabel = inst.attachment
            ? `<span class="scene-row-link" title="attached: ${inst.attachment.childAnchorName} → ${inst.attachment.parentAnchorName}">↳ ${inst.attachment.childAnchorName} → ${inst.attachment.parentAnchorName}</span>`
            : '';
        const refMark = (getReferenceAssetPath() === inst.assetPath)
            ? '<span class="ref-mark" title="reference asset (scale = 1.0)">★</span> ' : '';
        row.innerHTML = `
            <span class="scene-row-name">${refMark}${inst.name}${linkLabel ? ' ' + linkLabel : ''}</span>
            <span class="scene-row-meta">${anchorsCount}</span>
            ${inst.attachment ? '<button class="icon-btn warn" title="Detach">⛓</button>' : '<button class="icon-btn ghost" title="Attach to another asset…">…</button>'}
            <button class="icon-btn danger" title="Remove from scene">×</button>
        `;
        const btns = row.querySelectorAll('.icon-btn');
        // last button is always remove
        btns[btns.length - 1].addEventListener('click', (e) => {
            e.stopPropagation();
            removeInstance(inst.id);
        });
        // first secondary button is attach/detach
        btns[0].addEventListener('click', (e) => {
            e.stopPropagation();
            if (inst.attachment) detachInstance(inst.id);
            else openAttachDialog(inst.id);
        });
        row.addEventListener('click', () => focusInstance(inst.id));
        els.sceneTree.appendChild(row);
        const kids = childrenOf.get(inst.id) || [];
        for (const k of kids) addRow(k, depth + 1);
    }
    for (const r of roots) addRow(r, 0);
    const focused = focusedInstance();
    if (focused) {
        els.currentName.textContent = focused.name;
        els.currentHint.textContent = focused.assetPath;
    }
}

/* ── Attach dialog ───────────────────────────────────────────── */
function openAttachDialog(childId) {
    const child = instanceById(childId);
    if (!child) return;
    const childAnchors = loadAnchorsForAsset(child.assetPath);
    if (!childAnchors.length) {
        flashFooter('place at least one anchor on this asset first');
        return;
    }
    const otherInstances = state.instances.filter(i => i.id !== childId && !wouldCreateCycle(childId, i.id));
    if (!otherInstances.length) {
        flashFooter('add another asset to the scene first');
        return;
    }
    const dlg = document.createElement('div');
    dlg.className = 'modal-backdrop';
    dlg.innerHTML = `
        <div class="modal">
            <h3>Attach <span class="mono">${escapeHtml(child.name)}</span> to…</h3>
            <div class="modal-row">
                <label>this anchor on <b>${escapeHtml(child.name)}</b></label>
                <select id="att-child-anchor">
                    ${childAnchors.map(a => `<option value="${escapeHtml(a.name)}">${escapeHtml(a.name)}</option>`).join('')}
                </select>
            </div>
            <div class="modal-row">
                <label>parent asset</label>
                <select id="att-parent">
                    ${otherInstances.map(i => `<option value="${i.id}">${escapeHtml(i.name)}</option>`).join('')}
                </select>
            </div>
            <div class="modal-row">
                <label>parent anchor</label>
                <select id="att-parent-anchor"></select>
            </div>
            <div class="modal-row">
                <label>alignment</label>
                <select id="att-mode">
                    <option value="position">position only</option>
                    <option value="axis-anti" selected>position + axis (anti-parallel)</option>
                    <option value="axis-parallel">position + axis (parallel)</option>
                </select>
            </div>
            <div class="modal-row" id="att-roll-row">
                <label>roll °</label>
                <div class="slider-pair">
                    <input type="range" id="att-roll" min="-180" max="180" step="1" value="0" />
                    <input type="number" id="att-roll-num" min="-180" max="180" step="1" value="0" />
                </div>
            </div>
            <div class="modal-hint" id="att-mode-hint"></div>
            <div class="modal-actions">
                <button class="btn-ghost" id="att-cancel">cancel</button>
                <button class="btn-primary" id="att-confirm">attach</button>
            </div>
        </div>
    `;
    document.body.appendChild(dlg);
    const parentSel = dlg.querySelector('#att-parent');
    const parentAnchorSel = dlg.querySelector('#att-parent-anchor');
    function refreshParentAnchors() {
        const pid = parentSel.value;
        const p = instanceById(pid);
        const anchors = p ? loadAnchorsForAsset(p.assetPath) : [];
        parentAnchorSel.innerHTML = anchors.length
            ? anchors.map(a => `<option value="${escapeHtml(a.name)}">${escapeHtml(a.name)}</option>`).join('')
            : '<option value="" disabled>no anchors on parent</option>';
    }
    parentSel.addEventListener('change', () => { refreshParentAnchors(); refreshHint(); });
    refreshParentAnchors();

    // Mode picker + roll slider sync
    const modeSel = dlg.querySelector('#att-mode');
    const rollR   = dlg.querySelector('#att-roll');
    const rollN   = dlg.querySelector('#att-roll-num');
    const rollRow = dlg.querySelector('#att-roll-row');
    const hint    = dlg.querySelector('#att-mode-hint');
    const childAnchorSel  = dlg.querySelector('#att-child-anchor');
    function refreshHint() {
        const ca = findAnchorByName(child.assetPath, childAnchorSel.value);
        const p  = instanceById(parentSel.value);
        const pa = p && findAnchorByName(p.assetPath, parentAnchorSel.value);
        const bothHaveAxis = !!(ca?.axis && pa?.axis);
        const mode = modeSel.value;
        rollRow.style.display = (mode === 'position') ? 'none' : '';
        if (mode !== 'position' && !bothHaveAxis) {
            hint.textContent = 'both anchors need a forward direction (Axis mode — press A, click in front of the anchor) for axis alignment';
            hint.classList.add('warn');
        } else if (mode === 'axis-anti') {
            hint.textContent = 'child’s forward will point opposite to parent’s forward (e.g. gun barrel points away from hand)';
            hint.classList.remove('warn');
        } else if (mode === 'axis-parallel') {
            hint.textContent = 'child’s forward will point the same direction as parent’s forward';
            hint.classList.remove('warn');
        } else {
            hint.textContent = 'position only — the child’s anchor lands on the parent’s anchor without rotation';
            hint.classList.remove('warn');
        }
    }
    modeSel.addEventListener('change', refreshHint);
    childAnchorSel.addEventListener('change', refreshHint);
    parentAnchorSel.addEventListener('change', refreshHint);
    rollR.addEventListener('input', () => { rollN.value = rollR.value; });
    rollN.addEventListener('input', () => { rollR.value = rollN.value; });
    refreshHint();

    dlg.querySelector('#att-cancel').addEventListener('click', () => dlg.remove());
    dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.remove(); });
    dlg.querySelector('#att-confirm').addEventListener('click', () => {
        const childAnchor  = childAnchorSel.value;
        const parentId     = parentSel.value;
        const parentAnchor = parentAnchorSel.value;
        if (!childAnchor || !parentId || !parentAnchor) { flashFooter('pick all three'); return; }
        attachInstance(childId, parentId, childAnchor, parentAnchor, {
            mode: modeSel.value,
            rollDeg: parseFloat(rollR.value) || 0,
        });
        dlg.remove();
    });
}

/* ── Anchor visuals (per instance) ───────────────────────────────── */
const anchorMatNormal   = new THREE.MeshBasicMaterial({ color: 0x47d77a, depthTest: false, transparent: true, opacity: 0.95 }); // green = focused asset
const anchorMatSelected = new THREE.MeshBasicMaterial({ color: 0xa6f5be, depthTest: false, transparent: true, opacity: 1.0  }); // light green = selected
const anchorMatDimmed   = new THREE.MeshBasicMaterial({ color: 0xe35d5d, depthTest: false, transparent: true, opacity: 0.65 }); // red = unfocused asset
const anchorGeom = new THREE.SphereGeometry(0.012, 12, 8);

function makeLabelSprite(text, dimmed = false) {
    const fontSize = 28;
    const tmp = document.createElement('canvas');
    const ctxTmp = tmp.getContext('2d');
    ctxTmp.font = `${fontSize}px 'JetBrains Mono', monospace`;
    const metrics = ctxTmp.measureText(text);
    const padX = 18;
    const w = Math.ceil(metrics.width + padX * 2);
    const h = 64;
    const canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = 'rgba(14,16,20,0.85)';
    ctx.fillRect(0, 0, w, h);
    ctx.strokeStyle = dimmed ? 'rgba(227,93,93,0.55)' : 'rgba(71,215,122,0.55)';
    ctx.lineWidth = 1;
    ctx.strokeRect(0.5, 0.5, w - 1, h - 1);
    ctx.font = `${fontSize}px 'JetBrains Mono', monospace`;
    ctx.fillStyle = dimmed ? '#e35d5d' : '#47d77a';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, padX, h / 2 + 2);
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    const mat = new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true });
    const sprite = new THREE.Sprite(mat);
    const aspect = w / h;
    const scaleY = 0.08;
    sprite.scale.set(scaleY * aspect, scaleY, 1);
    return sprite;
}

function makeArrow(direction, color = 0x47d77a, length = 0.18) {
    const arrow = new THREE.ArrowHelper(direction.clone().normalize(),
        new THREE.Vector3(0, 0, 0), length, color,
        length * 0.28, length * 0.16);
    // Float over geometry like the anchor dot does
    arrow.line.material.depthTest = false;
    arrow.line.material.transparent = true;
    arrow.line.renderOrder = 1001;
    arrow.cone.material.depthTest = false;
    arrow.cone.material.transparent = true;
    arrow.cone.renderOrder = 1001;
    return arrow;
}

function clearAnchorLayer(layer) {
    while (layer.children.length) {
        const c = layer.children.pop();
        c.traverse((n) => {
            if (n.isSprite && n.material?.map) n.material.map.dispose();
            if (n.isSprite) n.material?.dispose();
        });
    }
}

function rebuildAnchorVisualsForAsset(assetPath) {
    const insts = state.instances.filter(i => i.assetPath === assetPath);
    const anchors = loadAnchorsForAsset(assetPath);
    for (const inst of insts) {
        clearAnchorLayer(inst.anchorLayer);
        for (const a of anchors) {
            const grp = new THREE.Group();
            grp._anchorId = a.id;
            grp._instanceId = inst.id;
            grp.position.set(...a.p);

            const dimmed = inst.id !== state.focusedId;
            const dot = new THREE.Mesh(anchorGeom,
                a.id === state.selectedAnchorId ? anchorMatSelected
                : dimmed ? anchorMatDimmed : anchorMatNormal);
            dot.renderOrder = 1000;
            dot._dot = true;
            grp.add(dot);

            const sprite = makeLabelSprite(a.name, dimmed);
            sprite.position.set(0, 0.04, 0);
            grp.add(sprite);

            if (a.axis) {
                // Compensate for the parent instance's scale so the arrow has
                // a constant visible size regardless of the model's scale.
                const worldScale = new THREE.Vector3();
                inst.three.getWorldScale(worldScale);
                const sMin = Math.min(worldScale.x, worldScale.y, worldScale.z) || 1;
                // anchor group has no scale of its own, but it inherits from inst.three
                // so we need length that, after parent scale, looks ~0.18 world units.
                const length = 0.18 / sMin;
                const arrow = makeArrow(new THREE.Vector3(...a.axis),
                    dimmed ? 0xe35d5d : 0x47d77a, length);
                grp.add(arrow);
            }
            if (a.id === state.selectedAnchorId) {
                dot.scale.setScalar(1.6);
            }
            inst.anchorLayer.add(grp);
        }
    }
}

function rebuildAllAnchorVisuals() {
    const seen = new Set();
    for (const inst of state.instances) {
        if (seen.has(inst.assetPath)) continue;
        seen.add(inst.assetPath);
        rebuildAnchorVisualsForAsset(inst.assetPath);
    }
}

/* ── Anchor CRUD ─────────────────────────────────────────────────── */
function nextAnchorName(anchors) {
    const taken = new Set(anchors.map(a => a.name));
    let i = 1;
    while (taken.has(`anchor_${i}`)) i++;
    return `anchor_${i}`;
}

function addAnchor(localPoint, opts = {}) {
    const inst = focusedInstance();
    if (!inst) return;
    const anchors = loadAnchorsForAsset(inst.assetPath);
    const a = {
        id:   crypto.randomUUID(),
        name: opts.name || nextAnchorName(anchors),
        p:    [+localPoint.x.toFixed(4), +localPoint.y.toFixed(4), +localPoint.z.toFixed(4)],
    };
    if (opts.axis) a.axis = [...opts.axis].map(n => +n.toFixed(4));
    anchors.push(a);
    saveAnchorsForAsset(inst.assetPath, anchors);
    rebuildAnchorVisualsForAsset(inst.assetPath);
    renderScene();
    selectAnchor(a.id);  // auto-select after place: opens inspector + attaches gizmo
    return a;
}

function deleteAnchor(id) {
    const inst = focusedInstance();
    if (!inst) return;
    const anchors = loadAnchorsForAsset(inst.assetPath).filter(a => a.id !== id);
    saveAnchorsForAsset(inst.assetPath, anchors);
    if (state.selectedAnchorId === id) state.selectedAnchorId = null;
    rebuildAnchorVisualsForAsset(inst.assetPath);
    renderScene();
    renderAnchorList();
    syncInspectorFromState();
}

function selectAnchor(id) {
    state.selectedAnchorId = id;
    const inst = focusedInstance();
    if (inst) rebuildAnchorVisualsForAsset(inst.assetPath);
    renderAnchorList();
    syncInspectorFromState();
    if (state.mode === 'orbit') attachTransformerToSelected();
}

function attachTransformerToSelected() {
    transformer.detach();
    if (!state.selectedAnchorId) return;
    const inst = focusedInstance();
    if (!inst) return;
    const anchorObj = inst.anchorLayer.children.find(g => g._anchorId === state.selectedAnchorId);
    if (anchorObj) transformer.attach(anchorObj);
}

/* ── Inspector ───────────────────────────────────────────────────── */
function renderAnchorList() {
    const inst = focusedInstance();
    const anchors = inst ? loadAnchorsForAsset(inst.assetPath) : [];
    els.anchorCount.textContent = anchors.length;
    els.anchorList.innerHTML = '';
    if (!inst) {
        els.anchorList.innerHTML = '<div class="empty">No asset focused.</div>';
        return;
    }
    if (!anchors.length) {
        els.anchorList.innerHTML = `<div class="empty">No anchors on <b>${inst.name}</b> yet.<br/>Switch to <kbd>place</kbd> and click on the mesh.</div>`;
        return;
    }
    for (const a of anchors) {
        const row = document.createElement('div');
        row.className = 'anchor-row' + (a.id === state.selectedAnchorId ? ' selected' : '');
        row.innerHTML = `
            <span class="swatch"></span>
            <span class="anchor-row-name">${escapeHtml(a.name)}</span>
            <span class="anchor-row-coord">${a.p.map(n => n.toFixed(2)).join(' ')}</span>
        `;
        row.addEventListener('click', () => selectAnchor(a.id));
        els.anchorList.appendChild(row);
    }
}

function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, ch => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[ch]));
}

function renderAttachmentBlock() {
    const inst = focusedInstance();
    if (!inst || !inst.attachment) {
        els.attachmentBlock.hidden = true;
        return;
    }
    const att = inst.attachment;
    const parent = instanceById(att.parentInstanceId);
    if (!parent) { els.attachmentBlock.hidden = true; return; }
    els.attachmentBlock.hidden = false;
    els.attachmentPair.innerHTML = `
        <div class="pair-line">
            <span class="pair-side"><span class="pair-label">child</span>${escapeHtml(inst.name)}.<b>${escapeHtml(att.childAnchorName)}</b></span>
            <span class="pair-arrow">→</span>
            <span class="pair-side"><span class="pair-label">parent</span>${escapeHtml(parent.name)}.<b>${escapeHtml(att.parentAnchorName)}</b></span>
        </div>
    `;
    els.attModeEdit.value   = att.mode || 'position';
    els.attRollEdit.value   = att.rollDeg || 0;
    els.attRollEditNum.value= att.rollDeg || 0;
    els.attRollEditRow.style.display = (att.mode === 'position') ? 'none' : '';
}

function syncInspectorFromState() {
    const inst = focusedInstance();
    const anchors = inst ? loadAnchorsForAsset(inst.assetPath) : [];
    const a = state.selectedAnchorId ? anchors.find(x => x.id === state.selectedAnchorId) : null;
    renderAttachmentBlock();
    if (!a) {
        els.inspector.hidden = true;
        els.hudAnchor.textContent = '—';
        renderExport();
        return;
    }
    els.inspector.hidden = false;
    els.anchorName.value = a.name;
    els.anchorX.value = a.p[0];
    els.anchorY.value = a.p[1];
    els.anchorZ.value = a.p[2];
    els.anchorHasAxis.checked = !!a.axis;
    els.axisGrid.classList.toggle('disabled', !a.axis);
    if (a.axis) {
        els.anchorAx.value = a.axis[0];
        els.anchorAy.value = a.axis[1];
        els.anchorAz.value = a.axis[2];
    } else {
        els.anchorAx.value = els.anchorAy.value = els.anchorAz.value = '';
    }
    els.anchorNote.value = a.note || '';
    els.hudAnchor.textContent = `${inst.name}.${a.name}: ${a.p.map(n => n.toFixed(3)).join(', ')}`;
    renderExport();
}

function commitInspectorEdits() {
    const inst = focusedInstance();
    if (!inst || !state.selectedAnchorId) return;
    const anchors = loadAnchorsForAsset(inst.assetPath);
    const a = anchors.find(x => x.id === state.selectedAnchorId);
    if (!a) return;
    const newName = (els.anchorName.value || '').trim() || a.name;
    a.name = newName;
    a.p = [+els.anchorX.value || 0, +els.anchorY.value || 0, +els.anchorZ.value || 0];
    if (els.anchorHasAxis.checked) {
        a.axis = [+els.anchorAx.value || 0, +els.anchorAy.value || 0, +els.anchorAz.value || 0];
    } else {
        delete a.axis;
    }
    const note = els.anchorNote.value.trim();
    if (note) a.note = note; else delete a.note;
    saveAnchorsForAsset(inst.assetPath, anchors);
    rebuildAnchorVisualsForAsset(inst.assetPath);
    renderAnchorList();
    renderExport();
}

['anchorName','anchorX','anchorY','anchorZ','anchorAx','anchorAy','anchorAz','anchorNote'].forEach(k => {
    els[k].addEventListener('change', commitInspectorEdits);
    els[k].addEventListener('input', () => {
        // live update during typing, lighter than full commit
        const inst = focusedInstance();
        if (!inst || !state.selectedAnchorId) return;
        const anchors = loadAnchorsForAsset(inst.assetPath);
        const a = anchors.find(x => x.id === state.selectedAnchorId);
        if (!a) return;
        if (k === 'anchorNote') return;
        if (k === 'anchorName') a.name = els.anchorName.value.trim() || a.name;
        else if (k.startsWith('anchorA') && els.anchorHasAxis.checked) {
            a.axis = [+els.anchorAx.value || 0, +els.anchorAy.value || 0, +els.anchorAz.value || 0];
        } else if (!k.startsWith('anchorA')) {
            a.p = [+els.anchorX.value || 0, +els.anchorY.value || 0, +els.anchorZ.value || 0];
        }
        saveAnchorsForAsset(inst.assetPath, anchors);
        rebuildAnchorVisualsForAsset(inst.assetPath);
        renderExport();
    });
});

els.anchorHasAxis.addEventListener('change', () => {
    const inst = focusedInstance();
    if (!inst || !state.selectedAnchorId) return;
    const anchors = loadAnchorsForAsset(inst.assetPath);
    const a = anchors.find(x => x.id === state.selectedAnchorId);
    if (!a) return;
    if (els.anchorHasAxis.checked) a.axis ??= [0, 0, -1];
    else delete a.axis;
    saveAnchorsForAsset(inst.assetPath, anchors);
    syncInspectorFromState();
    rebuildAnchorVisualsForAsset(inst.assetPath);
});

els.btnDelete.addEventListener('click', () => {
    if (state.selectedAnchorId) deleteAnchor(state.selectedAnchorId);
});

/* ── Export ───────────────────────────────────────────── */
function buildJsonForFocused() {
    const inst = focusedInstance();
    if (!inst) return { asset: '', version: SCHEMA_VERSION, scale: 1.0, anchors: {} };
    const obj = {
        asset:   inst.assetPath,
        version: SCHEMA_VERSION,
        scale:   +loadScaleForAsset(inst.assetPath).toFixed(6),
        anchors: {},
    };
    if (getReferenceAssetPath() === inst.assetPath) obj.isReference = true;
    for (const a of loadAnchorsForAsset(inst.assetPath)) {
        const entry = { p: a.p };
        if (a.axis) entry.axis = a.axis;
        if (a.note) entry.note = a.note;
        obj.anchors[a.name] = entry;
    }
    return obj;
}

function refsFilenameFor(assetPath) {
    return assetPath ? assetPath.replace(/\.glb$/i, '.refs.json') : 'anchors.refs.json';
}

function renderExport() {
    if (state.exportTab === 'json') {
        els.exportPreview.textContent = JSON.stringify(buildJsonForFocused(), null, 2);
    } else {
        const inst = focusedInstance();
        els.exportPreview.textContent = inst ? refsFilenameFor(inst.assetPath) : '—';
    }
}

document.querySelectorAll('.export-tab').forEach(btn => {
    btn.addEventListener('click', () => {
        document.querySelectorAll('.export-tab').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        state.exportTab = btn.dataset.tab;
        renderExport();
    });
});

els.btnCopy.addEventListener('click', async () => {
    const inst = focusedInstance();
    const text = state.exportTab === 'json'
        ? JSON.stringify(buildJsonForFocused(), null, 2)
        : (inst ? refsFilenameFor(inst.assetPath) : '');
    try { await navigator.clipboard.writeText(text); flashFooter('copied'); }
    catch { flashFooter('copy blocked by browser'); }
});

els.btnDownload.addEventListener('click', () => {
    const inst = focusedInstance();
    if (!inst) { flashFooter('focus an asset first'); return; }
    const blob = new Blob([JSON.stringify(buildJsonForFocused(), null, 2)],
        { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const name = refsFilenameFor(inst.assetPath).split('/').pop();
    a.href = url; a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(url);
    flashFooter(`saved ${name}`);
});

/* ── Set axis from current camera view (V key or button) ────────── */
function setAxisFromCameraView() {
    const inst = focusedInstance();
    if (!inst) { flashFooter('focus an asset first'); return; }
    if (!state.selectedAnchorId) { flashFooter('select an anchor first'); return; }
    const anchors = loadAnchorsForAsset(inst.assetPath);
    const a = anchors.find(x => x.id === state.selectedAnchorId);
    if (!a) return;
    // Camera looks down -Z in its local frame; world forward = (target - position).
    const camForwardWorld = new THREE.Vector3();
    camera.getWorldDirection(camForwardWorld); // unit vector
    // Transform world dir into instance's local frame (rotation only, no translation).
    const m = new THREE.Matrix4().copy(inst.three.matrixWorld).invert();
    const local = camForwardWorld.clone().transformDirection(m).normalize();
    a.axis = [+local.x.toFixed(4), +local.y.toFixed(4), +local.z.toFixed(4)];
    saveAnchorsForAsset(inst.assetPath, anchors);
    rebuildAnchorVisualsForAsset(inst.assetPath);
    syncInspectorFromState();
    flashFooter(`axis on ${a.name} set to camera view`);
}

/* ── Attachment block handlers (Phase C) ────────────────── */
// 'set from view' inspector button
const btnAxisFromView = document.getElementById('btn-axis-from-view');
if (btnAxisFromView) btnAxisFromView.addEventListener('click', setAxisFromCameraView);

els.attModeEdit.addEventListener('change', () => {
    const inst = focusedInstance();
    if (!inst || !inst.attachment) return;
    updateAttachment(inst.id, { mode: els.attModeEdit.value });
});
els.attRollEdit.addEventListener('input', () => {
    els.attRollEditNum.value = els.attRollEdit.value;
    const inst = focusedInstance();
    if (!inst || !inst.attachment) return;
    updateAttachment(inst.id, { rollDeg: parseFloat(els.attRollEdit.value) || 0 });
});
els.attRollEditNum.addEventListener('input', () => {
    els.attRollEdit.value = els.attRollEditNum.value;
    const inst = focusedInstance();
    if (!inst || !inst.attachment) return;
    updateAttachment(inst.id, { rollDeg: parseFloat(els.attRollEditNum.value) || 0 });
});
document.querySelectorAll('.chip-btn[data-snap]').forEach(btn => {
    btn.addEventListener('click', () => {
        const inst = focusedInstance();
        if (!inst || !inst.attachment) return;
        const v = parseFloat(btn.dataset.snap) || 0;
        els.attRollEdit.value = v;
        els.attRollEditNum.value = v;
        updateAttachment(inst.id, { rollDeg: v });
    });
});
els.attDetachBtn.addEventListener('click', () => {
    const inst = focusedInstance();
    if (!inst || !inst.attachment) return;
    detachInstance(inst.id);
});

let footerTipTimer = null;
function flashFooter(msg) {
    const orig = els.footerTip.dataset.orig || els.footerTip.textContent;
    els.footerTip.dataset.orig = orig;
    els.footerTip.textContent = msg;
    clearTimeout(footerTipTimer);
    footerTipTimer = setTimeout(() => { els.footerTip.textContent = orig; }, 1800);
}

/* ── Mode + viewport interaction ─────────────────────────────────── */
function setMode(mode) {
    state.mode = mode;
    [els.btnOrbit, els.btnPlace, els.btnAxis].forEach(b => b.classList.remove('active'));
    if (mode === 'orbit') els.btnOrbit.classList.add('active');
    if (mode === 'place') els.btnPlace.classList.add('active');
    if (mode === 'axis')  els.btnAxis.classList.add('active');
    els.canvas.classList.toggle('placing', mode === 'place' || mode === 'axis');
    transformer.detach();
    if (mode === 'orbit') attachTransformerToSelected();
}
els.btnOrbit.addEventListener('click', () => setMode('orbit'));
els.btnPlace.addEventListener('click', () => setMode('place'));
els.btnAxis .addEventListener('click', () => setMode('axis'));
els.btnFrame.addEventListener('click', () => frameAll());
els.btnGrid .addEventListener('click', () => {
    state.showGrid = !state.showGrid;
    grid.visible = state.showGrid;
    axesHelper.visible = state.showGrid;
    els.btnGrid.classList.toggle('active', state.showGrid);
});

function frameAll() {
    if (!state.instances.length) return;
    const box = new THREE.Box3();
    for (const inst of state.instances) {
        const b = new THREE.Box3().setFromObject(inst.three);
        if (!b.isEmpty()) box.union(b);
    }
    if (box.isEmpty()) return;
    const size = box.getSize(new THREE.Vector3());
    const ctr  = box.getCenter(new THREE.Vector3());
    const radius = Math.max(0.1, size.length() * 0.55);
    const dir = new THREE.Vector3(1.2, 0.7, 1.6).normalize();
    const dist = radius / Math.tan(THREE.MathUtils.degToRad(camera.fov * 0.5));
    camera.position.copy(ctr).addScaledVector(dir, dist);
    camera.near = Math.max(radius * 0.001, 0.001);
    camera.far  = Math.max(radius * 50,    200);
    camera.updateProjectionMatrix();
    orbit.target.copy(ctr);
    orbit.update();
    const baseSize = Math.max(size.x, size.z) * 1.6;
    grid.scale.setScalar(Math.max(0.1, baseSize / 4));
    axesHelper.scale.setScalar(Math.max(0.05, size.length() * 0.12));
}

function pointerToNDC(ev) {
    const rect = els.canvas.getBoundingClientRect();
    pointer.x =  ((ev.clientX - rect.left) / rect.width)  * 2 - 1;
    pointer.y = -((ev.clientY - rect.top)  / rect.height) * 2 + 1;
}

/* Raycast against any instance's inner mesh, return {instance, point(world)} */
function raycastMesh() {
    raycaster.setFromCamera(pointer, camera);
    let best = null;
    for (const inst of state.instances) {
        const hits = raycaster.intersectObject(inst.innerScene, true);
        if (hits.length && (!best || hits[0].distance < best.hit.distance)) {
            best = { instance: inst, hit: hits[0] };
        }
    }
    return best;
}

function raycastAnchorAcrossAll() {
    raycaster.setFromCamera(pointer, camera);
    let best = null;
    for (const inst of state.instances) {
        const hits = raycaster.intersectObject(inst.anchorLayer, true);
        if (hits.length && (!best || hits[0].distance < best.hit.distance)) {
            let obj = hits[0].object;
            while (obj && !obj._anchorId) obj = obj.parent;
            if (obj) best = { instance: inst, anchorObj: obj, hit: hits[0] };
        }
    }
    return best;
}

let downX = 0, downY = 0, downT = 0;
els.canvas.addEventListener('pointerdown', (e) => {
    downX = e.clientX; downY = e.clientY; downT = Date.now();
});
els.canvas.addEventListener('pointermove', (e) => {
    pointerToNDC(e);
    const r = raycastMesh();
    if (r) {
        // Show coords in the focused instance's local frame, regardless of which we hovered
        const inst = focusedInstance();
        if (inst) {
            const local = inst.three.worldToLocal(r.hit.point.clone());
            els.hudCoords.textContent = `${inst.name}  x ${local.x.toFixed(3)}  y ${local.y.toFixed(3)}  z ${local.z.toFixed(3)}`;
        } else {
            const p = r.hit.point;
            els.hudCoords.textContent = `world  x ${p.x.toFixed(3)}  y ${p.y.toFixed(3)}  z ${p.z.toFixed(3)}`;
        }
    } else {
        els.hudCoords.textContent = '—';
    }
});

els.canvas.addEventListener('click', (e) => {
    const dx = Math.abs(e.clientX - downX), dy = Math.abs(e.clientY - downY);
    if (dx > 4 || dy > 4) return;
    if (Date.now() - downT > 350) return;
    pointerToNDC(e);

    // Anchors first — clicking an anchor selects it and focuses its instance
    const ah = raycastAnchorAcrossAll();
    if (ah) {
        if (ah.instance.id !== state.focusedId) focusInstance(ah.instance.id);
        selectAnchor(ah.anchorObj._anchorId);
        return;
    }

    const r = raycastMesh();
    if (!r) return;

    // Clicking another instance's mesh focuses that instance
    if (r.instance.id !== state.focusedId) {
        focusInstance(r.instance.id);
        return;
    }

    // From here, we're on the focused instance's mesh.
    // Shift-click works as place even from orbit mode (fast workflow)
    const wantsPlace = state.mode === 'place' || (state.mode === 'orbit' && e.shiftKey);
    if (wantsPlace) {
        const local = r.instance.three.worldToLocal(r.hit.point.clone());
        addAnchor(local);
        return;
    }
    if (state.mode === 'axis') {
        if (!state.selectedAnchorId) {
            flashFooter('select an anchor first (click its dot or row)');
            return;
        }
        const anchors = loadAnchorsForAsset(r.instance.assetPath);
        const a = anchors.find(x => x.id === state.selectedAnchorId);
        if (!a) {
            flashFooter('the selected anchor isn’t on this asset — click an anchor on the focused asset');
            return;
        }
        const localPoint = r.instance.three.worldToLocal(r.hit.point.clone());
        const dir = new THREE.Vector3(...a.p);
        const v = localPoint.sub(dir);
        if (v.lengthSq() < 1e-6) {
            flashFooter('click further from the anchor — too close to determine direction');
            return;
        }
        v.normalize();
        a.axis = [+v.x.toFixed(4), +v.y.toFixed(4), +v.z.toFixed(4)];
        saveAnchorsForAsset(r.instance.assetPath, anchors);
        rebuildAnchorVisualsForAsset(r.instance.assetPath);
        syncInspectorFromState();
        flashFooter(`axis set on ${a.name}`);
    }
});

/* ── Init ─────────────────────────────────────────────────────────── */
function resize() {
    const w = els.canvasWrap.clientWidth;
    const h = els.canvasWrap.clientHeight;
    renderer.setSize(w, h, false);
    camera.aspect = Math.max(0.001, w / h);
    camera.updateProjectionMatrix();
}
new ResizeObserver(resize).observe(els.canvasWrap);
resize();

function animate() {
    requestAnimationFrame(animate);
    orbit.update();
    applyAttachmentsTick();
    updateAttachmentLines();
    renderer.render(scene, camera);
}
animate();

els.refresh.addEventListener('click', async () => {
    await listGlbsRecursively('assets');
    renderLibrary();
    renderScene();
});
els.assetFilter.addEventListener('input', renderLibrary);

window.addEventListener('keydown', (e) => {
    if (e.target.matches('input, textarea')) return;
    if (e.key === 'g') els.btnGrid.click();
    if (e.key === 'f') frameAll();
    if (e.key === 'o') setMode('orbit');
    if (e.key === 'p') setMode('place');
    if (e.key === 'a') {
        if (!state.selectedAnchorId) {
            flashFooter('select an anchor first, then press A to set its forward direction');
            return;
        }
        setMode('axis');
    }
    if (e.key === 'v' && state.selectedAnchorId) setAxisFromCameraView();
    if ((e.key === 'Backspace' || e.key === 'Delete') && state.selectedAnchorId) {
        deleteAnchor(state.selectedAnchorId);
    }
});

(async function boot() {
    setMode('orbit');
    grid.visible = state.showGrid;
    axesHelper.visible = state.showGrid;
    els.btnGrid.classList.add('active');
    initTabStrip();
    await listGlbsRecursively('assets');
    renderLibrary();
    renderScene();
    setAssetList(state.assets.map(a => a.path));
    setStatus('ready', 'ready');
})();

/* ── Top-level tab strip (Anchors / Terrain) ─────────────────────── */
function initTabStrip() {
    const buttons = document.querySelectorAll('[data-tab-btn]');
    const sections = document.querySelectorAll('main.layout[data-tab]');
    function setTab(name) {
        buttons.forEach(b => {
            const on = b.dataset.tabBtn === name;
            b.classList.toggle('active', on);
            b.setAttribute('aria-selected', on ? 'true' : 'false');
        });
        sections.forEach(s => s.hidden = (s.dataset.tab !== name));
        // Persist selected tab + hash bookmark
        try {
            const root = JSON.parse(localStorage.getItem('anchor_studio.v2') || '{}');
            root.activeTab = name;
            localStorage.setItem('anchor_studio.v2', JSON.stringify(root));
        } catch { /* ignore */ }
        if (location.hash !== '#' + name) location.hash = name;
        if (name === 'terrain') {
            activateTerrain();
        } else {
            deactivateTerrain();
        }
    }
    buttons.forEach(b => b.addEventListener('click', () => setTab(b.dataset.tabBtn)));
    // Restore from hash → storage → default
    let initial = 'anchors';
    const hash = (location.hash || '').replace('#', '');
    if (hash === 'terrain' || hash === 'anchors') initial = hash;
    else {
        try {
            const root = JSON.parse(localStorage.getItem('anchor_studio.v2') || '{}');
            if (root.activeTab === 'terrain') initial = 'terrain';
        } catch { /* ignore */ }
    }
    setTab(initial);
}


/* ────────────────────────────────────────────────────────────────────
 * v0.5 — Per-asset scale banner + reference asset
 * ────────────────────────────────────────────────────────────────── */

// Apply the persisted scale of `assetPath` to every loaded instance of it.
// Also rebuilds anchor visuals for that asset so arrow lengths re-compensate
// for the new world scale.
function applyAssetScaleToAll(assetPath) {
    const s = loadScaleForAsset(assetPath);
    for (const inst of state.instances) {
        if (inst.assetPath !== assetPath) continue;
        inst.s = s;
        inst.three.scale.setScalar(s);
    }
    rebuildAnchorVisualsForAsset(assetPath);
}

// Refresh the scale banner UI to match the focused asset's current scale
// and its relationship to the reference asset.
function syncScaleBanner() {
    const inst = focusedInstance();
    if (!inst) {
        els.scaleBanner.hidden = true;
        return;
    }
    els.scaleBanner.hidden = false;

    const path     = inst.assetPath;
    const scale    = loadScaleForAsset(path);
    const refPath  = getReferenceAssetPath();
    const isRef    = refPath === path;
    const refScale = refPath ? loadScaleForAsset(refPath) : 1.0;

    // Number + slider
    els.scaleNum.value   = (+scale).toFixed(3);
    els.scaleRange.value = String(scale);

    // Reference toggle visual + behavior
    els.refToggle.classList.toggle('active', isRef);
    els.refToggle.textContent = isRef ? '★ reference' : '☆ ref';

    // If this asset is the reference, force it to 1.0 visually and disable controls.
    if (isRef) {
        if (scale !== 1.0) { saveScaleForAsset(path, 1.0); applyAssetScaleToAll(path); }
        els.scaleNum.value   = '1.000';
        els.scaleRange.value = '1';
        els.scaleNum.disabled   = true;
        els.scaleRange.disabled = true;
        els.scaleReset.disabled = true;
        els.scaleMult.textContent = 'reference (1.0)';
        els.scaleMult.classList.add('is-ref');
    } else {
        els.scaleNum.disabled   = false;
        els.scaleRange.disabled = false;
        els.scaleReset.disabled = false;
        els.scaleMult.classList.remove('is-ref');
        if (refPath && refScale > 0) {
            const mult = scale / refScale;
            els.scaleMult.textContent = `× ${mult.toFixed(3)} ref`;
        } else {
            els.scaleMult.textContent = '(no reference set)';
        }
    }
}

// Commit a new scale value for the focused asset and propagate everywhere.
function commitFocusedScale(newScale) {
    const inst = focusedInstance();
    if (!inst) return;
    let v = +newScale;
    if (!isFinite(v) || v <= 0) v = 1.0;
    v = Math.max(0.001, Math.min(1000, v));
    if (getReferenceAssetPath() === inst.assetPath) {
        // reference is locked to 1.0
        v = 1.0;
    }
    saveScaleForAsset(inst.assetPath, v);
    applyAssetScaleToAll(inst.assetPath);
    syncScaleBanner();
    renderExport();
}

if (els.scaleRange) {
    els.scaleRange.addEventListener('input', () => commitFocusedScale(els.scaleRange.value));
}
if (els.scaleNum) {
    els.scaleNum.addEventListener('change', () => commitFocusedScale(els.scaleNum.value));
    els.scaleNum.addEventListener('input',  () => commitFocusedScale(els.scaleNum.value));
}
if (els.scaleReset) {
    els.scaleReset.addEventListener('click', () => commitFocusedScale(1.0));
}
if (els.refToggle) {
    els.refToggle.addEventListener('click', () => {
        const inst = focusedInstance();
        if (!inst) return;
        const cur = getReferenceAssetPath();
        if (cur === inst.assetPath) {
            // Un-mark
            setReferenceAssetPath(null);
            flashFooter('reference cleared');
        } else {
            setReferenceAssetPath(inst.assetPath);
            // Snap reference to 1.0 (per-asset, not per-instance).
            saveScaleForAsset(inst.assetPath, 1.0);
            applyAssetScaleToAll(inst.assetPath);
            flashFooter(`${inst.name} is now the reference (= 1.0). Other assets show × multiplier.`);
        }
        // Other assets' "× ref" display depends on this; refresh scene + banner.
        renderScene();
        syncScaleBanner();
        renderExport();
    });
}

/* ────────────────────────────────────────────────────────────────────
 * v0.5 — Drag-to-attach
 *
 * Press on an anchor dot, drag onto another anchor dot belonging to a
 * DIFFERENT instance, release. Creates an attachment with mode='position'
 * (default; user can promote to axis-anti or axis-parallel afterwards in
 * the inspector). Reuses cycle prevention from attachInstance.
 * ────────────────────────────────────────────────────────────────── */

const dragState = {
    active:     false,
    fromInst:   null,    // {instance, anchorObj}
    line:       null,    // THREE.Line for the in-progress connector
    targetHit:  null,    // current hovered candidate
};

const dragLineMat = new THREE.LineBasicMaterial({
    color: 0xffb84d, transparent: true, opacity: 0.9, depthTest: false,
});

function startDragAttach(fromHit, ev) {
    // Need at least one other instance with anchors to attach to.
    if (state.instances.length < 2) return false;
    dragState.active   = true;
    dragState.fromInst = fromHit;
    dragState.targetHit = null;

    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.BufferAttribute(new Float32Array(6), 3));
    const line = new THREE.Line(geom, dragLineMat);
    line.renderOrder = 1100;
    scene.add(line);
    dragState.line = line;

    // Disable orbit controls while dragging so we don't fight the camera.
    orbit.enabled = false;
    els.canvas.setPointerCapture?.(ev.pointerId);
    flashFooter(`drag onto another anchor to attach (${fromHit.instance.name}.${anchorNameOf(fromHit)})`);
    return true;
}

function anchorNameOf(hit) {
    const a = loadAnchorsForAsset(hit.instance.assetPath).find(x => x.id === hit.anchorObj._anchorId);
    return a ? a.name : '?';
}

function updateDragAttach() {
    if (!dragState.active) return;
    const start = new THREE.Vector3();
    dragState.fromInst.anchorObj.getWorldPosition(start);

    // Where to draw the end point: hovered anchor, else raycast-against-mesh, else ray plane.
    const candidate = raycastAnchorAcrossAll();
    let end;
    if (candidate && candidate.instance.id !== dragState.fromInst.instance.id) {
        candidate.anchorObj.getWorldPosition(end = new THREE.Vector3());
        dragState.targetHit = candidate;
    } else {
        dragState.targetHit = null;
        const meshHit = raycastMesh();
        if (meshHit) end = meshHit.hit.point.clone();
        else {
            // Project to a plane through the start point facing the camera.
            const planeNormal = new THREE.Vector3();
            camera.getWorldDirection(planeNormal).negate();
            const plane = new THREE.Plane(planeNormal, -planeNormal.dot(start));
            end = new THREE.Vector3();
            raycaster.setFromCamera(pointer, camera);
            raycaster.ray.intersectPlane(plane, end);
            if (!end || isNaN(end.x)) end = start.clone();
        }
    }
    const arr = dragState.line.geometry.attributes.position.array;
    arr[0] = start.x; arr[1] = start.y; arr[2] = start.z;
    arr[3] = end.x;   arr[4] = end.y;   arr[5] = end.z;
    dragState.line.geometry.attributes.position.needsUpdate = true;
}

function finishDragAttach(ev) {
    if (!dragState.active) return;
    const target = dragState.targetHit;
    const from   = dragState.fromInst;

    // Tear down visual immediately
    scene.remove(dragState.line);
    dragState.line.geometry.dispose();
    dragState.line = null;

    if (target && target.instance.id !== from.instance.id) {
        const childInst   = from.instance;
        const parentInst  = target.instance;
        const childName   = anchorNameOf(from);
        const parentName  = anchorNameOf(target);
        // Attach: child = the asset we started from, parent = the asset we dropped on.
        // (mental model: drag the gun's handle onto the character's hand.)
        attachInstance(childInst.id, parentInst.id, childName, parentName, { mode: 'position' });
    } else {
        flashFooter('drop on another asset’s anchor to attach (cancelled)');
    }

    dragState.active = false;
    dragState.fromInst = null;
    dragState.targetHit = null;
    orbit.enabled = true;
    els.canvas.releasePointerCapture?.(ev.pointerId);
}

// Hook into the existing pointer pipeline: on pointerdown, if the press
// landed on an anchor and the user actually moves the pointer, treat it
// as a drag-to-attach gesture. A pure click still selects the anchor
// (the existing 'click' handler runs on pointerup with no movement).
let pendingDragHit = null;
els.canvas.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    pointerToNDC(e);
    const ah = raycastAnchorAcrossAll();
    pendingDragHit = ah || null;
}, true); // capture: runs before the `pointerdown` that records downX/Y/T

els.canvas.addEventListener('pointermove', (e) => {
    pointerToNDC(e);
    if (dragState.active) {
        updateDragAttach();
        return;
    }
    if (pendingDragHit && (Math.abs(e.clientX - downX) > 4 || Math.abs(e.clientY - downY) > 4)) {
        if (startDragAttach(pendingDragHit, e)) {
            updateDragAttach();
        }
        pendingDragHit = null;
    }
});

els.canvas.addEventListener('pointerup', (e) => {
    if (dragState.active) {
        finishDragAttach(e);
    }
    pendingDragHit = null;
});

els.canvas.addEventListener('pointercancel', (e) => {
    if (dragState.active) {
        // treat as cancel
        scene.remove(dragState.line);
        dragState.line?.geometry?.dispose();
        dragState.line = null;
        dragState.active = false;
        dragState.fromInst = null;
        dragState.targetHit = null;
        orbit.enabled = true;
        els.canvas.releasePointerCapture?.(e.pointerId);
        flashFooter('drag cancelled');
    }
    pendingDragHit = null;
});

// Initial banner sync after boot completes (boot()'s renderScene already
// ran by the time this script-tail executes, but the focused id may not
// be set until an asset loads).
syncScaleBanner();
