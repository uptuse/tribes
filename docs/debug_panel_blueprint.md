# Firewolf Live Debug Tuning Panel Blueprint

This document outlines the code drops required to implement the live tuning debug panel across the WASM, JS, and Rapier layers of Firewolf.

## 1. `wasm_main.cpp` Modifications

### Tunable State Definitions
```cpp
// ============================================================
// Debug Tuning State (R32.XXX)
// ============================================================
static float g_dbg_gravity = 20.0f;
static float g_dbg_skiFriction = 0.998f;
static float g_dbg_energyRegen = 8.0f;

// We need mutable copies of the const armors and weapons
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

### JSON Bridge
```cpp
extern "C" void setDebugConfig(const char* json) {
    initDebugState();
    
    // Physics
    g_dbg_gravity = (float)sGetF(json, "gravity", g_dbg_gravity);
    g_dbg_skiFriction = (float)sGetF(json, "skiFriction", g_dbg_skiFriction);
    g_dbg_energyRegen = (float)sGetF(json, "energyRegen", g_dbg_energyRegen);

    // Example Armor tuning (Light)
    g_dbg_armors[0].jetForce = (float)sGetF(json, "lightJetForce", g_dbg_armors[0].jetForce);
    g_dbg_armors[0].mass = (float)sGetF(json, "lightMass", g_dbg_armors[0].mass);
    
    // Example Weapon tuning (Disc)
    g_dbg_weapons[WPN_DISC].damage = (float)sGetF(json, "discDamage", g_dbg_weapons[WPN_DISC].damage);
    g_dbg_weapons[WPN_DISC].muzzleVel = (float)sGetF(json, "discMuzzleVel", g_dbg_weapons[WPN_DISC].muzzleVel);
}

// Return current state as JSON string
static char g_dbg_jsonBuf[2048];
extern "C" const char* getDebugConfig() {
    initDebugState();
    snprintf(g_dbg_jsonBuf, sizeof(g_dbg_jsonBuf),
        "{\"gravity\":%.2f,\"skiFriction\":%.4f,\"energyRegen\":%.2f,"
        "\"lightJetForce\":%.2f,\"lightMass\":%.2f,"
        "\"discDamage\":%.2f,\"discMuzzleVel\":%.2f}",
        g_dbg_gravity, g_dbg_skiFriction, g_dbg_energyRegen,
        g_dbg_armors[0].jetForce, g_dbg_armors[0].mass,
        g_dbg_weapons[WPN_DISC].damage, g_dbg_weapons[WPN_DISC].muzzleVel);
    return g_dbg_jsonBuf;
}
```

## 2. `build.sh` Updates
Add `_setDebugConfig` and `_getDebugConfig` to the `EXPORTED_FUNCTIONS` array.

## 3. `renderer_rapier.js` Facade
```javascript
// Expose tuning functions
function setPhysicsParams(gravity, offset, maxSlope, stepHeight) {
    if (world) world.gravity = { x: 0, y: -gravity, z: 0 };
    if (characterController) {
        characterController.setOffset(offset);
        characterController.setMaxSlopeClimbAngle(maxSlope);
        characterController.enableAutostep(stepHeight, CC_MIN_STEP_WIDTH, true);
    }
}

// Add to window.RapierPhysics export
window.RapierPhysics.setPhysicsParams = setPhysicsParams;
```

## 4. `client/debug_panel.js` (lil-gui implementation)
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
    if (!params.has('debug')) return;

    // Load lil-gui dynamically
    const script = document.createElement('script');
    script.src = 'https://cdn.jsdelivr.net/npm/lil-gui@0.21/dist/lil-gui.umd.min.js';
    await new Promise(r => { script.onload = r; document.head.appendChild(script); });

    const GUI = window.lil.GUI;
    const gui = new GUI({ title: 'Firewolf Live Tuning' });

    // --- State Object ---
    const state = {
        // WASM Physics
        gravity: 20.0,
        skiFriction: 0.998,
        energyRegen: 8.0,
        lightJetForce: 236.0,
        lightMass: 9.0,
        discDamage: 0.5,
        discMuzzleVel: 65.0,

        // JS Rapier
        rapierGravity: 20.0,
        ccOffset: 0.02,
        ccMaxSlope: 55,
        ccStepHeight: 0.4,

        // JS Three.js
        bloomStrength: 0.55,
        bloomThreshold: 0.92,
        exposure: 1.0,
        timeOfDay: 12.0,

        exportJson: () => {
            const data = JSON.stringify(state, null, 2);
            navigator.clipboard.writeText(data);
            console.log('Exported to clipboard:', data);
            alert('Settings copied to clipboard!');
        }
    };

    // --- Updaters ---
    function updateWasm() {
        if (!window.Module || !window.Module._setDebugConfig) return;
        const jsonStr = JSON.stringify(state);
        window.Module.ccall('setDebugConfig', null, ['string'], [jsonStr]);
    }

    function updateRapier() {
        if (window.RapierPhysics && window.RapierPhysics.setPhysicsParams) {
            window.RapierPhysics.setPhysicsParams(
                state.rapierGravity,
                state.ccOffset,
                state.ccMaxSlope * Math.PI / 180,
                state.ccStepHeight
            );
        }
    }

    function updateRendering() {
        if (window.__tribesBloom) {
            window.__tribesBloom.strength = state.bloomStrength;
            window.__tribesBloom.threshold = state.bloomThreshold;
        }
        // Exposure needs renderer access, could be added to postprocess facade
        if (window.DayNight && window.DayNight.freeze) {
            window.DayNight.freeze(state.timeOfDay);
        }
    }

    // --- Build UI ---
    const fWasm = gui.addFolder('WASM Physics & Combat');
    fWasm.add(state, 'gravity', 5, 40).onChange(updateWasm);
    fWasm.add(state, 'skiFriction', 0.9, 1.0, 0.001).onChange(updateWasm);
    fWasm.add(state, 'energyRegen', 1, 20).onChange(updateWasm);
    fWasm.add(state, 'lightJetForce', 100, 500).onChange(updateWasm);
    fWasm.add(state, 'lightMass', 1, 20).onChange(updateWasm);
    fWasm.add(state, 'discDamage', 0.1, 2.0).onChange(updateWasm);
    fWasm.add(state, 'discMuzzleVel', 10, 200).onChange(updateWasm);

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

    // Initial sync
    updateWasm();
    updateRapier();
    updateRendering();
})();
```

## 5. `index.html` Integration
```html
<!-- Load after WASM and Renderer are ready -->
<script>
  var __cacheVer = (document.getElementById('version-chip') || {}).textContent || 'dev';
  var __liveTuningScr = document.createElement('script');
  __liveTuningScr.src = './client/debug_panel.js?v=' + __cacheVer;
  document.head.appendChild(__liveTuningScr);
</script>
```
