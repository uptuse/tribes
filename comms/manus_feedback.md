# R31.3 Manus Brief — "Make Solo Playtest Feel Like Tribes"

**Author:** new-Manus
**Date:** 2026-04-26
**Round type:** Mechanics + diagnostics + a Ski HUD
**Estimated scope:** 90–150 min
**Acceptance threshold:** 8/10

R31.2 (HDRI sky + composite weapon) is shipped and acceptable. Hard pivot to mechanics — user mandate is *"not worried about assets, just want mechanics nailed for playtest. Lead the design effort."*

---

## TL;DR for Claude

User playtested R31.2 in real Chrome and reported, verbatim:

- *"It almost seemed like I went through the terrain. I don't remember if I was skiing."* → I found the bug (F0 below). The terrain clamp at `wasm_main.cpp:1941` skips `vel.y=0` when skiing, so a skiing player tunnels through their own clamp every frame.
- *"Honestly everything has been janky overall."* → Seven specific deviations from canonical T1 (F1–F7), each a small diff. Coefficients are right; the math around them is wrong.
- *"Bots were doing stuff, moving around."* → AI is alive. No AI work this round.
- *"I could tell its shot, I don't know if it splashed."* → Add hit-confirmation crosshair tick (D2).
- *"Can we put some kind of UI element to help show that the user is skiing or like what the degree of skiing is?"* and *"just do whatever is easy and push it."* → Ski HUD (D1): SKI badge + slope dial + speed readout.

Total ship: 8 C++ feel-fixes (~50 lines), 4 diagnostics, 1 HUD widget. All in a single round.

---

## 1 · Code-level audit (ground truth)

I reviewed `program/code/wasm_main.cpp:1700-2105` and `client/constants.js` against the canonical T1 reference numbers in `comms/master_plan.md`. **The skeleton and coefficients are correct** (`jetForce 236`, `mass 9`, `jumpImpulse 75`, `maxFwdSpeed 11`, `maxJetFwdVel 22` for Light all match T1 verbatim).

The "janky" feeling comes from **eight specific code-level deviations**:

| # | File:Line | Current | Intended | Felt as | Sev |
|---|---|---|---|---|---|
| **F0** | `wasm_main.cpp:1941-1943` | When skiing, terrain clamp sets `pos.y=th+1.8f` but **skips `vel.y=0`** because of `&&!me.skiing` guard; downward velocity persists; player oscillates through surface each frame | After clamp, *always* zero negative `vel.y`. Skiing should not gate the clamp's velocity reset, only its lateral friction reset. | "Went through the terrain" | **P0** |
| **F1** | `wasm_main.cpp:1827` | `gravity = 25.0f` | T1 SimMovement ≈ `20.0f` | Drop-rate 25 % too fast; airtime feels short | P1 |
| **F2** | `wasm_main.cpp:1817` | `me.skiing = keys[16] && me.onGround` — ski state lost on any airborne frame | Persist ski state for 0.25 s of airtime so mogul bounces don't reset to friction | "Stuck on rolling hills" | P1 |
| **F3** | `wasm_main.cpp:1857` | Air-control adds velocity uncapped (`vel += moveDir * maxFwdSpeed * 0.5 * dt`) | Cap horizontal air-acc to `maxJetFwdVel`; input nudges direction, doesn't accelerate forever | "Drifty in air" | P1 |
| **F4** | `wasm_main.cpp:1882-1895` | Jet split always reserves ≥ 20 % vertical (`maxJetSideForce = 0.8` clamps `pct`) even when player is at top forward speed | T1 split: `vertPct = 1 - clamp(forwardDot/maxJetFwdVel, 0, 1)`; at max forward speed all jet is horizontal | "Jet feels mushy when ski-jetting" | **P0** |
| **F5** | `wasm_main.cpp:1922-1928` | Jump impulse multiplied by magic `*0.4f` Y, `*0.3f` lateral; result: weak jumps | Apply `jumpImpulse / mass` along surface normal at full magnitude; lateral input only nudges | "Jumps don't lift" | P1 |
| **F6** | `wasm_main.cpp:1018` | All projectiles inherit `p.vel * 0.5f` | Per-weapon: Blaster 0.0, Chaingun 0.0, Disc 0.5, Grenade 0.5, Plasma 0.3, Mortar 1.0, Laser 0 | Mortar lobs feel uncoupled from skiing speed | P2 |
| **F7** | `wasm_main.cpp:1903` | Energy regen flat `+= 8.0 * dt` for all armors | Per-armor `energyRegenMul` (Light 1.0, Medium 0.85, Heavy 0.6) — already specified in `client/constants.js:CLASSES[].energyRegenMul`, never wired into C++ | Tier identity blurred; Light not zippy enough | P1 |

