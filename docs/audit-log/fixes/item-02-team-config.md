# Item 2 Review — client/team_config.js + Team Color Inversion Fix (R32.155)

**Change:** New `client/team_config.js` (95 lines IIFE) + bug fix in `renderer_minimap.js` and `renderer_command_map.js` + index.html loader.
**Panel:** Carmack, Muratori, Ive (medium change — Pass 1 + Pass 4 + Pass 5)

---

## Pass 1 — Break It

**Saboteur:**
- **S1 (Medium):** Race condition — team_config.js is loaded via `document.head.appendChild()` just before minimap/command_map. All three are async classic scripts. There's no guarantee team_config executes first. **Mitigation:** Both minimap and command_map have correct hardcoded fallbacks (`['#FF6A4A', '#3FA8FF']`). Even if `window.TEAM_CONFIG` isn't ready, the bug is still fixed. The fallback order is now correct. **Verdict: Acceptable — the bug fix is in the fallback values, not the dynamic lookup.**
- **S2 (Low):** Palette already has `teamColor()` / `teamColorInt()` helpers on `window.PaletteUtils`. Now we also have `window.TEAM_CONFIG` with similar helpers. Two sources of team colors exist. **Verdict:** Palette's colors (#E84A4A, #4A8AE8) differ from team_config's (#C8302C, #2C5AC8). They serve different purposes — palette has HUD-optimized colors, team_config has canonical game colors. Should be documented but isn't a conflict.
- **S3 (None):** The IIFE pattern is safe, tested, same as palette.js.

**Wiring Inspector:**
- **W1 (None):** No broken imports. All dynamic lookups gracefully degrade.
- **W2 (Note):** The `renderer.js` TEAM_COLORS array (line 62: `[0xC8302C, 0x2C5AC8, 0x808080]`) is NOT yet updated to reference team_config. It's still hardcoded. This is acceptable for now — the colors match — but should be migrated in the Tier 2 extraction phase.

## Pass 4 — System-Level Review

**Dependency map:** team_config.js → window.TEAM_CONFIG (global). Consumed by minimap, command_map. No reverse deps.

**The actual bug fix:** Minimap was drawing YOUR team as blue and ENEMY as red regardless of which team you're on. This is because team index 0 (Blood Eagle = RED) was mapped to blue (#3FA8FF). Now corrected.

**Scope:** Surgical. Only 3 files changed. No risk to renderer.js, WASM, or physics.

## Pass 5 — Visual & Feel Review (Ive)

**Color consistency:** The HUD hex colors (`#FF6A4A` for red, `#3FA8FF` for blue) are distinct, readable on dark backgrounds, and match the palette's warm/cool split. On minimap's black canvas, both pop clearly.

**4-tribe future colors:** Phoenix green (#4AFF6A) and Starwolf gold (#FFD44A) are visually distinct from red/blue and from each other. The full 4-color gamut passes the deuteranopia/protanopia test (blue vs gold is safe, red vs green needs the brightness difference, which exists here).

---

## Verdict: ✅ PASS — Ship. The race condition (S1) is mitigated by correct fallbacks. Palette unification (S2) is a nice-to-have for Tier 2, not a blocker.
