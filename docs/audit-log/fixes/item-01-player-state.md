# Item 1 Review — client/player_state.js (R32.154)

**Change:** New file `client/player_state.js` — 42 lines, shared WASM stride constants.
**Panel:** Carmack, Muratori (small change, Pass 1 + Pass 4 only)

---

## Pass 1 — Break It

**Saboteur:**
- **S1 (Low):** The file exports `PLAYER_STRIDE = 32` as a constant, but renderer.js gets stride dynamically via `Module._getPlayerStateStride()`. If WASM ever changes stride to something other than 32, this constant would be stale. **Verdict:** Acceptable — the constant is documented as "should match" and the dynamic call remains authoritative. This is a documentation aid, not the source of truth for runtime stride. Consumers that already call `_getPlayerStateStride()` should continue doing so.
- **S2 (None):** Offset 5 is marked "unused / padding." If WASM later uses offset 5 for something, consumers reading 4,5,6 would still be wrong. **Verdict:** Non-issue — the whole point is to update THIS file when the struct changes.
- **S3 (None):** `Object.freeze()` prevents accidental mutation at runtime. Good defensive pattern.

**Wiring Inspector:**
- **W1 (None):** No imports, no side effects, pure data export. Cannot break anything by existing.
- **W2 (Note):** File is ES module but renderer_polish.js is an IIFE loaded via `<script>` tag. Polish can't `import` from this file directly. The polish fix (Item 6) will need to either: (a) convert polish to ES module, or (b) expose PV on `window`. **Action needed in Item 6.**

## Pass 4 — System-Level Review

**Dependency map:** Zero dependencies. Exports only. Clean leaf module.

**Interface contract:** Exports `PV` (frozen object), `MAX_PLAYERS` (16), `PLAYER_STRIDE` (32).

**Should this exist?** Yes — unanimously. This is the single highest-impact maintenance fix for the codebase. Every magic number `playerView[o + 13]` becomes `playerView[o + PV.ALIVE]`. Self-documenting, grep-able, single update point.

**Concern:** No consumer has been updated yet. The value of this file is zero until Items 6+ import from it. **Track adoption.**

---

## Verdict: ✅ PASS — Ship as-is. Address W2 (IIFE compatibility) in Item 6.