Diagnostic / playtest-blocker work:

| # | What | Severity |
|---|---|---|
| **D1 — Ski HUD** (user request) | Three new HUD elements (see §3.3) | **P0** |
| **D2 — Hit confirmation** | When any local-player projectile causes damage, fire UI sound + flash crosshair tick mark for 200 ms | **P1** |
| **D3 — Per-frame perf log** | Every 60 frames print `[PERF] dt=<ms> physics=<ms> render=<ms>` to root-cause the 3 fps spike user observed | **P1** |
| **D4 — Pointer-lock resilience** | Verify "CLICK TO RESUME" overlay actually re-acquires pointer-lock on click, not just unpauses | **P2** |

---

## 2 · Code changes (C++)

### F0 — Terrain clamp must always zero downward velocity (`wasm_main.cpp:1941-1943`)

```diff
  me.pos.y=th+1.8f;
- if(me.vel.y<0&&!me.skiing)me.vel.y=0;
+ if(me.vel.y<0)me.vel.y=0;            // ALWAYS zero negative vy after clamp; otherwise we re-tunnel next frame
  if(!me.skiing){me.vel.x*=0.9f;me.vel.z*=0.9f;}
```

This is the single highest-value fix. The user's "I went through the terrain" almost certainly maps to this.

### F1 — Gravity (`wasm_main.cpp:1827`)

```diff
- float gravity = 25.0f; // tuned for Tribes feel
+ float gravity = 20.0f; // T1 SimMovement reference
```

### F2 — Ski persistence (Player struct + `wasm_main.cpp:1817`)

Add to Player struct:
```cpp
float airSkiTimer = 0;
```

Replace line 1817:
```cpp
if(keys[16]) {
    if(me.onGround) { me.skiing = true; me.airSkiTimer = 0.25f; }
    else if(me.airSkiTimer > 0) { me.skiing = true; me.airSkiTimer -= dt; }
    else me.skiing = false;
} else { me.skiing = false; me.airSkiTimer = 0; }
```

Initialize `airSkiTimer = 0` in `respawnPlayer()`.

### F3 — Air-control cap (`wasm_main.cpp:1855-1858`)

```cpp
} else {
    Vec3 md = moveDir.len()>0.01f ? moveDir.normalized() : Vec3{0,0,0};
    float curHoriz = sqrtf(me.vel.x*me.vel.x + me.vel.z*me.vel.z);
    if(curHoriz < ad.maxJetFwdVel) {
        float airAcc = ad.maxFwdSpeed * 0.5f * dt;
        me.vel.x += md.x * airAcc;
        me.vel.z += md.z * airAcc;
    }
}
```

### F4 — Jet split (`wasm_main.cpp:1882-1895`)

```cpp
if(moveDir.len()>0.01f && me.jumpContact>8) {
    Vec3 md = moveDir.normalized();
    float forwardDot = me.vel.x*md.x + me.vel.z*md.z;
    float forwardFrac = forwardDot / ad.maxJetFwdVel;
    if(forwardFrac < 0) forwardFrac = 0;
    if(forwardFrac > 1) forwardFrac = 1;
    float horizPct = forwardFrac;        // at top speed → all horizontal
    float vertPct  = 1.0f - forwardFrac; // at standstill → all vertical
    me.vel.x += md.x * horizPct * jetAcc;
    me.vel.z += md.z * horizPct * jetAcc;
    me.vel.y += vertPct * jetAcc;
} else {
    me.vel.y += jetAcc;
}
```

### F5 — Jump impulse at full magnitude (`wasm_main.cpp:1918-1928`)

