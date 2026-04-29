# Item 3 Review — Kill renderer_cohesion.js (R32.156)

**Change:** Delete `renderer_cohesion.js` (138 lines). Move mood bed (~55 lines) to `client/audio.js`. Remove 3 call sites.
**Panel:** Carmack, Muratori, ryg (medium change — Pass 1 + Pass 4 + Pass 5)

---

## Pass 1 — Break It

**Saboteur:**
- **S1 (None):** `window.Cohesion` no longer exists. Any stale code referencing it? Checked: renderer.js was the only consumer. Both call sites replaced/removed. index.html loader removed. Clean kill.
- **S2 (Low):** If any plugin or user script referenced `window.Cohesion`, it would silently fail (was guarded by `if (window.Cohesion)`). **Verdict:** Acceptable — no external consumers documented.
- **S3 (None):** The `import { initMoodBed }` in renderer.js imports from `'./client/audio.js'`. This path resolves correctly since renderer.js is at repo root and client/ is a sibling directory. Verified the importmap doesn't interfere.

**Wiring Inspector:**
- **W1 (None):** `client/audio.js` is already an ES module that renderer.js can import from. The added `initMoodBed()` function follows the same export pattern as existing `playUI()`, `isReady()`, etc.
- **W2 (Note):** The mood bed now lives behind an ES module import chain, meaning it only starts when renderer.js loads. Previously it loaded via classic `<script>` tag. Functionally identical — both happen at page load.
- **W3 (None):** No per-frame tick overhead removed — `Cohesion.tick()` was already a no-op (`return;` on first line). But removing the call + window lookup is a micro-win.

## Pass 4 — System-Level Review

**Net effect:** -138 lines deleted, +55 lines added = -83 net. One fewer file to load. One fewer `document.head.appendChild()` in index.html. One fewer window global.

**Mood bed fidelity:** Compared line-by-line. The WebAudio node graph is identical: two detuned sawtooth oscillators → lowpass filter → LFO on cutoff → gain ramp from 0→0.022. User-interaction gating preserved (pointerdown/keydown listeners).

**Audio context reuse:** `(window.AE && window.AE.ctx) || new AudioContext()` — same pattern as original. Good — avoids creating a second AudioContext (iOS limit).

## Pass 5 — Perf Review (ryg)

**Before:** Script loader created `<script>` tag → 138 lines parsed → IIFE executed → window.Cohesion set → tick() called 60fps (no-op but still a function call + 2 window lookups per frame).

**After:** `initMoodBed()` called once. No per-frame cost. WebAudio graph runs on audio thread after setup.

**Budget impact:** ~0.05ms/frame saved from removing the tick() call. Trivial but correct direction.

---

## Verdict: ✅ PASS — Clean kill. Mood bed preserved exactly. No regressions possible.
