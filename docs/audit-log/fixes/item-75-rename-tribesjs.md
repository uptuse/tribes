# Item 75 — Rename tribes.js → generated/emscripten_glue.js

**Commits:** `79746b3` (R32.230, file rename), `bdfd024` (R32.231, script ref fix)  
**Files:** `tribes.js` → `generated/emscripten_glue.js`, `index.html`, `.gitattributes`  
**Severity:** Developer experience (P4)

## Problem
`tribes.js` (6,868 lines) is 100% Emscripten-generated WASM bootstrap glue — zero hand-written code. The name suggested it was the core game logic, causing every new reader to waste time reading machine output. This was unanimously flagged in Phase 6 reviews (R1+R2) as "the single highest-impact naming fix."

## Fix
1. `git mv tribes.js generated/emscripten_glue.js`
2. Updated all runtime references in `index.html`:
   - `<link rel="preload" as="script" href="...">` 
   - `<script async src="...">` tag
   - Comment references
3. Added `.gitattributes` with `linguist-generated=true` to suppress GitHub diffs and exclude from language statistics (was 34% of total repo LOC)

**Note:** R32.230 performed the file rename and added `.gitattributes` but missed the runtime script tag updates. R32.231 fixed this critical oversight — without it, the WASM bootstrap would 404.

## Remaining
- `renderer.js` has 2 comment references to the old name (documentation-only)
- Many `docs/` files reference `tribes.js` in historical audit context — left as-is since they describe past findings