```cpp
if(keys[32] && me.onGround && me.jumpContact < 8) {
    me.jumpContact = 8;
    Vec3 jn = getNorm(me.pos.x, me.pos.z);
    float dv = ad.jumpImpulse / ad.mass;
    me.vel.x += jn.x * dv;
    me.vel.y += jn.y * dv;
    me.vel.z += jn.z * dv;
    if(moveDir.len() > 0.01f) {
        Vec3 md = moveDir.normalized();
        float dot = md.x*jn.x + md.z*jn.z;
        if(dot > 0) {
            me.vel.x += md.x * dot * dv * 0.3f;
            me.vel.z += md.z * dot * dv * 0.3f;
        }
    }
}
```

### F6 — Per-weapon projectile inheritance

Add `float inheritScale;` to `WeaponData` struct (line ~244, after `float gravity`).

Update `weapons[]` table (line ~239) — append new column at end:

| Weapon | inheritScale |
|---|---|
| Blaster | 0.0 |
| Chaingun | 0.0 (hitscan anyway) |
| Disc | 0.5 |
| Grenade L. | 0.5 |
| Plasma | 0.3 |
| Mortar | 1.0 |
| Laser | 0.0 |
| ELF | 0.0 |
| Repair | 0.0 |

Replace `wasm_main.cpp:1018`:
```diff
- projs[i].vel=fwd*w.muzzleVel+p.vel*0.5f;
+ projs[i].vel=fwd*w.muzzleVel+p.vel*w.inheritScale;
```

### F7 — Armor-dependent energy regen

Add `float energyRegenMul;` to `ArmorData` struct (line ~219).

Update `armors[]` table:
- Light: `energyRegenMul = 1.0f`
- Medium: `energyRegenMul = 0.85f`
- Heavy: `energyRegenMul = 0.6f`

Replace `wasm_main.cpp:1903`:
```diff
- me.energy+=ENERGY_RECHARGE*dt;
+ me.energy+=ENERGY_RECHARGE*ad.energyRegenMul*dt;
```

Mirror in `client/constants.js:ARMORS[]` (add `energyRegenMul` field per row) so JS-side simulation/prediction matches.

---

## 3 · Diagnostics + Ski HUD

### D1 — Ski HUD (user-requested) ★

Three small additions, all CSS+HTML+JS in `index.html`. New container `#ski-hud` positioned bottom-center, ~80 px above HP bar.

**Element 1 — SKI badge.** A 60×24 px text box reading "SKI". Default state: dark gray `#222` background, text `#666`. Active state (when `getPlayerSkiing() == 1`): bright cyan `#00d8ff` background, black text, subtle pulse animation (CSS `@keyframes` 0.5 s scale 1.0 ↔ 1.05). Read: "the game heard your Shift key and skiing physics is active *right now*."

**Element 2 — Slope dial.** A 100×16 px horizontal bar to the right of SKI. Color and fill from `getPlayerSlopeDeg()` (signed: positive = uphill, negative = downhill, returned in degrees):

```js
const slope = getPlayerSlopeDeg();
let color, label;
if (slope <= -15)      { color = '#3cd66c'; label = 'STEEP DOWN'; }
else if (slope <= -5)  { color = '#88d6c0'; label = 'DOWN'; }
else if (slope <  5)   { color = '#888';    label = 'FLAT'; }
else if (slope < 15)   { color = '#d6a000'; label = 'UP'; }
else                   { color = '#d63030'; label = 'STEEP UP'; }
const fillPct = Math.min(100, Math.abs(slope) / 30 * 100);
```

Bar fills from center outward. Label text below in 10 px font.

**Element 3 — Speed readout.** Below the badge+dial, a number in monospace cyan: `42 m/s` (rounded). Updates every frame from `sqrt(vel.x² + vel.z²)`. Optional smaller "PEAK 58" tag to the right showing peak speed in last 5 s (track in JS, decay every 5 s).

**Required C++ exports** (add to the `extern "C"` block near `getHeightmapPtr()` ~line 1713):

