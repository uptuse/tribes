/**
 * Gamepad support — standard browser Gamepad API mapped to Firewolf controls.
 *
 * Layout (Xbox / standard mapping):
 *   Left stick      → move (forward/back/strafe)
 *   Right stick     → look (yaw/pitch)
 *   Right trigger   → fire  (RT / axis 5 or button 7)
 *   A button (0)    → jet / jump
 *   B button (1)    → ski (hold)
 *   X button (2)    → next weapon
 *   Y button (3)    → previous weapon
 *   Left bumper (4) → toggle 3rd person
 *   Start (9)       → pause / escmenu
 *
 * Dead zone: 0.15 on all axes.
 * Look sensitivity: configurable via LOOK_SENS (default 120 °/s at full deflection).
 */

const DEAD   = 0.15;
const LOOK_SENS = 120; // degrees per second at full stick, then converted to delta each frame

let _padIdx = -1;
let _prevBtns = new Array(32).fill(false);
let _lastFrame = 0;

export function initGamepad() {
  window.addEventListener('gamepadconnected', e => {
    _padIdx = e.gamepad.index;
    console.log(`[Gamepad] Connected: ${e.gamepad.id} (index ${_padIdx})`);
    showToast?.(`🎮 Controller connected — ${e.gamepad.id.slice(0, 32)}`, 2500);
  });
  window.addEventListener('gamepaddisconnected', e => {
    if (e.gamepad.index === _padIdx) { _padIdx = -1; console.log('[Gamepad] Disconnected'); }
  });
}

// Called every frame from the render loop
export function tickGamepad(dt) {
  if (_padIdx < 0) return;
  const pads = navigator.getGamepads();
  const pad  = pads[_padIdx];
  if (!pad || !pad.connected) return;

  const ax = pad.axes;
  const bt = pad.buttons;

  // ── Movement (left stick) ─────────────────────────────────
  const fwd  = -deadzone(ax[1]);   // -Y = forward
  const side =  deadzone(ax[0]);   // +X = right

  // ── Look (right stick) ────────────────────────────────────
  const lx = deadzone(ax[2]);
  const ly = deadzone(ax[3]);
  // Convert to pixel-equivalent delta (same units as mouse movementX/Y)
  const lookDX =  lx * LOOK_SENS * dt * (1000 / 3); // roughly: sens*dt*333 ≈ pixels
  const lookDY =  ly * LOOK_SENS * dt * (1000 / 3);

  // ── Buttons ───────────────────────────────────────────────
  const firePressed = pressed(bt[7]) || pressed(bt[5]);  // RT or RB
  const jetPressed  = pressed(bt[0]);   // A
  const skiHeld     = held(bt[1]);      // B hold
  let btns = 0;
  if (firePressed) btns |= 1;
  if (jetPressed)  btns |= 2;
  if (skiHeld)     btns |= 4;

  // ── Send to C++ ───────────────────────────────────────────
  if (window.Module?._setGamepadInput) {
    Module._setGamepadInput(fwd, side, lookDX, lookDY, btns);
  }

  // ── Rising-edge actions (weapon switch, menu) ──────────────
  if (rising(bt[2], 2)) _nextWeapon(1);   // X = next
  if (rising(bt[3], 3)) _nextWeapon(-1);  // Y = prev
  if (rising(bt[4], 4)) _toggle3P();      // LB = 3rd person
  if (rising(bt[9], 9)) _pause();         // Start = menu

  // ── Update prev state ────────────────────────────────────
  bt.forEach((b, i) => { _prevBtns[i] = b.pressed; });
}

// ── Helpers ───────────────────────────────────────────────────
function deadzone(v) { return Math.abs(v) < DEAD ? 0 : (v - Math.sign(v) * DEAD) / (1 - DEAD); }
function pressed(b)  { return b?.pressed ?? false; }
function held(b)     { return b?.pressed ?? false; }
function rising(b, i){ return (b?.pressed) && !_prevBtns[i]; }

let _wpnIdx = 2; // start on disc
function _nextWeapon(dir) {
  _wpnIdx = ((_wpnIdx + dir + 9) % 9);
  // Simulate number key press via the key event system
  const keyMap = [49,50,51,52,53,54,55,56,57]; // 1-9
  document.dispatchEvent(new KeyboardEvent('keydown', { keyCode: keyMap[_wpnIdx], bubbles: true }));
  setTimeout(() => document.dispatchEvent(new KeyboardEvent('keyup', { keyCode: keyMap[_wpnIdx], bubbles: true })), 80);
}

function _toggle3P() {
  document.dispatchEvent(new KeyboardEvent('keydown', { keyCode: 86, bubbles: true })); // V
  setTimeout(() => document.dispatchEvent(new KeyboardEvent('keyup',   { keyCode: 86, bubbles: true })), 80);
}

function _pause() {
  const esc = document.getElementById('escmenu');
  if (esc?.classList.contains('active')) {
    window.resumeGame?.();
  } else {
    document.exitPointerLock?.();
    esc?.classList.add('active');
  }
}

function showToast(msg, ms) { window.showToast?.(msg, ms); }
