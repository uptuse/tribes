# Firewolf Live Debug Tuning Panel: Implementation Blueprint

**Author:** Manus AI

This document provides a comprehensive, drop-in blueprint for building the live debug tuning panel in Firewolf. The architecture bridges three distinct layers: the C++ WebAssembly core, the JavaScript Three.js rendering engine, and the Rapier physics integration. 

## 1. Reality Checks & Important Context

Before implementing the panel, note the following specifics from the current `uptuse/tribes` repo (R32.272):
- **URL Parameter Clash:** The repo already has a `renderer_debug_panel.js` activated by `?debugPanel` (note the capital P). The new live-tuning panel should use a *different* flag like `?tune` or `?liveTune` to avoid clashing.
- **WASM JSON Bridge:** `setSettings`, `sGetF`, and `sGetB` exist in `wasm_main.cpp` exactly as described. The JSON-bridge pattern is a clean clone target.
- **Const Variables:** `armors[]` and `weapons[]` are `static const` in the WASM layer. The blueprint copies them into mutable `g_dbg_armors[]` and `g_dbg_weapons[]` once. After `initDebugState()` runs, all `mainLoop()` references must be swapped to use the mutable versions (e.g., global find/replace `armors[` with `g_dbg_armors[`).
- **Rapier Physics:** Rapier already exposes `window.RapierPhysics` with `world` and `characterController` in module-closure scope. Adding `setPhysicsParams()` is a simple one-line export.
- **Bloom Override Conflict:** `window.__tribesBloom` and `window.DayNight.freeze(hour)` are already live. However, `renderer_postprocess.js` overwrites `bloomPass.strength` every frame in its night-adaptive `update()` function. The panel needs a `bloomLockOverride` flag in `renderer_postprocess.js`, or the slider must `listen()` and override post-update.
- **Version Chip:** `index.html` has a `#version-chip` showing `R32.272`. Remember to bump it per the `feat(R32.XXX)` convention.

## 2. Architecture Overview

The tuning panel leverages `lil-gui` to provide a lightweight, dependency-free interface. Because Firewolf maintains strict boundaries between its simulation and rendering layers, the panel must communicate across these boundaries using established patterns:

- **WASM Layer:** Uses Emscripten's `ccall` and a hand-rolled JSON parser (`sGetF`) to update runtime physics and combat constants.
- **JS Rendering Layer:** Modifies exposed `window.*` facades (e.g., `window.__tribesBloom`, `window.DayNight`) to alter post-processing, camera settings, and particle emission in real-time.
- **Rapier Layer:** Interacts with the `window.RapierPhysics` module to update character controller parameters and world gravity dynamically.

The panel is gated behind the `?debug` URL parameter and includes an "Export JSON" feature to capture the current tuned state for permanent integration into the codebase.

## 3. WASM Layer (`wasm_main.cpp`)

The core constraint in the WASM layer is that many game constants (`ArmorData`, `WeaponData`) are declared as `static const`. To make them tunable, we introduce mutable `g_dbg_*` variables that are initialized from the constants and updated via a new JSON bridge.

### 2.1 State Initialization

```cpp
// ============================================================
// Debug Tuning State (R32.XXX)
// ============================================================
static float g_dbg_gravity = 20.0f;
static float g_dbg_skiFriction = 0.998f;
static float g_dbg_energyRegen = 8.0f;

// Mutable copies of const arrays
static ArmorData g_dbg_armors[3];
static WeaponData g_dbg_weapons[WPN_COUNT];

static bool g_dbg_initialized = false;

static void initDebugState() {
    if (g_dbg_initialized) return;
    for (int i = 0; i < 3; i++) g_dbg_armors[i] = armors[i];
    for (int i = 0; i < WPN_COUNT; i++) g_dbg_weapons[i] = weapons[i];
    g_dbg_initialized = true;
}
```

### 2.2 JSON Bridge Functions

We use the existing `sGetF` and `sGetB` helpers to parse the incoming JSON string without requiring an external library.

