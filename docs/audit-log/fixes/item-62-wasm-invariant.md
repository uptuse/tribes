# Item 62 — Document Fixed-Memory WASM Invariant

**Status:** Complete
**Commit:** R32.224

## What was done
Documented the fixed-memory WASM invariant in 3 locations:

1. **renderer.js** — Added `@ai-invariant FIXED_WASM_MEMORY` block near the HEAPF32 usage comment (top of file). Documents: why views are safe, what would break if growth is enabled, reference to tribes.js L4354.

2. **docs/system-map.md** — Updated Known Hazards entry #1 from "No mitigation currently in place" to comprehensive status: explains current non-issue, references abortOnCannotGrowMemory, documents the render loop assertion, and explains what must change if the invariant is ever relaxed.

3. **docs/ai-rules.md** — Added "Can I enable -sALLOW_MEMORY_GROWTH?" decision tree entry. Warns that it requires major refactor and references the @ai-invariant tag.

This directly addresses the Run 1 → Run 2 correction where HEAPF32 detachment was initially rated CRITICAL but downgraded to NON-ISSUE once fixed memory was verified.
