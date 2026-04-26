// ============================================================
// Server-side bot AI — TS port of the R14 C++ A* implementation
// (program/code/wasm_main.cpp, see initNavGrid + astarPath + updateBot).
//
// Roles:
//   OFFENSE  — push enemy flag, return to home if carrying
//   DEFENSE  — orbit home flag, intercept enemy carrier
//   MIDFIELD — hunt opponents in midmap
//
// Per-tick (30Hz): goal evaluation → A* path → synthetic Input
//   - WASD bits set to face waypoint
//   - mouseDX/Y to rotate yaw toward target
//   - Skiing on downhill grade > 5°
//   - Jetting on uphill grade > 3° AND energy > 30
//   - Firing if LOS within 80m AND aim-angle < 8°
//   - Stuck-detection: 1m in 2s → repath
// ============================================================

import {
    BTN_FORWARD, BTN_BACK, BTN_LEFT, BTN_RIGHT, BTN_JUMP, BTN_SKI, BTN_FIRE,
    WORLD_HALF, INPUT_HZ,
} from './constants.js';
import type { Match, SimPlayer, PlayerInput } from './sim.ts';

const NAV_SIZE = 64;
const NAV_CELL = (WORLD_HALF * 2) / NAV_SIZE;   // 32m per cell on 2048m map

// Server uses a flat-ground simulation (heightmap is C++/client side).
// We represent the nav grid as fully walkable for now — bots path on flat
// terrain, which matches the server sim's flat-ground approximation.
// When R23+ moves heightmap server-side, this gets richer.
const navGrid: boolean[][] = (() => {
    const g: boolean[][] = [];
    for (let i = 0; i < NAV_SIZE; i++) {
        g[i] = [];
        for (let j = 0; j < NAV_SIZE; j++) g[i][j] = true;
    }
    return g;
})();

function worldToNav(wx: number, wz: number): [number, number] {
    const ni = Math.max(0, Math.min(NAV_SIZE - 1, Math.floor(wx / NAV_CELL + NAV_SIZE / 2)));
    const nj = Math.max(0, Math.min(NAV_SIZE - 1, Math.floor(wz / NAV_CELL + NAV_SIZE / 2)));
    return [ni, nj];
}
function navToWorld(ni: number, nj: number): [number, number, number] {
    return [(ni - NAV_SIZE / 2) * NAV_CELL + NAV_CELL / 2, 1.5, (nj - NAV_SIZE / 2) * NAV_CELL + NAV_CELL / 2];
}

interface NavNode { idx: number; f: number; }

function astarPath(sx: number, sz: number, ex: number, ez: number): [number, number, number][] {
    const [si, sj] = worldToNav(sx, sz);
    const [ei, ej] = worldToNav(ex, ez);
    if (si === ei && sj === ej) return [];

    const gCost: number[][] = [];
    const closed: boolean[][] = [];
    const parent: number[] = new Array(NAV_SIZE * NAV_SIZE).fill(-1);
    for (let i = 0; i < NAV_SIZE; i++) {
        gCost[i] = [];
        closed[i] = [];
        for (let j = 0; j < NAV_SIZE; j++) { gCost[i][j] = Infinity; closed[i][j] = false; }
    }

    // Min-heap-ish: just sort each iteration since grid is small (4096 cells).
    // For R22 this is cheap enough; R23 can switch to a real binary heap.
    const open: NavNode[] = [];
    const startIdx = si * NAV_SIZE + sj;
    const endIdx = ei * NAV_SIZE + ej;
    gCost[si][sj] = 0;
    open.push({ idx: startIdx, f: Math.abs(si - ei) + Math.abs(sj - ej) });

    const DX = [0, 0, 1, -1, 1, 1, -1, -1];
    const DZ = [1, -1, 0, 0, 1, -1, 1, -1];
    const DC = [10, 10, 10, 10, 14, 14, 14, 14];

    let iters = 0;
    while (open.length > 0 && iters < 2000) {
        iters++;
        // Pop min-f
        open.sort((a, b) => a.f - b.f);
        const cur = open.shift()!;
        const ci = (cur.idx / NAV_SIZE) | 0;
        const cj = cur.idx % NAV_SIZE;
        if (closed[ci][cj]) continue;
        closed[ci][cj] = true;

        if (cur.idx === endIdx) {
            const path: [number, number, number][] = [];
            let idx = endIdx;
            while (idx !== -1 && idx !== startIdx) {
                const ni = (idx / NAV_SIZE) | 0;
                const nj = idx % NAV_SIZE;
                path.push(navToWorld(ni, nj));
                idx = parent[idx];
            }
            path.reverse();
            return path;
        }

        for (let d = 0; d < 8; d++) {
            const ni = ci + DX[d], nj = cj + DZ[d];
            if (ni < 0 || ni >= NAV_SIZE || nj < 0 || nj >= NAV_SIZE) continue;
            if (!navGrid[ni][nj] || closed[ni][nj]) continue;
            const nidx = ni * NAV_SIZE + nj;
            const ng = gCost[ci][cj] + DC[d];
            if (ng < gCost[ni][nj]) {
                gCost[ni][nj] = ng;
                parent[nidx] = cur.idx;
                open.push({ idx: nidx, f: ng + (Math.abs(ni - ei) + Math.abs(nj - ej)) * 10 });
            }
        }
    }
    return [];
}

