// ============================================================
// Firewolf Live Editor — Phase A (R32.273)
// ============================================================
// @ai-contract
// DEPENDS: window.scene, window.camera, window.renderer (from renderer.js)
// DEPENDS: THREE (via importmap), TransformControls (vendored)
// EXPOSES: window.__editorPanel (toggle/state API)
// PATTERN: self-initializing ES module, loaded via dynamic import from index.html
// HOTKEY: P (toggle panel), Escape (close panel / deselect)
// ============================================================
//
// Phase A scope (from Claude_Build_Brief.md):
//   1. Vanilla JS tuning panel — 5 physics constants per armor type
//   2. "Save Tuning" button — downloads JSON + C++ snippet
//   3. TransformControls wired to buildings/entities for live drag
//   4. "Save Map" button — downloads JSON of modified entity positions
//
// Architecture note: WASM setSettings() currently only reads sensitivity/fov/
// renderDist/jetToggle/invertY. Physics constants (ArmorData struct + gravity)
// are compiled-in. Sliders capture target values for EXPORT — live WASM update
// requires a C++ rebuild to extend setSettings() parsing. The JSON keys are
// already structured to match what the C++ parser would expect.
// ============================================================

import * as THREE from 'three';
import { TransformControls } from 'three/addons/controls/TransformControls.js';

// ── T1 Armor defaults (from wasm_main.cpp ArmorData struct) ──────────
const ARMOR_DEFAULTS = {
    Light:  { jetForce: 236, jetEnergyDrain: 0.8, maxFwdSpeed: 11, groundTraction: 3.0, mass: 9 },
    Medium: { jetForce: 320, jetEnergyDrain: 1.0, maxFwdSpeed: 8,  groundTraction: 3.0, mass: 13 },
    Heavy:  { jetForce: 385, jetEnergyDrain: 1.1, maxFwdSpeed: 5,  groundTraction: 4.5, mass: 18 },
};
const GRAVITY_DEFAULT = 20.0; // wasm_main.cpp line ~2018

// ── Slider definitions ───────────────────────────────────────────────
const TUNING_SLIDERS = [
    { key: 'jetForce',      label: 'Jet Force',        min: 50,  max: 800, step: 1,    unit: 'N',    perArmor: true },
    { key: 'jetEnergyDrain', label: 'Jet Energy Drain', min: 0.1, max: 5.0, step: 0.05, unit: '/s',   perArmor: true },
    { key: 'gravity',       label: 'Gravity',           min: 5,   max: 50,  step: 0.5,  unit: 'm/s²', perArmor: false },
    { key: 'groundTraction', label: 'Ground Traction',  min: 0.5, max: 10,  step: 0.1,  unit: '',     perArmor: true },
    { key: 'maxFwdSpeed',   label: 'Max Speed',         min: 2,   max: 30,  step: 0.5,  unit: 'm/s',  perArmor: true },
];

// ── State ────────────────────────────────────────────────────────────
let panelVisible = false;
let editorMode = false; // map editing active
let selectedArmor = 'Medium';
let tuningValues = {}; // { Light: {...}, Medium: {...}, Heavy: {...}, gravity: 20 }
let transformControls = null;
let selectedObject = null;
let modifiedEntities = new Map(); // name → { original: Vec3, current: Vec3 }
let raycaster = new THREE.Raycaster();
let mouse = new THREE.Vector2();
let panelEl = null;

// Initialize tuning values from defaults
function resetTuningValues() {
    tuningValues = { gravity: GRAVITY_DEFAULT };
    for (const armor of ['Light', 'Medium', 'Heavy']) {
        tuningValues[armor] = { ...ARMOR_DEFAULTS[armor] };
    }
}
resetTuningValues();

