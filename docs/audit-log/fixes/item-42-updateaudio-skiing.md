# Item 42 — updateAudio skiing parameter

**Commit:** `d29fd84` (R32.222)  
**Files:** `tribes.js` (C++ source ASM_CONST), `index.html` (window.updateAudio)  
**Severity:** Bug fix (P2)

## Problem
`updateAudio` was called from C++ with 5 parameters (pos x/y/z, velocity, isSkiing) but the JS side only accepted 4. The 5th parameter (isSkiing flag) was silently dropped, meaning ski sound modulation never received its input.

## Fix
- Updated the C++ ASM_CONST call in tribes.js to pass the 5th parameter
- Updated `window.updateAudio` in index.html to accept the 5th param
- Legacy code path passes 0 (not skiing) to maintain backward compatibility

## Verification
- Parameter count now matches on both sides (5 params)
- Existing audio behavior preserved for non-skiing states