// ============================================================
// BotAI — one instance per server-side bot
// ============================================================
export type BotRole = 'offense' | 'defense' | 'midfield';

export interface BotState {
    botPlayerId: number;
    role: BotRole;
    path: [number, number, number][];
    pathIdx: number;
    pathRecomputeAt: number;       // wallTime ms; recompute when due
    lastPosCheck: { pos: [number, number, number]; wallTime: number };
    target: [number, number, number] | null;
}

export class BotAI {
    private states = new Map<number, BotState>();
    private ROLES_BY_INDEX: BotRole[] = ['offense', 'offense', 'defense', 'midfield'];

    addBot(botPlayerId: number, teamSize: number) {
        const role = this.ROLES_BY_INDEX[this.states.size % this.ROLES_BY_INDEX.length] || 'offense';
        this.states.set(botPlayerId, {
            botPlayerId, role,
            path: [], pathIdx: 0,
            pathRecomputeAt: 0,
            lastPosCheck: { pos: [0, 0, 0], wallTime: 0 },
            target: null,
        });
    }

    removeBot(botPlayerId: number) {
        this.states.delete(botPlayerId);
    }

    /**
     * Compute the next synthetic input for this bot. Called once per server
     * tick. Returns null if bot doesn't exist or is dead.
     */
    computeInput(bot: SimPlayer, match: Match, tick: number): PlayerInput | null {
        if (!bot.alive) return null;
        let state = this.states.get(bot.id);
        if (!state) {
            this.addBot(bot.id, match.players.size);
            state = this.states.get(bot.id)!;
        }

        const now = Date.now();

        // -------- Goal evaluation (per-bot role) --------
        const enemyTeam = bot.team === 0 ? 1 : 0;
        const homeFlag = match.flags[bot.team];
        const enemyFlag = match.flags[enemyTeam];
        let goalPos: [number, number, number] = bot.pos;

        if (bot.carryingFlag >= 0) {
            // Always run home if carrying
            goalPos = homeFlag.homePos as [number, number, number];
        } else if (state.role === 'offense') {
            goalPos = enemyFlag.pos as [number, number, number];
        } else if (state.role === 'defense') {
            // Orbit home flag at ~25m
            const carrier = enemyFlag.carrierIdx >= 0 ? match.players.get(enemyFlag.carrierIdx) : null;
            if (carrier && carrier.alive) {
                goalPos = carrier.pos;
            } else {
                const orbit = (tick / 30) % (Math.PI * 2);
                goalPos = [
                    homeFlag.homePos[0] + Math.cos(orbit) * 25,
                    homeFlag.homePos[1],
                    homeFlag.homePos[2] + Math.sin(orbit) * 25,
                ];
            }
        } else {
            // Midfield — hunt nearest opponent in midmap
            const midX = (homeFlag.homePos[0] + enemyFlag.homePos[0]) / 2;
            const midZ = (homeFlag.homePos[2] + enemyFlag.homePos[2]) / 2;
            let closestEnemy: SimPlayer | null = null;
            let closestDist = Infinity;
            for (const p of match.players.values()) {
                if (p.team === bot.team || !p.alive) continue;
                const d = Math.hypot(p.pos[0] - midX, p.pos[2] - midZ);
                if (d < closestDist) { closestDist = d; closestEnemy = p; }
            }
            goalPos = closestEnemy ? closestEnemy.pos : [midX, homeFlag.homePos[1], midZ];
        }

        state.target = goalPos;

        // -------- Stuck detection --------
        if (now - state.lastPosCheck.wallTime > 2000) {
            const moved = Math.hypot(
                bot.pos[0] - state.lastPosCheck.pos[0],
                bot.pos[2] - state.lastPosCheck.pos[2]
            );
            if (moved < 1.0 && state.path.length > 0) {
                // Stuck — clear path to force repath
                state.path = [];
                state.pathRecomputeAt = 0;
            }
            state.lastPosCheck = { pos: [...bot.pos], wallTime: now };
        }

        // -------- Path recompute --------
        if (now >= state.pathRecomputeAt || state.path.length === 0 || state.pathIdx >= state.path.length) {
            state.path = astarPath(bot.pos[0], bot.pos[2], goalPos[0], goalPos[2]);
            state.pathIdx = 0;
            state.pathRecomputeAt = now + 1000; // recompute every 1s normally, sooner if stuck
        }

        // Current waypoint (or fallback to goalPos directly)
        let wp: [number, number, number] = state.path[state.pathIdx] ?? goalPos;
        // Advance to next if we're close
        const dxToWp = wp[0] - bot.pos[0];
        const dzToWp = wp[2] - bot.pos[2];
        const distToWp = Math.hypot(dxToWp, dzToWp);
        if (distToWp < NAV_CELL * 0.6 && state.pathIdx + 1 < state.path.length) {
            state.pathIdx++;
            wp = state.path[state.pathIdx];
        }

        // -------- Synthetic input --------
        // Aim: rotate yaw toward waypoint
        const targetYaw = Math.atan2(dxToWp, -dzToWp);
        let dyaw = targetYaw - bot.rot[1];
        // Wrap to [-π, π]
        while (dyaw > Math.PI) dyaw -= Math.PI * 2;
        while (dyaw < -Math.PI) dyaw += Math.PI * 2;
        // Aim turn rate: 5 rad/s = 286°/s (well under anti-cheat 1080°/s cap)
        const maxTurn = 5 / INPUT_HZ;
        const mouseDX = Math.max(-maxTurn, Math.min(maxTurn, dyaw));

        // Pitch: slight downward look (to see ground+enemies)
        const mouseDY = (-0.1 - bot.rot[0]) * 0.05;

        let buttons = 0;
        // Always forward (running toward waypoint)
        buttons |= BTN_FORWARD;

        // Skiing: very flat ground in server sim → set ski when moving fast
        // (placeholder for real downhill grade detection when heightmap is server-side)
        const speed = Math.hypot(bot.vel[0], bot.vel[2]);
        if (speed > 8) buttons |= BTN_SKI;

        // Jetting: when waypoint is far away or we're stuck on a height bump,
        // press jump (server treats jump as both jump-from-ground + jet-in-air)
        if (bot.energy > 0.3 && (Math.random() < 0.05 || distToWp > 30)) {
            buttons |= BTN_JUMP;
        }

        // Firing: if there's an enemy in LOS within 80m AND aim is good
        let fireTarget: SimPlayer | null = null;
        let bestEnemyDist = Infinity;
        for (const p of match.players.values()) {
            if (p.team === bot.team || !p.alive) continue;
            if (Date.now() < p.spawnProtectUntil) continue;
            const dx = p.pos[0] - bot.pos[0];
            const dz = p.pos[2] - bot.pos[2];
            const dist = Math.hypot(dx, dz);
            if (dist > 80) continue;
            // Aim cone check
            const ang = Math.atan2(dx, -dz);
            let dang = ang - bot.rot[1];
            while (dang > Math.PI) dang -= Math.PI * 2;
            while (dang < -Math.PI) dang += Math.PI * 2;
            if (Math.abs(dang) > (8 * Math.PI / 180)) continue;
            if (dist < bestEnemyDist) { bestEnemyDist = dist; fireTarget = p; }
        }
        if (fireTarget) buttons |= BTN_FIRE;

        return {
            tick,
            buttons,
            mouseDX,
            mouseDY,
            pingMs: 0,
            weaponSelect: 0xFF,
        };
    }

    // Diagnostics for [METRIC] logging
    getRoleSummary(): { offense: number; defense: number; midfield: number; total: number } {
        let o = 0, d = 0, m = 0;
        for (const s of this.states.values()) {
            if (s.role === 'offense') o++;
            else if (s.role === 'defense') d++;
            else m++;
        }
        return { offense: o, defense: d, midfield: m, total: this.states.size };
    }
}