// ── DOM Construction ─────────────────────────────────────────────────
function buildPanel() {
    // Inject CSS
    const style = document.createElement('style');
    style.textContent = `
        #editor-panel {
            display: none;
            position: fixed;
            top: 0;
            left: 0;
            width: 340px;
            height: 100vh;
            background: rgba(10, 8, 6, 0.92);
            border-right: 1px solid rgba(255, 212, 121, 0.3);
            z-index: 9999;
            font-family: 'Barlow Condensed', sans-serif;
            color: #E0D0A0;
            overflow-y: auto;
            padding: 12px 16px;
            box-sizing: border-box;
            backdrop-filter: blur(4px);
        }
        #editor-panel.visible { display: block; }
        #editor-panel h2 {
            margin: 0 0 8px 0;
            font-family: 'Cinzel', serif;
            font-size: 1.1em;
            color: #FFD479;
            letter-spacing: 2px;
            text-transform: uppercase;
            border-bottom: 1px solid rgba(255, 212, 121, 0.2);
            padding-bottom: 6px;
        }
        #editor-panel .ep-section {
            margin-bottom: 14px;
        }
        #editor-panel .ep-row {
            display: flex;
            align-items: center;
            gap: 8px;
            margin: 5px 0;
            font-size: 0.85em;
        }
        #editor-panel .ep-label {
            width: 120px;
            flex-shrink: 0;
            color: #9A8A6A;
            letter-spacing: 0.5px;
        }
        #editor-panel .ep-slider {
            flex: 1;
            accent-color: #D4A030;
            cursor: pointer;
        }
        #editor-panel .ep-val {
            width: 55px;
            text-align: right;
            font-family: 'Roboto Mono', monospace;
            font-size: 0.82em;
            color: #FFD479;
        }
        #editor-panel .ep-btn {
            background: rgba(30, 25, 18, 0.9);
            color: #D4A030;
            border: 1px solid #5A4A2A;
            padding: 6px 14px;
            font-family: 'Barlow Condensed', sans-serif;
            font-size: 0.85em;
            letter-spacing: 1px;
            cursor: pointer;
            text-transform: uppercase;
            transition: all 0.15s;
        }
        #editor-panel .ep-btn:hover {
            background: rgba(60, 50, 30, 0.9);
            border-color: #FFD479;
            color: #FFD479;
        }
        #editor-panel .ep-btn.active {
            background: rgba(80, 60, 20, 0.9);
            border-color: #FFD479;
            color: #FFD479;
        }
        #editor-panel .ep-armor-tabs {
            display: flex;
            gap: 4px;
            margin-bottom: 8px;
        }
        #editor-panel .ep-armor-tab {
            flex: 1;
            text-align: center;
            padding: 4px 0;
            background: rgba(30, 25, 18, 0.7);
            border: 1px solid #3A3020;
            color: #7A6A4A;
            cursor: pointer;
            font-size: 0.8em;
            letter-spacing: 1px;
            text-transform: uppercase;
        }
        #editor-panel .ep-armor-tab.active {
            background: rgba(80, 60, 20, 0.8);
            border-color: #FFD479;
            color: #FFD479;
        }
        #editor-panel .ep-divider {
            border: none;
            border-top: 1px solid rgba(255, 212, 121, 0.15);
            margin: 10px 0;
        }
        #editor-panel .ep-note {
            font-size: 0.72em;
            color: #7A6A4A;
            line-height: 1.3;
            margin: 4px 0;
        }
        #editor-panel .ep-badge {
            display: inline-block;
            padding: 1px 6px;
            font-size: 0.7em;
            background: rgba(212, 160, 48, 0.15);
            border: 1px solid rgba(212, 160, 48, 0.3);
            color: #D4A030;
            border-radius: 2px;
            margin-left: 6px;
        }
        #editor-panel .ep-entity-list {
            max-height: 150px;
            overflow-y: auto;
            font-size: 0.78em;
            color: #9A8A6A;
            margin: 6px 0;
        }
        #editor-panel .ep-entity-item {
            padding: 2px 4px;
            cursor: pointer;
            border-bottom: 1px solid rgba(255,212,121,0.05);
        }
        #editor-panel .ep-entity-item:hover {
            background: rgba(80, 60, 20, 0.3);
            color: #FFD479;
        }
        #editor-panel .ep-close {
            position: absolute;
            top: 10px;
            right: 12px;
            cursor: pointer;
            color: #7A6A4A;
            font-size: 1.3em;
            line-height: 1;
        }
        #editor-panel .ep-close:hover { color: #FFD479; }
        .editor-gizmo-hint {
            position: fixed;
            bottom: 60px;
            left: 50%;
            transform: translateX(-50%);
            background: rgba(10,8,6,0.85);
            color: #FFD479;
            padding: 6px 16px;
            border: 1px solid rgba(255,212,121,0.3);
            font-family: 'Barlow Condensed', sans-serif;
            font-size: 0.82em;
            letter-spacing: 1px;
            z-index: 10001;
            pointer-events: none;
            display: none;
        }
        .editor-gizmo-hint.visible { display: block; }
    `;
    document.head.appendChild(style);

    // Panel container
    panelEl = document.createElement('div');
    panelEl.id = 'editor-panel';
    panelEl.innerHTML = `
        <span class="ep-close" onclick="window.__editorPanel.toggle()">×</span>
        <h2>🔧 Live Editor <span class="ep-badge">Phase A</span></h2>

        <!-- PHYSICS TUNING -->
        <div class="ep-section">
            <div style="font-size:0.82em;color:#9A8A6A;letter-spacing:1px;text-transform:uppercase;margin-bottom:6px;">
                Physics Tuning
            </div>
            <div class="ep-armor-tabs" id="ep-armor-tabs">
                <div class="ep-armor-tab" data-armor="Light" onclick="window.__editorPanel.setArmor('Light')">Light</div>
                <div class="ep-armor-tab active" data-armor="Medium" onclick="window.__editorPanel.setArmor('Medium')">Medium</div>
                <div class="ep-armor-tab" data-armor="Heavy" onclick="window.__editorPanel.setArmor('Heavy')">Heavy</div>
            </div>
            <div id="ep-sliders"></div>
            <div class="ep-note">
                ⚠ Sliders preview target values. Live WASM update requires C++ rebuild with extended setSettings().
                Use "Save Tuning" to export values for <code>wasm_main.cpp</code>.
            </div>
            <div style="display:flex;gap:6px;margin-top:8px;">
                <button class="ep-btn" onclick="window.__editorPanel.saveTuning()">💾 Save Tuning</button>
                <button class="ep-btn" onclick="window.__editorPanel.resetTuning()">↺ Reset</button>
            </div>
        </div>

        <hr class="ep-divider">

        <!-- MAP EDITING -->
        <div class="ep-section">
            <div style="font-size:0.82em;color:#9A8A6A;letter-spacing:1px;text-transform:uppercase;margin-bottom:6px;">
                Map Entity Placement
            </div>
            <div style="display:flex;gap:6px;margin-bottom:8px;">
                <button class="ep-btn" id="ep-edit-toggle" onclick="window.__editorPanel.toggleMapEdit()">
                    ▶ Enable Edit Mode
                </button>
                <button class="ep-btn" id="ep-gizmo-mode" onclick="window.__editorPanel.cycleGizmo()" style="display:none">
                    Move
                </button>
            </div>
            <div class="ep-note" id="ep-edit-hint">
                Click a building or entity in the 3D view to select it. Drag the gizmo to reposition.
                W=Translate, E=Rotate, R=Scale (while edit mode is active).
            </div>
            <div id="ep-selected-info" style="display:none;margin:6px 0;">
                <div class="ep-row">
                    <div class="ep-label">Selected:</div>
                    <div class="ep-val" id="ep-sel-name" style="width:auto;color:#FFD479">—</div>
                </div>
                <div class="ep-row">
                    <div class="ep-label">Position:</div>
                    <div class="ep-val" id="ep-sel-pos" style="width:auto">—</div>
                </div>
            </div>
            <div style="font-size:0.78em;color:#7A6A4A;margin:6px 0;">Modified entities:</div>
            <div class="ep-entity-list" id="ep-entity-list">
                <div style="color:#5A4A3A;font-style:italic;">None yet</div>
            </div>
            <div style="display:flex;gap:6px;margin-top:8px;">
                <button class="ep-btn" onclick="window.__editorPanel.saveMap()">💾 Save Map</button>
                <button class="ep-btn" onclick="window.__editorPanel.undoAll()">↺ Undo All</button>
            </div>
        </div>

        <hr class="ep-divider">
        <div class="ep-note" style="text-align:center;margin-top:4px;">
            Press <b>P</b> to toggle · <b>Esc</b> to deselect/close
        </div>
    `;
    document.body.appendChild(panelEl);

    // Gizmo hint bar
    const hint = document.createElement('div');
    hint.className = 'editor-gizmo-hint';
    hint.id = 'ep-gizmo-hint';
    hint.textContent = 'EDIT MODE — Click entity to select · W=Move E=Rotate R=Scale · Esc=Deselect';
    document.body.appendChild(hint);

    buildSliders();
}

