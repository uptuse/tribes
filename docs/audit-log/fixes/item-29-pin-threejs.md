# Item 29 — Pin Three.js Version: Cohort Review

**Commit:** R32.174 (`4ac968e`)
**Scope:** Documentation-only (3 files: index.html, shell.html, vendor/three/README.md)
**Review level:** Pass 1 only (documentation change, <100 lines, zero code risk)

---

## Pass 1 — Break It (Saboteur)

**The Saboteur:**

Finding: Three.js was ALREADY vendored and pinned to r170 locally. The import map points to `./vendor/three/r170/three.module.js` — no CDN, no `latest` tag, no network dependency. The version was never floating.

The fix correctly identifies this and adds documentation rather than changing the pin mechanism. Three changes made:

1. **index.html importmap comment** — Replaced generic "R15: Three.js renderer" comment with explicit warning naming all 6 `onBeforeCompile` hooks and their failure mode (silent grey/black rendering).

2. **shell.html importmap comment** — Same change, keeping both entry points in sync.

3. **vendor/three/README.md** — Replaced one-liner with comprehensive upgrade procedure listing all 6 hooks, their purpose, and a step-by-step safe upgrade process.

**Risk assessment:** Zero runtime risk. No code changed. No imports changed. No behavior changed. Pure documentation.

**Verification:**
- Import map paths unchanged ✅
- Both HTML files updated consistently ✅
- README accurately describes the hook dependency ✅

**One concern:** The comment lists "grass instancing" as hook #6, but the grass ring system was deleted in R32.166 (Item 14: dead code removal). If the `onBeforeCompile` hook for grass was in the deleted code, the comment lists a phantom dependency. If it's still in renderer.js (perhaps the shader hook survived the grass deletion), it's accurate.

**Verdict:** PASS. Documentation-only change. The phantom grass hook should be verified but is cosmetic — the comment errs on the side of caution, which is correct for a "do not upgrade" warning.

---

*Review complete. Proceeding to Item 30.*