```cpp
extern "C" void setDebugConfig(const char* json) {
    initDebugState();
    
    // Global Physics
    g_dbg_gravity = (float)sGetF(json, "gravity", g_dbg_gravity);
    g_dbg_skiFriction = (float)sGetF(json, "skiFriction", g_dbg_skiFriction);
    g_dbg_energyRegen = (float)sGetF(json, "energyRegen", g_dbg_energyRegen);

    // Armor Tuning (Light Armor Example)
    g_dbg_armors[0].jetForce = (float)sGetF(json, "lightJetForce", g_dbg_armors[0].jetForce);
    g_dbg_armors[0].mass = (float)sGetF(json, "lightMass", g_dbg_armors[0].mass);
    
    // Weapon Tuning (Disc Example)
    g_dbg_weapons[WPN_DISC].damage = (float)sGetF(json, "discDamage", g_dbg_weapons[WPN_DISC].damage);
    g_dbg_weapons[WPN_DISC].muzzleVel = (float)sGetF(json, "discMuzzleVel", g_dbg_weapons[WPN_DISC].muzzleVel);
    g_dbg_weapons[WPN_DISC].gravity = (float)sGetF(json, "discGravity", g_dbg_weapons[WPN_DISC].gravity);
}

// Static buffer for JSON export to avoid malloc/free complexity
static char g_dbg_jsonBuf[2048];

extern "C" const char* getDebugConfig() {
    initDebugState();
    snprintf(g_dbg_jsonBuf, sizeof(g_dbg_jsonBuf),
        "{\"gravity\":%.2f,\"skiFriction\":%.4f,\"energyRegen\":%.2f,"
        "\"lightJetForce\":%.2f,\"lightMass\":%.2f,"
        "\"discDamage\":%.2f,\"discMuzzleVel\":%.2f,\"discGravity\":%.2f}",
        g_dbg_gravity, g_dbg_skiFriction, g_dbg_energyRegen,
        g_dbg_armors[0].jetForce, g_dbg_armors[0].mass,
        g_dbg_weapons[WPN_DISC].damage, g_dbg_weapons[WPN_DISC].muzzleVel, g_dbg_weapons[WPN_DISC].gravity);
    return g_dbg_jsonBuf;
}
```

*Note: In `mainLoop()` and physics calculations, all references to `armors[p.armor]` must be updated to use `g_dbg_armors[p.armor]`, and `gravity` must use `g_dbg_gravity`.*

## 4. JS Render & Physics Layers

### 3.1 `renderer_rapier.js`

Add a facade function to update the character controller and world gravity dynamically.

```javascript
// Expose tuning functions for Rapier
function setPhysicsParams(gravity, offset, maxSlopeDeg, stepHeight) {
    if (world) {
        world.gravity = { x: 0, y: -gravity, z: 0 };
    }
    if (characterController) {
        characterController.setOffset(offset);
        characterController.setMaxSlopeClimbAngle(maxSlopeDeg * Math.PI / 180);
        characterController.enableAutostep(stepHeight, CC_MIN_STEP_WIDTH, true);
    }
}

// Add to existing window.RapierPhysics export
window.RapierPhysics.setPhysicsParams = setPhysicsParams;
```

### 3.2 Build Script (`build.sh`)

Update the `EXPORTED_FUNCTIONS` array to include the new debug endpoints:

```bash
-s EXPORTED_FUNCTIONS='[..., "_setDebugConfig", "_getDebugConfig"]'
```

## 5. The Debug Panel UI (`client/debug_panel.js`)

This script follows the `lil-gui` pattern [1], creating a floating, collapsible panel. It is loaded conditionally and binds directly to the exposed facades.