// ── Slider Construction ──────────────────────────────────────────────
function buildSliders() {
    const container = document.getElementById('ep-sliders');
    if (!container) return;
    container.innerHTML = '';

    for (const s of TUNING_SLIDERS) {
        const val = s.perArmor ? tuningValues[selectedArmor][s.key] : tuningValues[s.key];
        const row = document.createElement('div');
        row.className = 'ep-row';
        row.innerHTML = `
            <div class="ep-label">${s.label}</div>
            <input type="range" class="ep-slider" id="ep-s-${s.key}"
                min="${s.min}" max="${s.max}" step="${s.step}" value="${val}"
                oninput="window.__editorPanel.onSlider('${s.key}',this.value)">
            <div class="ep-val" id="ep-v-${s.key}">${formatVal(val, s)}</div>
        `;
        container.appendChild(row);
    }
}

function formatVal(val, sliderDef) {
    const num = parseFloat(val);
    const decimals = sliderDef.step < 1 ? (sliderDef.step < 0.1 ? 2 : 1) : 0;
    return num.toFixed(decimals) + (sliderDef.unit ? ' ' + sliderDef.unit : '');
}

function updateSliderDisplay() {
    for (const s of TUNING_SLIDERS) {
        const val = s.perArmor ? tuningValues[selectedArmor][s.key] : tuningValues[s.key];
        const slider = document.getElementById('ep-s-' + s.key);
        const display = document.getElementById('ep-v-' + s.key);
        if (slider) slider.value = val;
        if (display) display.textContent = formatVal(val, s);
    }
}