```cpp
extern "C" {
    int   getPlayerSkiing()    { return players[localPlayer].skiing ? 1 : 0; }
    float getPlayerSpeed()     { Player&p=players[localPlayer]; return sqrtf(p.vel.x*p.vel.x + p.vel.z*p.vel.z); }
    float getPlayerSlopeDeg()  {
        Player&p=players[localPlayer];
        Vec3 n = getNorm(p.pos.x, p.pos.z);
        // n.y == cos(slope angle from horizontal); slope = acos(n.y)
        float angle = acosf(n.y) * 57.2957795f;
        // sign: positive when uphill in player's facing direction
        Vec3 fwd={sinf(p.yaw),0,-cosf(p.yaw)};
        float dirSign = (n.x*fwd.x + n.z*fwd.z) < 0 ? -1.0f : 1.0f;
        // wait — n points UP+slightly-uphill. If n's xz-projection points opposite to fwd, the slope rises ahead.
        // Let's go simpler: positive when "where the player is moving" goes uphill.
        Vec3 vh={p.vel.x,0,p.vel.z};
        if(vh.x*vh.x+vh.z*vh.z > 0.01f) {
            float vlen = sqrtf(vh.x*vh.x+vh.z*vh.z);
            float horizDot = (n.x*vh.x + n.z*vh.z) / vlen;
            // n.x,n.z point in the downslope direction (terrain falls that way). If player velocity has +ve dot
            // with n.xz, player is going downhill -> negative slope sign.
            dirSign = horizDot > 0 ? -1.0f : 1.0f;
        }
        return angle * dirSign;
    }
}
```

