# Item 61 — Add HEAPF32 Buffer Assertion in Render Loop

**Status:** Complete
**Commit:** R32.225

## What was done
Added a single-line buffer assertion at the top of the render loop in renderer.js:

```javascript
if (Module.HEAPF32.buffer !== Module.wasmMemory.buffer) console.error('HEAPF32 detached — WASM memory grew unexpectedly');
```

**Location:** renderer.js loop() function, immediately after `Module._tick()` and before Rapier collision step.

**Purpose:** Safety net for the fixed-memory WASM invariant. Under current build config (no -sALLOW_MEMORY_GROWTH), this assertion can never fire. If WASM memory growth is ever enabled in a future build, this catches the silent typed array detachment on the very first frame — before any reads return garbage zeros.

**Performance impact:** Zero measurable. One object identity comparison per frame.

Cross-references `@ai-invariant FIXED_WASM_MEMORY` documented in Item 62.