// ── TransformControls Setup ──────────────────────────────────────────
function initTransformControls() {
    if (transformControls) return;
    const scene = window.scene;
    const camera = window.camera;
    const renderer = window.renderer;
    if (!scene || !camera || !renderer) {
        console.warn('[Editor] scene/camera/renderer not ready yet');
        return;
    }

    transformControls = new TransformControls(camera, renderer.domElement);
    transformControls.setSize(0.8);
    transformControls.addEventListener('dragging-changed', (event) => {
        // Disable orbit/pointer-lock while dragging gizmo
        if (window.__editorDragLock) window.__editorDragLock(event.value);
    });
    transformControls.addEventListener('objectChange', () => {
        if (selectedObject) {
            updateSelectedInfo();
            trackModifiedEntity(selectedObject);
        }
    });
    scene.add(transformControls);
    console.log('[Editor] TransformControls initialized');
}

function findSelectableEntities() {
    const scene = window.scene;
    if (!scene) return [];
    const entities = [];

    // Find interior shapes group
    const interiorGroup = scene.getObjectByName('RaindanceInteriorShapes');
    if (interiorGroup) {
        interiorGroup.traverse(child => {
            if (child.isMesh) {
                entities.push(child);
            }
        });
    }

    // Find other named entities (generators, turrets, stations, flags)
    scene.traverse(child => {
        if (child.isMesh && child.userData && child.userData.entityType) {
            entities.push(child);
        }
        // Also grab building meshes from the building group
        if (child.isMesh && child.parent && child.parent.name &&
            (child.parent.name.includes('building') || child.parent.name.includes('Building'))) {
            entities.push(child);
        }
    });

    return entities;
}

function selectEntity(obj) {
    if (!transformControls) return;
    // Walk up to the meaningful parent (outer group for interior shapes)
    let target = obj;
    while (target.parent && target.parent.type === 'Group' && target.parent.parent &&
           target.parent.parent.name === 'RaindanceInteriorShapes') {
        target = target.parent;
    }
    // For interior shapes wrapped in outer Group, select the outer
    if (target.parent && target.parent.name === 'RaindanceInteriorShapes') {
        // target is already the outer group child — good
    }

    selectedObject = target;
    transformControls.attach(target);

    // Store original position if not already tracked
    const name = getEntityName(target);
    if (!modifiedEntities.has(name)) {
        modifiedEntities.set(name, {
            original: target.position.clone(),
            originalRotation: target.rotation.clone(),
            originalScale: target.scale.clone(),
        });
    }

    updateSelectedInfo();
    console.log('[Editor] Selected:', name);
}

