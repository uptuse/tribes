# Item 36 — Define Phase System Hooks

## Status: COMPLETE (R32.271)

## What Changed
- **Created `client/phase_system.js`**: Self-initializing IIFE that defines the phase system infrastructure:
  - Phase enum: `CLEAR`, `FOG`, `STORM`, `BLIZZARD`, `NIGHT_OPS`
  - Listener registration: `registerListener(obj)` / `unregisterListener(obj)`
  - Gradual transitions: `setPhase(phase, durationSec)` with cubic ease-in-out
  - Per-frame update: `update(dt)` drives interpolation and notifies listeners
  - Utility: `getVisibilityMultiplier()` returns 0.0–1.0 based on current phase state
  - Exposed as `window.PhaseSystem`

- **Added stub hooks to 7 modules**:
  - `renderer_sky.js` — exported `registerPhaseHooks()` + listener stub
  - `renderer_daynight.js` — inline listener stub (NIGHT_OPS → force dayMix)
  - `renderer_weather.js` — listener stub (PRIMARY consumer — maps phase to weather)
  - `renderer_combat_fx.js` — listener stub (STORM lightning, NIGHT_OPS IR tracers)
  - `renderer_minimap.js` — listener stub (FOG → radar range, NIGHT_OPS → dim)
  - `renderer_command_map.js` — listener stub (FOG → range reduction, STORM → overlay)

- **Updated `index.html`**: Added phase_system.js script tag after team_config.js, before command_map/minimap

## Design Decisions
- **Gradual transitions only**: Phase changes interpolate over `durationSec` using cubic easing. No instant snaps.
- **Listener pattern**: Each module registers an object with `onPhaseChange(event)`. Event contains `fromPhase`, `toPhase`, `progress`, `easedProgress`, `complete`, and `phaseName`.
- **Visibility multiplier**: Centralized mapping from phase → visibility (1.0 for CLEAR, 0.15 for BLIZZARD). All modules can reference one value.
- **Stubs only**: No actual phase gameplay is implemented. This is pure infrastructure that future commits will consume.

## Next Steps
- Wire `PhaseSystem.update(dt)` into the main render loop in renderer.js
- Implement actual weather/visibility effects in each listener
- Add server-side phase trigger logic
- Connect phase transitions to game timer (e.g., phase change every 5 minutes)

## Testing
- Load page, verify `window.PhaseSystem` exists and `Phase` enum is accessible
- Test `PhaseSystem.setPhase(PhaseSystem.Phase.STORM, 5)` in console — should log transition
- Verify no errors from stub listeners
