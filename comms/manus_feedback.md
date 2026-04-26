# R31.6 Manus Brief — Damage Legibility + Audio Loops + Mortar Visibility

**Author:** new-Manus
**Date:** 2026-04-26
**Round type:** Feel + legibility (~60-90 min)
**Lineage:** R31.5 shipped 3P framing tune. User playtested in 1P, reports two distinct problems:

> *"I keep getting hit with what I presume is turret fire. I am not sure. Its not clear lol. Its hard to play."*

Plus video reference (https://www.youtube.com/watch?v=P_Thczu6UDA) confirms several feel gaps. New-Manus watched the video, cross-checked against repo state. Two of the three asks are pure **wiring** (data already exists in the snapshot, just isn't drawn).

## TL;DR

Three legibility fixes, in priority order:

1. **D1 — Directional damage indicator** (P0; this is the user-blocking issue). Red arc on screen edge pointing at the source of incoming damage. Data already in the wire as `lastDamageFromIdx`; just needs HUD render. Also auto-enable killfeed by default so the user sees what's killing them.
2. **D2 — Ski sound loop** (P1; biggest video-vs-ours feel gap). Buffer #11 is generated but no `startSki/stopSki` exists. Mirror the `startJet/stopJet` pattern. Volume scales with horizontal speed.
3. **D3 — Make turret threat visible** (P1; pairs with D1). Turrets currently render as static cubes that fire invisible(ish) plasma. Add (a) a slow red blink on alive turrets, (b) a brief muzzle flash particle when they fire, (c) audible plasma fire from turret position (positional 3D, already supported via `playSoundAt`).

Plus one optional: D4 — Faint targeting bracket on visible enemies in viewport (~30-50 px white square). Real Tribes had this; helps with the "I can't see what's shooting me" feeling.

---

## Why the user can't tell what's hitting them

Walking through `program/code/wasm_main.cpp` lines 1468-1508 (turret AI):

- 6 turrets per map (Raindance), 200 HP each, scan range 80 m, fire plasma every 1.5 s with LoS check.
- Turrets are **always-on** while their team's generator is alive (gen has 30 m enemy-proximity safe-regen, so they come back fast).
- Plasma projectile is small, low gravity (3), muzzleVel 55. At distance it's a tiny red dot.
- No turret muzzle flash. No turret-firing sound. No visual "I am being targeted" warning.
- Damage taken plays a generic `DAMAGE_TAKE` sound (#5) but NO directional cue.

Result: user sees HP go down, no idea why. Plays exactly like an invisible sniper, which is by far the worst feeling in any FPS.

## Why the ski sound matters

Video analysis (P_Thczu6UDA, full notes saved to `tribes_evidence/video_analysis_P_Thczu6UDA.md`):

> *"The jetpack emits a continuous, prominent 'hiss' or 'whoosh' while active."*

Same applies to skiing in T1/T:V — there's a constant whoosh while sliding. Our `client/audio.js` already declares `SOUND.SKI_LOOP=11`, the buffer is generated in `shell.html:2841` (pink noise low-pass with rising envelope), but the `AE` engine has `startJet/stopJet/jetNode/jetGain` and **no equivalent for ski**. AE.update() at line 2942 receives `(jetting, onGround, speed, health)` — already has `speed` available, so volume modulation is trivial.

A skiing player without sound feel is like Mario without the "doot doot doot" — you don't know you're moving. Adding ski hiss is probably the single biggest "feel" upgrade per line of code in the entire project.

## Code changes

### D1 · Directional damage indicator + killfeed default-on

**File: `index.html` / `shell.html` (CSS)**

Add to the existing `<style>` block (near the `#killfeed` rule around line 268):

```css
#dmg-arc {
    position: absolute;
    top: 50%; left: 50%;
    width: 360px; height: 360px;
    margin: -180px 0 0 -180px;
    pointer-events: none;
    z-index: 11;
    transform-origin: center center;
    opacity: 0;
    transition: opacity 0.4s ease-out;
}
#dmg-arc.active { opacity: 1; }
#dmg-arc svg { width: 100%; height: 100%; }
#dmg-arc path {
    fill: rgba(255, 50, 30, 0.55);
    stroke: rgba(255, 100, 60, 0.9);
    stroke-width: 2;
}
```

Add to the body (next to `#killfeed`):

```html
<div id="dmg-arc"><svg viewBox="-50 -50 100 100"><path d="M -25 -45 A 50 50 0 0 1 25 -45 L 18 -32 A 35 35 0 0 0 -18 -32 Z"/></svg></div>
```

The arc points "up" (toward 12 o'clock); we'll rotate the whole div based on the angle to the attacker.

**File: `index.html` (JS), in the per-frame HUD update where `lastDamageFromIdx` is processed**

Find where snapshot data flows to HUD (search for `lastDamageFromIdx` or the snapshot apply loop). Add:

```js
// R31.6 D1: directional damage indicator
let _lastDmgArcShownAt = 0;
function showDamageArc(srcWorldX, srcWorldZ, myYaw, myX, myZ) {
    const dx = srcWorldX - myX, dz = srcWorldZ - myZ;
    if (dx*dx + dz*dz < 0.01) return;          // self-damage; skip
    const angleToSrc = Math.atan2(dx, -dz);    // world-space angle (Tribes Y-up convention)
    const relAngle = angleToSrc - myYaw;       // relative to facing
    const deg = relAngle * 180 / Math.PI;
    const arc = document.getElementById('dmg-arc');
    if (!arc) return;
    arc.style.transform = `rotate(${deg}deg)`;
    arc.classList.add('active');
    _lastDmgArcShownAt = performance.now();
    setTimeout(() => {
        if (performance.now() - _lastDmgArcShownAt >= 750)
            arc.classList.remove('active');
    }, 800);
}

// In the main snapshot-apply loop, on player[localIdx]:
if (lp.lastDamageFromIdx !== undefined && lp.lastDamageFromIdx !== -1
    && lp.lastDamageFromIdx !== _prevLastDmgFrom) {
    const src = (lp.lastDamageFromIdx >= 200)
        ? turrets[lp.lastDamageFromIdx - 200]   // turret damage encoded as 200+turretIdx
        : players[lp.lastDamageFromIdx];
    if (src) showDamageArc(src.pos.x, src.pos.z, lp.yaw, lp.pos.x, lp.pos.z);
    _prevLastDmgFrom = lp.lastDamageFromIdx;
}
```

**File: `program/code/wasm_main.cpp`** — extend `lastDamageFromIdx` to include turrets

Currently the field is set when player damage comes from another player. Extend: when turret plasma hits the local player, set `players[localPlayer].lastDamageFromIdx = 200 + turretIndex` (200 chosen to not collide with player ids 0-7). In the wire layer, signed int8 covers -128..127; we have 200+ to send, so change byte 24 to **uint8** (it's already declared as Int8 in `client/wire.js:94`; just switch to `setUint8`/`getUint8`). The semantic becomes: 0xFF = none, 0-7 = player, 200-205 = turret. Update both `wire.js` write and read sides.

**File: `index.html` defaults**

Find the `ST.showKillFeed` default and flip from `false` (or whatever it is) to `true`. Search:
```js
ST.showKillFeed
```
Make sure first-run default is enabled.

### D2 · Ski sound loop

**File: `index.html` / `shell.html`** in the `AE` object (near line 2885 `startJet`)

Add right after `stopJet`:

```js
startSki: function() {
    if (!this.ctx || this.muted || this.skiNode || !this.bufs[11]) return;
    var g = this.ctx.createGain();
    g.gain.setValueAtTime(0, this.ctx.currentTime);
    g.gain.linearRampToValueAtTime(0.4, this.ctx.currentTime + 0.05);
    g.connect(this.uiBus);
    var src = this.ctx.createBufferSource();
    src.buffer = this.bufs[11]; src.loop = true;
    src.connect(g); src.start();
    this.skiNode = src; this.skiGain = g;
},
stopSki: function() {
    if (!this.skiNode) return;
    var g = this.skiGain, n = this.skiNode;
    g.gain.setValueAtTime(g.gain.value, this.ctx.currentTime);
    g.gain.linearRampToValueAtTime(0, this.ctx.currentTime + 0.08);
    setTimeout(function() { try { n.stop(); } catch (e) {} }, 150);
    this.skiNode = null; this.skiGain = null;
},
```

In `AE.update()` (around line 2900), extend the signature to receive `skiing` and add the ski-state edge detection:

```js
update: function(jetting, onGround, speed, health, skiing) {     // R31.6: + skiing
    if (jetting && !this.prevJetting) this.startJet();
    else if (!jetting && this.prevJetting) this.stopJet();
    this.prevJetting = jetting;

    // R31.6: ski loop with speed-modulated volume
    var skiActive = skiing && onGround && speed > 2;
    if (skiActive && !this.prevSkiing) this.startSki();
    else if (!skiActive && this.prevSkiing) this.stopSki();
    if (this.skiGain) {
        // Volume ramps from 0.15 (slow) to 0.55 (fast) over 0..40 m/s
        var vol = 0.15 + Math.min(speed / 40, 1.0) * 0.40;
        this.skiGain.gain.setTargetAtTime(vol, this.ctx.currentTime, 0.08);
    }
    this.prevSkiing = skiActive;

    // ... existing footstep/damage/listener code unchanged ...
},
```

Update the C++ → JS bridge `window.updateAudio` to pass `skiing`:

```js
window.updateAudio = function(jetting, onGround, speed10, health1000, skiing) {
    if (!AE.ctx) return;
    AE.update(jetting === 1, onGround === 1, speed10/10, health1000/1000, skiing === 1);
};
```

And the C++ `EM_ASM` call that invokes it (search wasm_main.cpp for `updateAudio`) needs to pass `me.skiing ? 1 : 0` as the 5th arg.

### D3 · Turret threat visibility

**File: `program/code/wasm_main.cpp`** in `updateTurrets()` — when the turret fires (line ~1499, just after `projs[k]={...}`):

```cpp
// R31.6: muzzle flash + audible fire (positional)
spawnBurst(firePos, 6, 0.4f, 8, 1.0f, 0.3f, 0.1f, 0.25f);
EM_ASM({ if(window.playSoundAt) window.playSoundAt(2, $0, $1, $2); },
    firePos.x, firePos.y, firePos.z);  // sound id 2 = PLASMA_FIRE
```

In the turret render block (around line 2293), replace the static color with a slow blink (1.2 sec period, 80% min brightness) when alive, so users can see "this is a live threat":

```cpp
// R31.6: slow red pulse on alive turrets so user sees the threat
float pulse = t.alive ? (0.85f + 0.15f * sinf(gameTime * 5.2f)) : 0.5f;
float r = (t.team==0 ? 0.95f : 0.2f) * pulse;
float g = 0.15f * pulse;
float b = (t.team==0 ? 0.15f : 0.85f) * pulse;
// pass r,g,b into existing renderCube/whatever call
```

(Keep destroyed turrets dim grey as currently.)

### D4 (optional, defer if running long) · Targeting brackets on visible enemies

For each player in `syncPlayers()` who is alive, on opposite team, within camera frustum, project their world position to NDC, draw a small white square (CSS overlay or canvas2d). Real Tribes had this. ~25 lines of JS in `renderer.js`.

---

## Acceptance (5 criteria; need 4/5)

1. Turret fires → I hear a positional plasma "pew" from the turret's location, see a red muzzle flash, and a red arc appears on the side of my screen pointing at the turret. (D1+D3)
2. While skiing, I hear a continuous whoosh that gets louder as I gain speed; sound stops within 0.15s of releasing Shift. (D2)
3. Killfeed is on by default; I can see "Turret-1 → me [plasma]" or "Bot3 → me [disc]" entries top-right. (D1)
4. Damage from in front, behind, side — arc rotates correctly to point at source. (D1)
5. Live turrets visibly pulse so I know which ones are active threats. (D3)

## Out of scope (R31.7+)

- Killcam (5-second replay from killer's POV)
- Mortar arc preview (faint dotted line showing trajectory)
- Voice quick-chat (VGS — "Shazbot!", "On my way!"). Big effort, deferred.
- Minimap/radar (we have killfeed and now damage arc; minimap is a separate round)
- Hit-marker "tink" sound for OUR shots landing (we have damage_give #13 but not hooked)
- Smooth 1P↔3P camera lerp

## Notes for Claude

- `lastDamageFromIdx` already exists in wire — please reuse, don't add a parallel field.
- Don't break existing kill-feed format (`killer~weapon~victim`).
- 200+turretIdx encoding is one option; another is a separate `lastDamageType` byte. Use whichever is cleaner for your wire-version migration; just keep wire backward-compatible if other callers exist.
- Test that ski sound doesn't play during warmup or when local player is dead — gate on `me.alive && matchState===1`.
- Sound volumes intentionally below 0.55 master — don't blow out user's ears.

— new-Manus
