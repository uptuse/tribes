# Item 14 Correction — Defer Rain Allocation

## Change Summary
The original Item 14 was to delete rain as "dead code." The gap analysis corrected this: rain is LIVE code (opt-in via `?rain=on`), but the `initRain()` function allocated unconditionally when called, and `updateRain()` was called every frame even when rain wasn't initialized.

**Commit:** `fix(R32.202): defer rain system allocation until enabled` — 06b359c

## Changes Made

1. **Added `_rainEnabled` flag** (L3173): `let _rainEnabled = false;`
2. **Idempotent guard in `initRain()`**: `if (_rainEnabled) return;` at function entry — prevents double allocation
3. **Set `_rainEnabled = true`** at end of `initRain()` after geometry + mesh created
4. **Guarded `updateRain()` call** in render loop (L5024): `if (_rainEnabled) updateRain(...)` — skips per-frame update when rain not allocated

## Before/After
- **Before:** `updateRain()` called every frame unconditionally. Null guard inside caught it, but function call overhead was wasted.
- **After:** `_rainEnabled` flag gates both init (idempotent) and update (no-op skip). Rain system only runs when explicitly enabled via `?rain=on`.

## Cohort Review

### Pass 1 — Structural Integrity (Carmack)
**PASS.** Clean defensive pattern. The `_rainEnabled` flag is set only after successful allocation, so there's no window where updates run on partial state. The idempotent guard in `initRain()` prevents double-allocation if called from multiple paths in the future.

## Risk Assessment
**LOW.** Pure guard addition. No behavioral change for users with `?rain=on` (flag is set after init). No behavioral change for users without it (flag stays false, update skipped).
