# Bug: Options Menu Triggers Persistent Third-Person Camera

**Author:** Manus AI  
**Date:** 2026-04-29

## Problem Statement

Opening the Options/Settings menu (via Esc or the settings cog) forces the game into a third-person chase camera. This change persists even after the Options menu is closed.

This is a **regression** that appeared during the Phase A editor work, likely related to the pointer-lock release/reacquire flow or the `applyToCpp()` JSON composition that runs when the Options modal closes.

**Note:** This is a *different* issue from the FOV-reset bug fixed in commit `97fd339`. That fix isolated the new physics sliders; this bug affects the existing Options modal.

## Steps to Reproduce

1. Start a match in Raindance.
2. Confirm you are in the normal first-person state (weapon view-model visible in foreground, crosshair centered).
3. Open the Options/Settings modal (press `Esc` or click the cog).
4. Close the Options modal without changing any settings.
5. **Observe:** The camera is now in a third-person chase view behind the player. The weapon view-model is gone. This state persists.

## Evidence

See `docs/bug_screenshots/` for visual proof:
- `before_1_first_person.webp` — Normal first-person state before opening Options.
- `before_2_first_person.webp` — Normal first-person state (different angle).
- `after_1_third_person_editor_open.webp` — Stuck in third-person after opening Options.
- `after_2_third_person_editor_closed.webp` — Stuck in third-person after Options is closed.

## Suspected Root Cause

One of the Options modal handlers is inadvertently toggling the `cameraMode` or setting the view target to the player entity's external follow camera. 

When the Options modal closes, it calls `applyToCpp()` which composes a JSON string and sends it to `Module._setSettings()`. While commit `97fd339` removed the physics tuning from this path, the path itself might still be triggering a camera state reset in `wasm_main.cpp` or in the JavaScript `renderer_camera.js` listener that reacts to settings changes.

Alternatively, the handler that runs when pointer lock is released (due to the modal opening) might be setting `cameraMode = 'thirdperson'` as a fallback.

## Requested Fix

1. Identify the exact function that flips the camera when Options opens or closes.
2. Guard it so it only runs if the user explicitly requested third-person (e.g., via a dedicated toggle key, if one exists).
3. Verify the fix does not reintroduce the FOV reset bug from `97fd339`.
4. Ensure that opening and closing Options leaves the camera exactly as it was before the modal opened.