function deselectEntity() {
    if (transformControls) transformControls.detach();
    selectedObject = null;
    const info = document.getElementById('ep-selected-info');
    if (info) info.style.display = 'none';
}

function getEntityName(obj) {
    if (obj.name) return obj.name;
    if (obj.userData && obj.userData.shapeName) return obj.userData.shapeName;
    if (obj.userData && obj.userData.entityType) return obj.userData.entityType + '_' + obj.id;
    return 'entity_' + obj.id;
}

function updateSelectedInfo() {
    if (!selectedObject) return;
    const info = document.getElementById('ep-selected-info');
    const nameEl = document.getElementById('ep-sel-name');
    const posEl = document.getElementById('ep-sel-pos');
    if (info) info.style.display = 'block';
    if (nameEl) nameEl.textContent = getEntityName(selectedObject);
    if (posEl) {
        const p = selectedObject.position;
        posEl.textContent = `${p.x.toFixed(1)}, ${p.y.toFixed(1)}, ${p.z.toFixed(1)}`;
    }
}

function trackModifiedEntity(obj) {
    const name = getEntityName(obj);
    const entry = modifiedEntities.get(name);
    if (entry) {
        entry.current = obj.position.clone();
        entry.currentRotation = obj.rotation.clone();
        entry.currentScale = obj.scale.clone();
    }
    updateEntityList();
}

function updateEntityList() {
    const list = document.getElementById('ep-entity-list');
    if (!list) return;
    if (modifiedEntities.size === 0) {
        list.innerHTML = '<div style="color:#5A4A3A;font-style:italic;">None yet</div>';
        return;
    }
    let html = '';
    for (const [name, data] of modifiedEntities) {
        if (!data.current) continue;
        const dx = (data.current.x - data.original.x).toFixed(1);
        const dy = (data.current.y - data.original.y).toFixed(1);
        const dz = (data.current.z - data.original.z).toFixed(1);
        html += `<div class="ep-entity-item" onclick="window.__editorPanel.focusEntity('${name}')">
            ${name} <span style="color:#7A6A4A">Δ(${dx}, ${dy}, ${dz})</span>
        </div>`;
    }
    list.innerHTML = html;
}

// ── Mouse Picking ────────────────────────────────────────────────────
function onEditorClick(event) {
    if (!editorMode || !window.scene || !window.camera) return;
    // Don't pick when clicking on the panel itself
    if (event.target.closest('#editor-panel')) return;
    // Don't pick if we're dragging the gizmo
    if (transformControls && transformControls.dragging) return;

    const rect = window.renderer.domElement.getBoundingClientRect();
    mouse.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    mouse.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;

    raycaster.setFromCamera(mouse, window.camera);
    const entities = findSelectableEntities();
    const intersects = raycaster.intersectObjects(entities, false);

    if (intersects.length > 0) {
        selectEntity(intersects[0].object);
    } else {
        deselectEntity();
    }
}

// ── Save / Export Functions ───────────────────────────────────────────
function saveTuningJSON() {
    const data = {
        _comment: 'Firewolf Physics Tuning — paste into wasm_main.cpp ArmorData struct',
        _generatedAt: new Date().toISOString(),
        gravity: tuningValues.gravity,
        armors: {}
    };
    for (const armor of ['Light', 'Medium', 'Heavy']) {
        data.armors[armor] = { ...tuningValues[armor] };
    }

    // Also generate C++ snippet
    const cppSnippet = generateCppSnippet();
    data._cppSnippet = cppSnippet;

    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    downloadBlob(blob, `firewolf_tuning_${Date.now()}.json`);
    showToastMsg('Tuning exported as JSON', 2500);
}

