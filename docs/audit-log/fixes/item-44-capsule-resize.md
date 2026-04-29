# Item 44 — Capsule resize for armor types

**Commit:** `6fced79` (R32.224)  
**File:** `renderer_rapier.js`  
**Severity:** Gameplay (P2)

## Problem
Player capsule collider used a fixed size regardless of armor type. Light, medium, and heavy armors should have distinct collision volumes matching their visual scale.

## Fix
Added `resizeCapsuleForArmor()` function with three tiers:
- **Light:** smaller radius/height for agile movement
- **Medium:** default dimensions
- **Heavy:** larger capsule matching the bulkier model

Called on armor change events to dynamically resize the Rapier capsule collider.

## Verification
- Each armor tier produces visually distinct collision bounds
- Capsule resize is idempotent (safe to call multiple times)
