# The Rabbit Technique

A pattern for live in-game fine-tuning of any numeric parameter (transforms, colours, physics values, etc.) without reloading or editing files.

Named by the project owner, 2026-05-02.

---

## Problem it solves

Any time you need to dial in a value that can only be judged visually — a 3D model's position/rotation/scale, a particle size, a camera offset, a colour — the edit-reload-look cycle is slow and disorienting. The rabbit technique collapses that loop to a single keypress.

## Core pattern

1. **Expose the target values** as a small object or set of module-level variables so they can be mutated at runtime.
2. **Register a `keydown` listener** that nudges the values by a small step per press. Use keys that are provably unbound in the game (check the C++ `keys[]` array and the JS input handlers before choosing).
3. **Apply the change immediately** — update the live Three.js / WASM object in the same handler, no frame delay.
4. **Show the current values on-screen** in a fixed overlay `<div>`, not in the console. The console is invisible during gameplay and unreliable in Safari.
5. **When satisfied, hardcode** the values from the overlay and delete (or disable) the tuner.

## What to avoid

| Avoid | Why |
|---|---|
| Modifier keys (Shift, Ctrl, Alt) | Often bound to game actions; Safari may suppress `e.code` under modifiers |
| Numpad 1 / 3 / 5 | Safari on Mac maps these to the same keyCode as top-row 1/3/5 (weapon switches) |
| NumpadEnter | Shares keyCode 13 with regular Enter; browser intercepts it |
| `console.log` as the only readout | Not visible during gameplay; broken in Safari without DevTools open |
| `window.myFn = ...` at ES-module top level | Safari DevTools console can't resolve module-scope globals as bare names; put the assignment inside a function that runs during init |

## Reference implementation — Spinfusor GLB transform tuner

Location: `renderer.js`, inside `initWeaponViewmodel()`, labelled `R32.278`.

```
* (NumpadMultiply)  — toggle POS / ROT mode
8 / 2               — z forward / back    (POS)  or  rotX  (ROT)
4 / 6               — x left / right      (POS)  or  rotY  (ROT)
7 / 9               — y up / down         (POS)  or  rotZ  (ROT)
+ / -               — scale up / down
```

Overlay appears bottom-right when the Spinfusor is equipped in first-person. Values update live on every keypress. Hardcode from overlay → remove tuner.

## Template

```js
// Inside an init function (NOT at module top level):
const _MY_PARAMS = { x: 0, y: 0, scale: 1 };
const _overlay = document.createElement('div');
_overlay.style.cssText = `position:fixed;bottom:110px;right:16px;z-index:20000;
    font-family:monospace;font-size:11px;background:rgba(0,0,0,0.7);
    color:#ffe066;padding:8px 12px;border-radius:4px;pointer-events:none;
    display:none;white-space:pre;`;
document.body.appendChild(_overlay);

const _applyParams = () => { /* push _MY_PARAMS into live object */ };
const _showOverlay = () => {
    _overlay.style.display = 'block';
    _overlay.textContent = `x:${_MY_PARAMS.x.toFixed(3)}  y:${_MY_PARAMS.y.toFixed(3)}  scale:${_MY_PARAMS.scale.toFixed(3)}`;
};

document.addEventListener('keydown', (e) => {
    if (!_tunerActive) return; // guard: only active when relevant
    let hit = true;
    switch (e.code) {
        case 'Numpad8': _MY_PARAMS.y += 0.005; break;
        case 'Numpad2': _MY_PARAMS.y -= 0.005; break;
        case 'Numpad4': _MY_PARAMS.x -= 0.005; break;
        case 'Numpad6': _MY_PARAMS.x += 0.005; break;
        case 'NumpadAdd':      _MY_PARAMS.scale += 0.01; break;
        case 'NumpadSubtract': _MY_PARAMS.scale -= 0.01; break;
        default: hit = false;
    }
    if (hit) { _applyParams(); _showOverlay(); }
});
```

## Step sizes

| Parameter | Good starting step |
|---|---|
| World position (meters) | 0.005 |
| Rotation | 3° (0.0524 rad) |
| Scale | 0.005 |
| Colour channel (0–1) | 0.02 |
| Physics force | 5–10% of current value |

## Safe numpad keys (confirmed working in Safari on Mac + this game)

`Numpad2`, `Numpad4`, `Numpad6`, `Numpad7`, `Numpad8`, `Numpad9`, `NumpadAdd`, `NumpadSubtract`, `NumpadMultiply`, `NumpadDivide`

## Meshy export axis convention

Meshy AI exports GLB with a non-standard forward axis. In Three.js, viewmodels expect the barrel to point along **-Z** in `weaponHand` local space. Meshy models do not — `rotY = 180°` produces a horizontal gun, not a correctly-aimed one. The working rotation for this project's Meshy exports ends up around **249°Y** to compensate. Expect the same offset for any future Meshy model and tune from there rather than from 180°.

## Muzzle origin for projectiles (not just FX)

The muzzle anchor position (tuned in MUZ mode) serves two purposes:
1. **CombatFX** — flash and tracer line start point (JS only, `window._weaponMuzzleAnchor`)
2. **Projectile spawn** — the world position is fed to C++ each frame via `Module._setLocalMuzzleOrigin()` so the actual physics projectile also spawns from the gun barrel, not from player-centre+fwd*2

Both must be wired to get the full effect. The C++ side consumes the override once per shot and resets it.