function generateCppSnippet() {
    const lines = ['// Firewolf Tuning Export — paste into wasm_main.cpp', ''];
    lines.push(`// Gravity (line ~2018 in tick())`);
    lines.push(`float gravity = ${tuningValues.gravity.toFixed(1)}f;`);
    lines.push('');
    lines.push('// ArmorData values (jetForce, jetEnergyDrain, maxFwdSpeed, groundTraction):');
    for (const [armor, vals] of Object.entries(ARMOR_DEFAULTS)) {
        const tv = tuningValues[armor];
        lines.push(`// ${armor}: jetForce=${tv.jetForce}, jetEnergyDrain=${tv.jetEnergyDrain}, maxFwdSpeed=${tv.maxFwdSpeed}, groundTraction=${tv.groundTraction}`);
    }
    return lines.join('\n');
}

function saveMapJSON() {
    const entities = [];
    for (const [name, data] of modifiedEntities) {
        if (!data.current) continue;
        entities.push({
            name: name,
            original: { x: data.original.x, y: data.original.y, z: data.original.z },
            position: { x: data.current.x, y: data.current.y, z: data.current.z },
            rotation: data.currentRotation ? {
                x: data.currentRotation.x, y: data.currentRotation.y, z: data.currentRotation.z
            } : null,
            scale: data.currentScale ? {
                x: data.currentScale.x, y: data.currentScale.y, z: data.currentScale.z
            } : null,
        });
    }
    if (entities.length === 0) {
        showToastMsg('No entities modified yet', 2000);
        return;
    }
    const data = {
        _comment: 'Firewolf Map Entity Positions — modified entities only',
        _generatedAt: new Date().toISOString(),
        _count: entities.length,
        entities: entities,
    };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    downloadBlob(blob, `firewolf_map_${Date.now()}.json`);
    showToastMsg(`Map exported — ${entities.length} entities`, 2500);
}

function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
}

function showToastMsg(msg, dur) {
    // Use existing showToast if available, otherwise fallback
    if (typeof showToast === 'function') {
        showToast(msg, dur);
    } else {
        console.log('[Editor]', msg);
    }
}

// ── Undo All ─────────────────────────────────────────────────────────
function undoAll() {
    for (const [name, data] of modifiedEntities) {
        // Find the object in scene and restore
        const scene = window.scene;
        if (!scene) break;
        scene.traverse(obj => {
            if (getEntityName(obj) === name) {
                obj.position.copy(data.original);
                if (data.originalRotation) obj.rotation.copy(data.originalRotation);
                if (data.originalScale) obj.scale.copy(data.originalScale);
            }
        });
    }
    modifiedEntities.clear();
    deselectEntity();
    updateEntityList();
    showToastMsg('All entity changes undone', 2000);
}

// ── Keyboard Handler ─────────────────────────────────────────────────
function onEditorKeydown(event) {
    // Don't intercept when typing in inputs
    if (event.target.tagName === 'INPUT' || event.target.tagName === 'TEXTAREA') return;

    // P toggles panel
    if (event.code === 'KeyP' && !event.ctrlKey && !event.metaKey && !event.altKey) {
        // Don't toggle if settings or other modal is open
        const settingsOpen = document.getElementById('settings-modal') &&
                             document.getElementById('settings-modal').classList.contains('active');
        if (settingsOpen) return;
        togglePanel();
        event.preventDefault();
        return;
    }

    // Editor mode hotkeys (only when edit mode is active)
    if (editorMode && transformControls) {
        if (event.code === 'KeyW' && !event.ctrlKey) {
            transformControls.setMode('translate');
            updateGizmoButton();
            event.preventDefault();
        } else if (event.code === 'KeyE' && !event.ctrlKey) {
            transformControls.setMode('rotate');
            updateGizmoButton();
            event.preventDefault();
        } else if (event.code === 'KeyR' && !event.ctrlKey) {
            transformControls.setMode('scale');
            updateGizmoButton();
            event.preventDefault();
        } else if (event.code === 'Escape') {
            if (selectedObject) {
                deselectEntity();
                event.preventDefault();
            } else if (panelVisible) {
                togglePanel();
                event.preventDefault();
            }
        }
    } else if (event.code === 'Escape' && panelVisible) {
        togglePanel();
        event.preventDefault();
    }
}

