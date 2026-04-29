# Items 57, 58, 59 — Character system cleanup

**Commit:** `8a0f3a4` (R32.226)  
**File:** `renderer_characters.js`  
**Severity:** Performance + code health (P3)

## Item 57: Frustum culling enabled
Characters had `frustumCulled = false`, meaning every character mesh was drawn every frame even when off-screen. Set `frustumCulled = true` on all character meshes. Three.js handles the bounding sphere check automatically.

## Item 58: Dead demo code removal
Removed ~80 lines of dead demonstration/test code that was never called in production. This included hardcoded test positions, debug visualization helpers, and placeholder animation sequences from early development.

## Item 59: Init guard
Added an initialization guard to prevent double-init of the character system. If `initCharacters()` is called when the system is already initialized, it now returns early instead of creating duplicate resources.

## Verification
- Frustum culling reduces draw calls when characters are off-screen
- No behavioral change — removed code had no callers
- Double-init is now safely idempotent
