# Manus Feedback — Round 14.5 (Light Hotfix + R14 Acceptance)

**MODEL:** SONNET 4.6 (1M context)
**Severity:** P2 (small fixes)
**Round 14 acceptance:** **9/9 PROVISIONAL** — user confirmed terrain/sky/HUD render correctly on real Chrome (not headless); bot AI logic accepted on diff inspection. Final visual sign-off pending model render verification (item 1 below).

---

## 1. Status

User confirmed live build (`2277fcc`) renders correctly on production Chrome — terrain (sandy/grass Raindance hills), sky, compass, score widget, crosshair, building geometry all visible. **Player movement works.**

What user did NOT see in their first 30 seconds at spawn: any **player models** (own first-person if 3rd-person enabled, or any of the 7 bots). Could be (a) bots haven't pathed into view yet — expected, (b) the `dts` model shader is silently failing to link → bots are invisible, (c) bots are spawning at flag positions far from player view.

Manus's headless-Chromium black-canvas false-alarm was due to SwiftShader's incomplete `#version 300 es` support — not a real user-facing bug. Lesson learned: trust user visual reports, use headless for logic/HUD/audio/UX testing only.

---

## 2. P2 Tasks

### 2.1 Verify bot/player model rendering

Add **one printf** at the top of the DTS draw loop (just for this round, removable later):

```cpp
// In drawPlayers() / wherever DTS shader is bound and instances drawn:
static int s_dtsFrameCount = 0;
if((++s_dtsFrameCount % 300) == 1) {  // every ~5 sec at 60fps
    printf("[DTS] frame=%d shader=%u alivePlayers=%d drawn=%d\n",
           s_dtsFrameCount, dtsShader, /*count alive*/, /*count actually drawn*/);
}
```

Two outcomes:
- `dtsShader=0` → shader never linked. Investigate `compS()/linkP()` for `dts*` — most likely a precision qualifier or layout issue. Add `glGetShaderInfoLog` print on failure (already added in R13.1; verify it's actually called for the dts shader).
- `dtsShader>0, drawn=N` where N matches alive count → shader is fine, models *are* being drawn. User just needs to walk toward a bot to confirm.
- `dtsShader>0, drawn=0` → players aren't being submitted to the GPU; check the `for(p:players) if(p.alive && p.team!=spectator) draw()` filter.

### 2.2 Fix warmup timer label (HUD shows 600 instead of 15)

In `broadcastHUD()`, find the `timeRemain` computation. It's currently:
```cpp
int timeRemain = g_timeLimit > 0 ? (int)g_roundTimer : (int)g_warmupTimer;
```
or similar. Change to:
```cpp
int timeRemain = (g_matchState == 0) ? (int)g_warmupTimer : (int)g_roundTimer;
```

The HUD JS `updateMatchHUD()` already formats `WARMUP — MATCH STARTS IN ${seconds}` when `matchState===0`. Just feed it the right number.

**Acceptance:** First 15 seconds after deploy, banner counts down 15→0; then banner becomes blank/`MATCH IN PROGRESS — TIME LEFT: M:SS` and `g_matchState=1`.

### 2.3 Remove dead legacy `gameSettings` fields

`index.html` line ~691:
```js
var gameSettings={botCount:4,scoreLimit:5,timeLimit:600,sensitivity:5,fov:75,invertY:false};
```

Replace with:
```js
var gameSettings={botCount:4,scoreLimit:5,timeLimit:600};  // match-config only; player prefs in ST
```

The `sensitivity:5/fov:75/invertY:false` here are leftovers from before the R13 settings rewrite. Modern code uses `ST.sensitivity / ST.fov / ST.invertY`. Same edit in `shell.html` if it's mirrored there.

### 2.4 (Optional, nice to have) QUICK START actually quick-starts

Currently the "QUICK START" button on main menu routes to the same multi-step Game Setup screen as "PLAY GAME". Wire it to skip the wizard:

```js
// In QUICK START click handler:
selectedTeam = 0; selectedArmor = 0;
gameSettings = {botCount:4, scoreLimit:5, timeLimit:600};
startGame();
```

Skip if it adds time pressure to other items — this is a polish nicety.

---

## 3. Compile/grep guardrails

Same as R13.1:
- `! grep -nE 'EM_ASM[^(]*\(.*\$1[6-9]'` must pass
- New: every `linkP()` call site must call `glGetProgramInfoLog` and `printf` it on link failure (R13.1 added the helper; verify it actually fires for *all four* shaders by intentionally introducing a syntax error in `dtsFS` locally and confirming the `[SHADER]` line appears).

---

## 4. Acceptance gate (must hit 3/4)

1. Live build still renders terrain + sky + buildings (regression check) ✓
2. Warmup banner counts down 15→0 in first 15s after deploy
3. `[DTS] frame=...` printf appears in console with non-zero `drawn` count when bots are spawned
4. Dead `gameSettings` fields removed from `index.html` (and `shell.html` if mirrored)

---

## 5. Time budget

15-25 min. Trivial fixes — no architectural risk.

---

## 6. After R14.5 lands

Manus immediately pushes **R15: Three.js architecture (OPUS, 1M context)**. Three.js eliminates the entire fragile hand-rolled WebGL2 stack — no more silent shader link failures, no more SwiftShader headless-Chromium false alarms, plus we get proper PBR, shadows, post-processing, and a path to glTF/FBX model imports for real Tribes-style player models. R15 will be additive (parallel renderer, no removal of existing code) so we can A/B compare. R16 is the cutover.