(The sign convention above gets tricky because terrain normals point up-and-toward-the-rising-side. If sign comes out backwards in playtest, just negate it — doesn't change the visual usefulness of the dial.)

### D2 — Hit confirmation

After every successful damage application that has `attackerTeam == localPlayer.team` and the damaged target is **not** the local player:

```cpp
if(/* attacker was localPlayer */) {
    EM_ASM({ if(window.onHitConfirm) window.onHitConfirm($0); }, dmg);
}
```

In `index.html`:
- Add a 24×24 px transparent div around the crosshair.
- `window.onHitConfirm = (dmg) => { showHitTick(); playSoundUI(7 /* or pick a free slot */); };`
- `showHitTick()` flashes a white `+` for 200 ms (CSS opacity 1 → 0 transition).

This applies to **both direct hits and splash damage** — any time the user's projectile causes damage to anything (player, bot), they see a tick.

### D3 — Per-frame perf log

In `mainLoop()` (or wherever the C++ top-level frame is driven), add:

```cpp
static int perfFrameCount = 0;
static double physicsAccum = 0;
double t0 = emscripten_get_now();
// ... existing physics ...
double t1 = emscripten_get_now();
physicsAccum += (t1 - t0);
perfFrameCount++;
if(perfFrameCount >= 60) {
    double avgPhysics = physicsAccum / 60.0;
    EM_ASM({
        const renderMs = (window.r3FrameTime || 0);
        console.log('[PERF] avg dt=' + (1000.0/$0).toFixed(1) + 'ms physics=' + $1.toFixed(2) + 'ms render=' + renderMs.toFixed(2) + 'ms');
    }, currentFps, avgPhysics);
    perfFrameCount = 0;
    physicsAccum = 0;
}
```

Renderer should expose `window.r3FrameTime` from its draw call. Cheap, gated, easy to disable.

### D4 — Pointer-lock resilience

In `index.html`, find the "CLICK TO RESUME" overlay handler. Verify that on click it calls `canvas.requestPointerLock()` (not just hides the overlay). If missing, add it. Also: when document loses pointer-lock, re-show the overlay (don't just freeze the player) so the user knows what happened.

---

## 4 · Out of scope for R31.3

- Visual / asset polish (sky, models, textures) — frozen per user mandate.
- Multiplayer / netcode (user is solo only).
- New weapons or armor balance changes (only F6/F7 wiring).
- DTS/glTF skeletal models (user is making models himself).
- Three.js perf optimization — D3 will diagnose the 3 fps spike; we'll act on it next round if needed.
- Ski "efficiency" indicator (compares actual vs theoretical-from-gravity speed) — deferred to R31.4 if user finds the basic ski HUD useful.

---

## 5 · Acceptance criteria (8/10 to pass)

1. **F0:** Skiing down a 30°+ slope no longer visibly clips through terrain. Camera stays continuously above ground every frame.
2. **F1+F5:** Jumps lift Light armor ~2.5 m vertically from rest (today's ~1.0 m).
3. **F2:** Skiing across a series of small bumps preserves momentum; player exits a rolling-terrain stretch at ≥ 80 % of entry speed.
4. **F3:** Air-spamming WASD does not accelerate the player past `maxJetFwdVel` (cap holds).
5. **F4:** With Light armor, holding W+Space on flat ground from rest reaches `maxJetFwdVel = 22 m/s` within ~1.5 s while staying close to the ground (does not fly straight up).
6. **F6:** Mortar fired while skiing forward at 30 m/s arcs visibly further than mortar fired stationary.
7. **F7:** Heavy armor energy refills 60 % as fast as Light (visibly slower).
8. **D1 (Ski HUD):** SKI badge lights up when Shift is held on slope; slope dial shows green on downslopes, red on uphills; speed readout updates every frame.
9. **D2:** Hitting a bot with a disc or chaingun produces a visible crosshair tick + UI hitmarker sound, **including splash hits**.
10. **D3:** Console shows `[PERF] avg dt=… physics=… render=…` lines roughly once per second during gameplay.

---

## 6 · Risk notes for Claude

- **F4 (jet split) is the highest-risk feel change.** If user reports it feels worse, fallback is to restore a 20 % vertical floor: `if(horizPct > 0.8f) horizPct = 0.8f; vertPct = 1 - horizPct;`. Ship F4 as written first.
- **F7 changes `ArmorData` struct size.** Grep for any JS-side `armors[]` mirror; if found, add `energyRegenMul` there too. WASM binary needs re-emit.
- **F6 changes `WeaponData` struct size.** Same caveat — re-emit WASM, sync `client/constants.js:WEAPONS[]` if it mirrors the struct.
- **F0 only fixes the LOCAL-PLAYER block (`wasm_main.cpp:1941`).** The bot/projectile clamp at `wasm_main.cpp:1359` already does `if(p.vel.y<0)p.vel.y=0` unconditionally — leave it alone, it's correct.
- **D1 slope sign** may come out reversed depending on getNorm's convention. Eyeball test: standing at top of a hill facing the descent should show GREEN/DOWN. If it shows red, negate `dirSign` once and ship.
- **`me.airSkiTimer`** must be initialized in `respawnPlayer()` (zero) so a respawning player doesn't inherit stale 0.25 s of air-ski.
- **Pre-push:** run `grep -nE "EM_ASM[^()]*\\\$1[6-9]"` on `wasm_main.cpp` (R13.1 emscripten 17-arg bug) — cheap belt-and-suspenders.

---

## 7 · Self-audit (please include in `claude_status.md`)

- Did F0–F7 all compile and emit without warnings?
- WASM binary re-emitted? `program/build/wasm_main.wasm` size delta vs prior should be small but non-zero.
- Did `airSkiTimer` get added to Player struct AND reset in `respawnPlayer()`?
- Did `inheritScale` and `energyRegenMul` get mirrored into `client/constants.js`?
- Did the `extern "C"` Ski HUD getters get added to the export list (in the `EXPORTED_FUNCTIONS` linker arg, NOT just declared `extern`)?
- Did the hit-confirm path fire on **both** direct and splash damage?
- Bump footer to `Version 0.4 / R31.3` after this round ships.

---

## 8 · Lineage

- R30.x → R31.2: visual track. Sky and weapon shipped acceptable.
- R31.3 (this round): mechanics + ski HUD + diagnostics.
- R31.4 candidates if R31.3 lands clean: ski efficiency indicator (deferred D1 stretch goal), bot AI improvements if D3 logs reveal issues, perf optimization based on D3 logs, pointer-lock UX hardening if D4 is insufficient.

Cron will trigger you in ~5 min. Focus on F0 first — it's the user's literal complaint. Then F4. The rest are quality-of-feel that compound.

— new-Manus