function updateGizmoButton() {
    const btn = document.getElementById('ep-gizmo-mode');
    if (!btn || !transformControls) return;
    const mode = transformControls.mode;
    const labels = { translate: '↔ Move', rotate: '↻ Rotate', scale: '⇔ Scale' };
    btn.textContent = labels[mode] || mode;
}

// ── Toggle Functions ─────────────────────────────────────────────────
function togglePanel() {
    panelVisible = !panelVisible;
    if (panelEl) panelEl.classList.toggle('visible', panelVisible);
    if (!panelVisible && editorMode) {
        toggleMapEdit(); // disable edit mode when closing panel
    }
}

function toggleMapEdit() {
    editorMode = !editorMode;
    const btn = document.getElementById('ep-edit-toggle');
    const gizmoBtn = document.getElementById('ep-gizmo-mode');
    const hint = document.getElementById('ep-gizmo-hint');

    if (editorMode) {
        initTransformControls();
        if (!transformControls) {
            editorMode = false;
            showToastMsg('Editor: scene not ready — start the game first', 3000);
            return;
        }
        if (btn) { btn.textContent = '■ Disable Edit Mode'; btn.classList.add('active'); }
        if (gizmoBtn) gizmoBtn.style.display = '';
        if (hint) hint.classList.add('visible');
        // Release pointer lock so we can click
        if (document.pointerLockElement) document.exitPointerLock();
        window.addEventListener('click', onEditorClick);
        console.log('[Editor] Map edit mode ENABLED');
    } else {
        deselectEntity();
        if (btn) { btn.textContent = '▶ Enable Edit Mode'; btn.classList.remove('active'); }
        if (gizmoBtn) gizmoBtn.style.display = 'none';
        if (hint) hint.classList.remove('visible');
        window.removeEventListener('click', onEditorClick);
        console.log('[Editor] Map edit mode DISABLED');
    }
}

// ── Public API (on window) ───────────────────────────────────────────
window.__editorPanel = {
    toggle: togglePanel,

    setArmor(armor) {
        selectedArmor = armor;
        document.querySelectorAll('#ep-armor-tabs .ep-armor-tab').forEach(el => {
            el.classList.toggle('active', el.dataset.armor === armor);
        });
        updateSliderDisplay();
    },

    onSlider(key, val) {
        const num = parseFloat(val);
        const sliderDef = TUNING_SLIDERS.find(s => s.key === key);
        if (sliderDef.perArmor) {
            tuningValues[selectedArmor][key] = num;
        } else {
            tuningValues[key] = num;
        }
        const display = document.getElementById('ep-v-' + key);
        if (display && sliderDef) display.textContent = formatVal(num, sliderDef);
    },

    saveTuning: saveTuningJSON,
    resetTuning() {
        resetTuningValues();
        updateSliderDisplay();
        showToastMsg('Tuning reset to T1 defaults', 2000);
    },

    toggleMapEdit: toggleMapEdit,

    cycleGizmo() {
        if (!transformControls) return;
        const modes = ['translate', 'rotate', 'scale'];
        const idx = modes.indexOf(transformControls.mode);
        transformControls.setMode(modes[(idx + 1) % 3]);
        updateGizmoButton();
    },

    saveMap: saveMapJSON,
    undoAll: undoAll,

    focusEntity(name) {
        const scene = window.scene;
        if (!scene) return;
        scene.traverse(obj => {
            if (getEntityName(obj) === name) {
                selectEntity(obj);
            }
        });
    },

    get isActive() { return panelVisible; },
    get isEditing() { return editorMode; },
};

// ── Drag lock bridge ─────────────────────────────────────────────────
// When TransformControls is dragging, we need to suppress pointer lock
// and FPS controls. The renderer checks this flag.
window.__editorDragLock = function(dragging) {
    window.__editorDragging = dragging;
};

// ── Initialize ───────────────────────────────────────────────────────
function init() {
    buildPanel();
    document.addEventListener('keydown', onEditorKeydown, true); // capture phase
    console.log('[Editor] Phase A panel loaded. Press P to toggle.');
}

// Wait for DOM ready
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
} else {
    init();
}
