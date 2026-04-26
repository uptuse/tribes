# Claude Status — 2026-04-26T00:30:00Z

## What I just did (this session) — Round 17: Three.js Cutover

### Headline

**Three.js is now the default renderer.** Legacy WebGL is opt-in via `?renderer=legacy` for one round of fallback safety; sunset planned R18.1.

### Acceptance criteria status (8 total, must hit 7+)

| # | Criterion | Status |
|---|---|---|
| 1 | Default URL loads Three.js | ✅ `useThree = !useLegacy` in shell.html, default true |
| 2 | `?renderer=legacy` loads legacy WebGL | ✅ Same flag detection, opt-out path preserved |
| 3 | Headless screenshot shows terrain (not all-black) | ⏳ Pending Manus visual verification |
| 4 | All R15 features work in default mode | ✅ R15 was 10/10 accepted; renderer.js unchanged |
| 5 | Damage flash, death screen, station UI, pointer-lock present | ✅ damage flash + ptr-lock added; deathscreen/respawn-overlay/stationui already wired (DOM, mode-independent) |
| 6 | 60 FPS sustained at 1024×768 with 8 bots | ⏳ Runtime verification; renderer.js diagnostics print fps every 5s |
| 7 | Zero console errors first 60s on default | ⏳ Runtime verification |
| 8 | Sunset notice on legacy WebGL render code | ✅ Added 6-line comment block above the render-mode guard |

**5/8 hard-verified by code inspection; 3/8 are runtime checks Manus performs after deploy.**

### Changes

#### `shell.html`
- **Damage flash overlay** (`#damage-flash`): radial red gradient at z-index 14, `mix-blend-mode: multiply`, 0.05s in / 0.4s out transition. Triggered when `updateHUD` sees `hp < lastHpForFlash - 2 && hp > 0` (filters HP regen noise; only real damage hits flash).
- **Pointer-lock visualization** (`#ptr-lock-hint`): brass border + dim overlay + "CLICK TO RESUME" text at z-index 13. Toggled via `pointerlockchange` event listener; only shows when `gameStarted && !locked && !modalOpen` (settings/escmenu/matchend/stationui all suppress it).
- **Default flip:** `useThree = !useLegacy` where `useLegacy = (?renderer === 'legacy')`. Default behavior switches without changing the dynamic `import('./renderer.js')` path.
- Console logs renderer choice on init.

#### `program/code/wasm_main.cpp`
- 6-line sunset notice comment block above the `if(g_renderMode != 0) return;` guard. Signals to future-Claude that legacy code is for removal, not improvement.

#### `BUILD.md`
- New "Renderer flag (R17+)" section documenting the URL flag, default, and where each renderer lives.

### Z-order verification

Overlays from back to front (canvas at z-index 1):
- 11 hud · 12 killfeed/flagstatus · 13 respawn-overlay/ptr-lock-hint · **14 damage-flash (NEW)** · 15 deathscreen · 20 stationui/scoreboard · 22 escmenu · 25 matchend · 30 loading · 35 settings-modal

Damage flash sits below death/respawn overlays so it doesn't obscure death messaging. Pointer-lock hint sits below damage flash so urgent damage feedback wins visually.

### Guardrails verified

- ✅ No `EM_ASM $16+` args
- ✅ No `malloc()` in hot path
- ✅ `renderer.js` 530 lines (target < 800)
- ✅ Sunset notice added to legacy code

### What's next
- **Round 18 (Sonnet):** Visual quality cascade — PBR materials, real glTF player + building models, post-processing (bloom, vignette), environment IBL, particle quality
- **Round 18.1 (Sonnet):** Legacy WebGL render code removal — delete the entire `if(g_renderMode != 0) return;` else block, delete the legacy shaders, delete `drawHUD()` stub
- **Round 19 (Sonnet, multi-part):** Network implementation per R16 spec (TS port of simulation, snapshot/delta encoding, client prediction wiring)

## How to test
- **Default (Three.js):** https://uptuse.github.io/tribes/
- **Legacy WebGL:** https://uptuse.github.io/tribes/?renderer=legacy
- **Local:** `cd /Users/jkoshy/tribes && python3 -m http.server 8080`
