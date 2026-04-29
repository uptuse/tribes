# Items 47, 72, 73 — Polish module cleanup

**Commit:** `cdf0224` (R32.227)  
**File:** `renderer_polish.js`  
**Severity:** Code health + bug prevention (P3)

## Item 47: removeGeneratorChimney()
Added `removeGeneratorChimney()` cleanup function. Generator smoke particles were created but never cleaned up on map change or generator destruction, causing a slow particle leak.

## Item 72: Dead _playFlagSting removal
Deleted `_playFlagSting` — a stub function that was never called. It referenced an audio system API that doesn't exist, so it would have thrown if ever invoked.

## Item 73: Lightning setTimeout guard
Lightning flash effects used bare `setTimeout` calls without tracking or cancellation. Added guards to:
- Clear pending timeouts on system teardown
- Prevent stacking if multiple lightning events fire in quick succession
- Null-check the scene reference before accessing it in the timeout callback

## Verification
- Generator smoke properly cleaned up on map transitions
- No dead code remains in the flag pickup path
- Lightning timeouts are properly managed and don't leak
