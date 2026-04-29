# Items 66, 67 — Sky star fade + uTime wrap

**Commit:** `582eb9d` (R32.225)  
**File:** `renderer_sky.js`  
**Severity:** Visual bug (P3)

## Problem (Item 66)
Star fade-in/out during dawn/dusk was frame-rate dependent. At 30fps stars faded twice as slowly as at 60fps, creating inconsistent visual behavior across hardware.

## Fix (Item 66)
Replaced linear per-frame opacity increment with exponential decay: `opacity *= exp(-dt / tau)`. This produces identical fade curves regardless of frame rate. Tau constant tuned for ~2s visible transition.

## Problem (Item 67)
`uTime` uniform incremented without bound. After extended play sessions (hours), floating-point precision loss in the shader caused visual artifacts in animated sky elements.

## Fix (Item 67)
Added wrap at 100,000 seconds. All shader time-dependent calculations use periodic functions (sin/cos) whose period is orders of magnitude smaller, so the wrap is invisible.

## Verification
- Star fade is smooth at both 30fps and 144fps
- No visible discontinuity at the 100k wrap point
