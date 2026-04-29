# Item 41 — _restartGame phantom export

**Commit:** `d4de7b7` (R32.223)  
**File:** docs/lessons-learned.md  
**Severity:** Documentation (P4)

## What Was Done
Documented that `_restartGame` does not exist in the WASM export table. `index.html` guards the call with `if(Module._restartGame)`, so it never crashes — but it's dead code calling a phantom export. Added this to lessons-learned as an architectural note.

## Verification
- Searched all 6,868 lines of tribes.js — zero matches for `restartGame`
- The guard prevents runtime errors
- No code change needed; documentation-only fix
