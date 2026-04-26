// ============================================================
// Server-side anti-cheat baseline (R19).
// Cheap O(1) checks per input. Logs with [CHEAT] prefix; serious
// violations return a kick reason.
// ============================================================

import {
    AC_MAX_SPEED_M_PER_S,
    AC_MAX_AIM_RATE_DEG_PER_S,
    AC_MAX_INPUT_RATE_HZ,
    WEAPONS,
} from './constants.js';
import type { SimPlayer, PlayerInput } from './sim.js';

export type ViolationCode =
    | 'speed'
    | 'aimRate'
    | 'cooldown'
    | 'inputRate';

export interface AntiCheatLog {
    playerId: number;
    code: ViolationCode;
    detail: string;
    tick: number;
    wallTime: number;
}

export class AntiCheat {
    log: AntiCheatLog[] = [];
    playerLastFireTime = new Map<number, number[]>(); // playerId → [perWeaponLastFireMs]

    /** Returns null if input is OK; otherwise a violation code. */
    checkInput(player: SimPlayer, input: PlayerInput, prevPos: [number, number, number], dt: number, tick: number): ViolationCode | null {
        // 1. Speed check — implicit position change vs allowed
        const dx = player.pos[0] - prevPos[0];
        const dy = player.pos[1] - prevPos[1];
        const dz = player.pos[2] - prevPos[2];
        const dist = Math.hypot(dx, dy, dz);
        if (dt > 0 && (dist / dt) > AC_MAX_SPEED_M_PER_S) {
            this.recordViolation(player.id, 'speed', `dist=${dist.toFixed(2)} dt=${dt.toFixed(3)}`, tick);
            return 'speed';
        }
        // 2. Aim rate (rad/sec → deg/sec)
        const rotMag = Math.hypot(input.mouseDX || 0, input.mouseDY || 0);
        const degPerSec = (rotMag / dt) * (180 / Math.PI);
        if (degPerSec > AC_MAX_AIM_RATE_DEG_PER_S) {
            this.recordViolation(player.id, 'aimRate', `${degPerSec.toFixed(0)}°/s`, tick);
            return 'aimRate';
        }
        // 3. Input rate sanity (sustained > AC_MAX_INPUT_RATE_HZ for 1s = kick)
        if (player.inputRateWindow.length > AC_MAX_INPUT_RATE_HZ) {
            this.recordViolation(player.id, 'inputRate', `${player.inputRateWindow.length}/s`, tick);
            return 'inputRate';
        }
        return null;
    }

    /** Returns true if the player is allowed to fire now (not within cooldown). */
    checkCooldown(player: SimPlayer, weaponIdx: number, tick: number): boolean {
        const w = WEAPONS[weaponIdx];
        if (!w) return false;
        const cooldownMs = (w.fireTime + (w.reloadTime || 0)) * 1000 * 0.95; // 5% slack for clock skew
        const now = Date.now();
        let lastFires = this.playerLastFireTime.get(player.id);
        if (!lastFires) { lastFires = new Array(WEAPONS.length).fill(0); this.playerLastFireTime.set(player.id, lastFires); }
        if (now - lastFires[weaponIdx] < cooldownMs) {
            this.recordViolation(player.id, 'cooldown', `wpn=${w.name}`, tick);
            return false;
        }
        lastFires[weaponIdx] = now;
        return true;
    }

    private recordViolation(playerId: number, code: ViolationCode, detail: string, tick: number) {
        const entry = { playerId, code, detail, tick, wallTime: Date.now() };
        this.log.push(entry);
        if (this.log.length > 200) this.log.shift();
        console.log(`[CHEAT] player=${playerId} code=${code} detail=${detail} tick=${tick}`);
    }
}
