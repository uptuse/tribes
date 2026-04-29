# Items 70, 71 — Audio system fixes

**Commit:** `c6443d3` (R32.228)  
**File:** `client/audio.js`  
**Severity:** Bug fix (P2)

## Item 70: Blaster sound case mapping
The plasma blaster fire sound was mapped to `case 0` (silent/undefined) instead of the correct `PLASMA_FIRE` constant. This caused weapon fire events to produce no sound for the plasma weapon.

**Fix:** Changed `case 0` to the correct `PLASMA_FIRE` enum value in the sound dispatch switch.

## Item 71: isReady() context state check
`AE.isReady()` only checked if the AudioContext existed, not whether it was in a usable state. On mobile browsers, the AudioContext starts in `'suspended'` state until a user gesture. Code calling `isReady()` would attempt to play sounds into a suspended context (silently failing).

**Fix:** Added `ctx.state !== 'suspended'` check to `isReady()`. The context is only considered ready when it's in the `'running'` state.

## Verification
- Plasma blaster now plays the correct fire sound
- Audio initialization properly gates on context state, not just existence
