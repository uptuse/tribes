# Item 27 — Rename client/quant.js → client/quantization.js

**Commit:** R32.178 (6c3f728) — also fixed a **live broken import** left by prior commit
**Date:** 2026-04-29
**Panel:** Muratori, Fiedler (scaled review — small rename + hotfix, Pass 1 + Pass 4)

---

## Pass 1 — Break It

**Saboteur:** This rename caught an actual bug.

1. **Import path updated?** Yes — `client/wire.js` line 22 changed from `'./quant.js'` to `'./quantization.js'`. ✅
2. **Was the old import broken?** YES. A prior commit (`185fa31`) renamed the file via `git mv` but did NOT update the import in `wire.js`. This meant `wire.js` was importing `./quant.js` which no longer existed → 404 → the entire networking stack would fail to load. **This commit fixes a live regression.** ⚠️→✅
3. **Any other importers?** No — only `wire.js` imports `quantization.js`. ✅
4. **Header comment updated?** Yes — rename note added. ✅
5. **Server-side mirror?** The header says "MUST match server/quant.ts (re-exports this file)." The server is a separate repo and needs to update its import path. ⚠️ (out of scope, noted — same as Item 26)
6. **Git history preserved?** `git mv` used in the original rename. ✅

**Verdict: This commit fixes a live bug AND completes the rename. Critical fix.**

---

## Pass 4 — System-Level Review

**Fiedler:** The networking import chain is: `index.html` → dynamic import `client/network.js` → static import `client/wire.js` → static import `client/quantization.js`. If `quantization.js` 404s, `wire.js` fails to load, `network.js` fails to load, and multiplayer is dead. This was a P0 regression hiding in a "docs" commit. Good catch.

**Muratori:** This is a process lesson. The prior commit (`185fa31`) was labeled "docs: add cohort review logs" but it also included a `git mv` rename. That's two unrelated changes in one commit — a docs addition and a file rename. The rename needed its own commit with its own import updates. Mixing them caused the import to be missed.

**Fiedler:** The fix is correct. `./quantization.js` is the right path. The rename itself is good — "quant" was opaque shorthand that only makes sense if you already know what quantization is. "quantization" is self-documenting.

**Verdict: Clean fix. Process lesson logged.**

---

## Summary

| Check | Status |
|---|---|
| Import path updated | ✅ (fixes live regression) |
| No broken references | ✅ |
| Header comment updated | ✅ |
| Git history preserved | ✅ |
| Version chip bumped | ✅ (R32.178) |
| Server path noted | ⚠️ Out of scope |
| Process lesson | ⚠️ Don't bundle renames with docs commits |