```javascript
// @ai-contract
// PURPOSE: Live tuning panel for WASM, Three.js, and Rapier variables using lil-gui
// SERVES: Infrastructure (Development Tooling)
// DEPENDS_ON: Module, window.RapierPhysics, window.DayNight, window.__tribesBloom
// EXPOSES: nothing (self-contained DOM panel)
// PATTERN: IIFE, loads lil-gui from CDN, binds to global facades
// @end-ai-contract

(async function() {
    const params = new URLSearchParams(window.location.search);
    if (!params.has('tune')) return;

    // Load lil-gui dynamically
    const script = document.createElement('script');
    script.src = 'https://cdn.jsdelivr.net/npm/lil-gui@0.21/dist/lil-gui.umd.min.js';
    await new Promise(r => { script.onload = r; document.head.appendChild(script); });

    const GUI = window.lil.GUI;
    const gui = new GUI({ title: 'Firewolf Live Tuning' });

    // --- State Object ---
    const state = {
        // WASM Physics & Combat
        gravity: 20.0,
        skiFriction: 0.998,
        energyRegen: 8.0,
        lightJetForce: 236.0,
        lightMass: 9.0,
        discDamage: 0.5,
        discMuzzleVel: 65.0,
        discGravity: 5.0,

        // Rapier Collision
        rapierGravity: 20.0,
        ccOffset: 0.02,
        ccMaxSlope: 55,
        ccStepHeight: 0.4,

        // Three.js Rendering
        bloomStrength: 0.55,
        bloomThreshold: 0.92,
        timeOfDay: 12.0,

        // Export Function
        exportJson: () => {
            const data = JSON.stringify(state, null, 2);
            navigator.clipboard.writeText(data).then(() => {
                console.log('Exported to clipboard:', data);
                alert('Settings copied to clipboard!');
            });
        }
    };

    // --- Updaters ---
    function updateWasm() {
        if (!window.Module || !window.Module._setDebugConfig) return;
        const jsonStr = JSON.stringify({
            gravity: state.gravity,
            skiFriction: state.skiFriction,
            energyRegen: state.energyRegen,
            lightJetForce: state.lightJetForce,
            lightMass: state.lightMass,
            discDamage: state.discDamage,
            discMuzzleVel: state.discMuzzleVel,
            discGravity: state.discGravity
        });
        window.Module.ccall('setDebugConfig', null, ['string'], [jsonStr]);
    }

    function updateRapier() {
        if (window.RapierPhysics && window.RapierPhysics.setPhysicsParams) {
            window.RapierPhysics.setPhysicsParams(
                state.rapierGravity,
                state.ccOffset,
                state.ccMaxSlope,
                state.ccStepHeight
            );
        }
    }

    function updateRendering() {
        if (window.__tribesBloom) {
            window.__tribesBloom.strength = state.bloomStrength;
            window.__tribesBloom.threshold = state.bloomThreshold;
        }
        if (window.DayNight && window.DayNight.freeze) {
            window.DayNight.freeze(state.timeOfDay);
        }
    }

    // --- Build UI Folders ---
    const fWasm = gui.addFolder('WASM Physics & Combat');
    fWasm.add(state, 'gravity', 5, 40).onChange(updateWasm);
    fWasm.add(state, 'skiFriction', 0.9, 1.0, 0.001).onChange(updateWasm);
    fWasm.add(state, 'energyRegen', 1, 20).onChange(updateWasm);
    fWasm.add(state, 'lightJetForce', 100, 500).onChange(updateWasm);
    fWasm.add(state, 'lightMass', 1, 20).onChange(updateWasm);
    fWasm.add(state, 'discDamage', 0.1, 2.0).onChange(updateWasm);
    fWasm.add(state, 'discMuzzleVel', 10, 200).onChange(updateWasm);
    fWasm.add(state, 'discGravity', 0, 20).onChange(updateWasm);

    const fRapier = gui.addFolder('Rapier Collision');
    fRapier.add(state, 'rapierGravity', 5, 40).onChange(updateRapier);
    fRapier.add(state, 'ccOffset', 0.001, 0.1, 0.001).onChange(updateRapier);
    fRapier.add(state, 'ccMaxSlope', 10, 85).onChange(updateRapier);
    fRapier.add(state, 'ccStepHeight', 0.1, 1.0).onChange(updateRapier);

    const fRender = gui.addFolder('Three.js Rendering');
    fRender.add(state, 'bloomStrength', 0, 2).onChange(updateRendering);
    fRender.add(state, 'bloomThreshold', 0, 1).onChange(updateRendering);
    fRender.add(state, 'timeOfDay', 0, 24).onChange(updateRendering);

    gui.add(state, 'exportJson').name('Export All to Clipboard');

    // Initial Sync
    updateWasm();
    updateRapier();
    updateRendering();
})();
```

## 6. Integration (`index.html`)

To ensure the debug panel loads correctly after the rendering and physics modules are initialized, append the script injection logic near the end of the existing module loading block in `index.html`.

```html
<!-- Inside the script block handling dynamic imports -->
<script>
    var __cacheVer = (document.getElementById('version-chip') || {}).textContent || 'dev';
    
    // Conditionally load the live tuning panel
    if (window.location.search.includes('tune')) {
        var __liveTuningScr = document.createElement('script');
        __liveTuningScr.src = './client/debug_panel.js?v=' + __cacheVer;
        document.head.appendChild(__liveTuningScr);
    }
</script>
```

## 7. Creative Extensions

Once the base panel is functional, consider adding these extensions to improve the developer experience:
- **Preset Snapshots:** Use `gui.save()` and `gui.load()` to provide free preset snapshots. Add a localStorage layer keyed by build version so developers can A/B test feel without losing data.
- **Paper Trail Export:** Add a "Record" toggle that snapshots the state and matching playtest video timestamp into the clipboard JSON, turning tuning sessions into a documented paper trail.
- **Visual Color Coding:** Use `lil-gui`'s CSS variables to create per-armor color-coded folders (e.g., Light=cyan, Medium=amber, Heavy=red), ensuring visual recognition matches the in-game UI.
- **Re-sync Button:** Add a `getDebugConfig()` endpoint and a "Re-sync from WASM" button. If a developer hand-edits values mid-session, the panel can re-read the source of truth.

## References

[1] lil-gui Documentation, https://lil-gui.georgealways.com/
