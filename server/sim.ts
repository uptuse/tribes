// ============================================================
// Server-side authoritative simulation (TS port of relevant C++ logic).
// Runs at fixed 30Hz tick. ±1cm/sec drift vs C++ accepted; reconciliation
// smooths visible position correction client-side.
//
// What this file owns:
//   - Player physics (gravity, friction, jet, ski)
//   - Projectile spawning, gravity, hit detection
//   - Flag pickup/drop/cap
//   - Match state machine (warmup → in-progress → ended)
//   - Lag-compensation ring buffer
//   - applyInput / tickSimulation / serializeSnapshot
// ============================================================

import {
    TICK_DT, TICK_HZ, ARMORS, WEAPONS, GRAVITY,
    LAGCOMP_BUFFER_TICKS,
    MATCH_WARMUP_SEC, RESPAWN_TIMER_SEC, SPAWN_PROTECTION_SEC,
    MATCH_WARMUP, MATCH_IN_PROGRESS, MATCH_END,
    BTN_FORWARD, BTN_BACK, BTN_LEFT, BTN_RIGHT, BTN_JUMP, BTN_SKI, BTN_FIRE,
    WORLD_HALF,
} from './constants.js';
import { encodeSnapshot, encodeDelta } from './wire.js';

// ---- Types ----
export interface PlayerInput {
    tick: number;
    buttons: number;
    mouseDX: number;
    mouseDY: number;
    pingMs: number;
    weaponSelect: number;
}

export interface SimPlayer {
    id: number;
    name: string;
    team: number;             // 0 or 1
    armor: number;            // 0=light, 1=medium, 2=heavy
    pos: [number, number, number];
    vel: [number, number, number];
    rot: [number, number, number];   // [pitch, yaw, roll]
    health: number;           // [0..1]
    energy: number;           // [0..1]
    alive: boolean;
    onGround: boolean;
    jetting: boolean;
    skiing: boolean;
    weaponIdx: number;
    fireCooldown: number;
    carryingFlag: number;     // -1 or team idx
    spawnProtectUntil: number; // wall time
    respawnAt: number;         // 0 or wall time
    lastInput?: PlayerInput;
    inputRateWindow: number[]; // timestamps of recent inputs (for sanity check)
}

export interface SimProjectile {
    id: number;
    type: number;
    team: number;
    pos: [number, number, number];
    vel: [number, number, number];
    age: number;
    alive: boolean;
}

export interface SimFlag {
    team: number;             // 0 or 1
    pos: [number, number, number];
    homePos: [number, number, number];
    state: number;            // 0=at-base, 1=carried, 2=dropped
    carrierIdx: number;
    dropTimer: number;
}

interface LagCompFrame {
    tick: number;
    positions: Map<number, [number, number, number]>;
}

const NEXT_PROJ_ID = { v: 1 };

export class Match {
    tick = 0;
    players = new Map<number, SimPlayer>();
    projectiles: SimProjectile[] = [];
    flags: SimFlag[] = [
        { team: 0, pos: [-100, 30, -50], homePos: [-100, 30, -50], state: 0, carrierIdx: -1, dropTimer: 0 },
        { team: 1, pos: [ 100, 30,  50], homePos: [ 100, 30,  50], state: 0, carrierIdx: -1, dropTimer: 0 },
    ];
    teamScore: [number, number] = [0, 0];
    matchState = MATCH_WARMUP;
    warmupTimer = MATCH_WARMUP_SEC;
    roundTimer = 600;
    scoreLimit = 5;
    lagCompBuffer: LagCompFrame[] = [];
    cheatLog: { playerId: number; reason: string; tick: number }[] = [];

    addPlayer(id: number, name: string, team: number, armor = 0): SimPlayer {
        const flagPos = this.flags[team].homePos;
        const p: SimPlayer = {
            id, name, team, armor,
            pos: [flagPos[0] + (Math.random() * 6 - 3), flagPos[1] + 5, flagPos[2] + (Math.random() * 6 - 3)],
            vel: [0, 0, 0],
            rot: [0, 0, 0],
            health: 1, energy: 1,
            alive: true,
            onGround: false,
            jetting: false,
            skiing: false,
            weaponIdx: 2, // disc default
            fireCooldown: 0,
            carryingFlag: -1,
            spawnProtectUntil: Date.now() + SPAWN_PROTECTION_SEC * 1000,
            respawnAt: 0,
            inputRateWindow: [],
        };
        this.players.set(id, p);
        return p;
    }
    removePlayer(id: number) {
        const p = this.players.get(id);
        if (p && p.carryingFlag >= 0) {
            // Drop the flag at player's position
            const f = this.flags[p.carryingFlag];
            f.state = 2;
            f.pos = [...p.pos];
            f.carrierIdx = -1;
            f.dropTimer = 30; // 30s auto-return
        }
        this.players.delete(id);
    }

    applyInput(playerId: number, input: PlayerInput) {
        const p = this.players.get(playerId);
        if (!p) return;
        p.lastInput = input;
        const now = Date.now();
        p.inputRateWindow.push(now);
        // Trim window to last 1s
        while (p.inputRateWindow.length > 0 && p.inputRateWindow[0] < now - 1000) {
            p.inputRateWindow.shift();
        }

        // Apply rotation (clamped pitch)
        p.rot[0] = Math.max(-1.4, Math.min(1.4, p.rot[0] + input.mouseDY));
        p.rot[1] += input.mouseDX;

        // Weapon switch
        if (input.weaponSelect != null && input.weaponSelect !== 0xFF && input.weaponSelect < WEAPONS.length) {
            p.weaponIdx = input.weaponSelect;
        }
    }

    // Step physics for one player based on their last input (or zero if none)
    stepPlayerPhysics(p: SimPlayer, dt: number) {
        if (!p.alive) {
            if (Date.now() >= p.respawnAt && p.respawnAt > 0) {
                this.respawnPlayer(p);
            }
            return;
        }
        const armor = ARMORS[p.armor] || ARMORS[0];
        const buttons = p.lastInput?.buttons ?? 0;
        const fwd = buttons & BTN_FORWARD;
        const back = buttons & BTN_BACK;
        const left = buttons & BTN_LEFT;
        const right = buttons & BTN_RIGHT;
        const jump = buttons & BTN_JUMP;
        const ski = buttons & BTN_SKI;
        const fire = buttons & BTN_FIRE;

        // Movement direction in world space (from yaw)
        const yaw = p.rot[1];
        const fwdX = Math.sin(yaw),  fwdZ = -Math.cos(yaw);
        const rgtX = Math.cos(yaw),  rgtZ =  Math.sin(yaw);
        let mvx = 0, mvz = 0;
        if (fwd)  { mvx += fwdX; mvz += fwdZ; }
        if (back) { mvx -= fwdX; mvz -= fwdZ; }
        if (left) { mvx -= rgtX; mvz -= rgtZ; }
        if (right){ mvx += rgtX; mvz += rgtZ; }
        const mvLen = Math.hypot(mvx, mvz);
        if (mvLen > 0) { mvx /= mvLen; mvz /= mvLen; }

        // Ground detection (simple: y < 1.5 from terrain plane y=0 in this sim)
        // Server's terrain is approximated as y=0 plane for R19. Real terrain
        // sampling is on the client (heightmap-driven); reconciliation handles drift.
        const groundY = 0;
        p.onGround = p.pos[1] - groundY < 1.5;
        p.skiing   = !!ski && p.onGround;

        const maxSpd = armor.maxFwdSpeed;

        if (p.onGround) {
            if (p.skiing) {
                // Skiing: low friction, allow speed buildup from velocity inheritance
                p.vel[0] *= (1 - 0.005);
                p.vel[2] *= (1 - 0.005);
                if (mvLen > 0) {
                    p.vel[0] += mvx * 14 * dt;
                    p.vel[2] += mvz * 14 * dt;
                }
            } else {
                // Walking: capped at maxFwdSpeed, hard friction otherwise
                if (mvLen > 0) {
                    p.vel[0] = mvx * maxSpd;
                    p.vel[2] = mvz * maxSpd;
                } else {
                    p.vel[0] *= 0.85;
                    p.vel[2] *= 0.85;
                }
                if (p.vel[1] < 0) p.vel[1] = 0;
            }
            // Jump
            if (jump && p.energy > 0.05) {
                p.vel[1] += 8.0;
                p.energy -= 0.02;
                p.onGround = false;
            }
        } else {
            // Airborne — small steering
            if (mvLen > 0) {
                p.vel[0] += mvx * 28 * dt;
                p.vel[2] += mvz * 28 * dt;
            }
        }

        // Jet (works in air with energy)
        p.jetting = !!jump && !p.onGround && p.energy > armor.jetEnergyDrain * 0.025;
        if (p.jetting) {
            p.vel[1] += (armor.jetForce / armor.mass) * dt;
            p.energy -= armor.jetEnergyDrain * dt;
        }

        // Gravity
        if (!p.onGround) p.vel[1] += GRAVITY * dt;

        // Energy recharge
        p.energy = Math.min(1, p.energy + 0.15 * dt);

        // Apply velocity
        p.pos[0] += p.vel[0] * dt;
        p.pos[1] += p.vel[1] * dt;
        p.pos[2] += p.vel[2] * dt;

        // Ground clamp
        if (p.pos[1] < groundY + 1) {
            p.pos[1] = groundY + 1;
            if (p.vel[1] < 0) p.vel[1] = 0;
        }
        // World bounds
        p.pos[0] = Math.max(-WORLD_HALF, Math.min(WORLD_HALF, p.pos[0]));
        p.pos[2] = Math.max(-WORLD_HALF, Math.min(WORLD_HALF, p.pos[2]));

        // Fire
        p.fireCooldown -= dt;
        if (fire && p.fireCooldown <= 0 && this.matchState === MATCH_IN_PROGRESS) {
            this.spawnProjectile(p);
            const w = WEAPONS[p.weaponIdx] || WEAPONS[2];
            p.fireCooldown = w.fireTime + (w.reloadTime || 0);
        }
    }

    respawnPlayer(p: SimPlayer) {
        const flagPos = this.flags[p.team].homePos;
        p.pos = [flagPos[0] + (Math.random() * 6 - 3), flagPos[1] + 5, flagPos[2] + (Math.random() * 6 - 3)];
        p.vel = [0, 0, 0];
        p.health = 1;
        p.energy = 1;
        p.alive = true;
        p.respawnAt = 0;
        p.spawnProtectUntil = Date.now() + SPAWN_PROTECTION_SEC * 1000;
    }

    spawnProjectile(p: SimPlayer) {
        const w = WEAPONS[p.weaponIdx] || WEAPONS[2];
        if (!w.muzzleVel) return; // lasers etc
        const yaw = p.rot[1], pitch = p.rot[0];
        const dirX = Math.sin(yaw) * Math.cos(pitch);
        const dirY = Math.sin(pitch);
        const dirZ = -Math.cos(yaw) * Math.cos(pitch);
        const proj: SimProjectile = {
            id: NEXT_PROJ_ID.v++ & 0xFF,
            type: p.weaponIdx,
            team: p.team,
            pos: [p.pos[0] + dirX * 2, p.pos[1] + 1.5 + dirY * 2, p.pos[2] + dirZ * 2],
            vel: [
                dirX * w.muzzleVel + p.vel[0] * 0.5,
                dirY * w.muzzleVel + p.vel[1] * 0.5,
                dirZ * w.muzzleVel + p.vel[2] * 0.5,
            ],
            age: 0,
            alive: true,
        };
        this.projectiles.push(proj);
        if (this.projectiles.length > 200) this.projectiles.shift();
    }

    stepProjectiles(dt: number) {
        for (const proj of this.projectiles) {
            if (!proj.alive) continue;
            const w = WEAPONS[proj.type] || WEAPONS[0];
            proj.vel[1] -= (w.gravity || 0) * dt;
            proj.pos[0] += proj.vel[0] * dt;
            proj.pos[1] += proj.vel[1] * dt;
            proj.pos[2] += proj.vel[2] * dt;
            proj.age += dt;
            if (proj.age > 8) { proj.alive = false; continue; }
            if (proj.pos[1] < 0) { proj.alive = false; continue; }
            // Player hit detection
            for (const target of this.players.values()) {
                if (!target.alive || target.id === -1) continue;
                if (target.team === proj.team) continue;
                if (Date.now() < target.spawnProtectUntil) continue;
                const dx = target.pos[0] - proj.pos[0];
                const dy = target.pos[1] + 1.2 - proj.pos[1];
                const dz = target.pos[2] - proj.pos[2];
                const d2 = dx*dx + dy*dy + dz*dz;
                const r = (ARMORS[target.armor]?.hitW ?? 0.6) + 0.5;
                if (d2 < r * r) {
                    this.damagePlayer(target, w.damage);
                    proj.alive = false;
                    break;
                }
            }
        }
        // Compact dead projectiles occasionally
        if (this.tick % 30 === 0) {
            this.projectiles = this.projectiles.filter(p => p.alive);
        }
    }

    damagePlayer(target: SimPlayer, dmg: number) {
        target.health -= dmg;
        if (target.health <= 0) {
            target.health = 0;
            target.alive = false;
            target.respawnAt = Date.now() + RESPAWN_TIMER_SEC * 1000;
            if (target.carryingFlag >= 0) {
                const f = this.flags[target.carryingFlag];
                f.state = 2;
                f.pos = [...target.pos];
                f.carrierIdx = -1;
                f.dropTimer = 30;
                target.carryingFlag = -1;
            }
        }
    }

    stepFlags(dt: number) {
        for (const f of this.flags) {
            if (f.state === 1 && f.carrierIdx >= 0) {
                const carrier = this.players.get(f.carrierIdx);
                if (!carrier || !carrier.alive) {
                    f.state = 2; f.carrierIdx = -1; f.dropTimer = 30;
                } else {
                    f.pos = [carrier.pos[0], carrier.pos[1] + 2, carrier.pos[2]];
                }
            } else if (f.state === 2) {
                f.dropTimer -= dt;
                if (f.dropTimer <= 0) {
                    f.pos = [...f.homePos];
                    f.state = 0;
                    f.carrierIdx = -1;
                }
            }
            // Pickup detection
            if (f.state !== 1) {
                for (const p of this.players.values()) {
                    if (!p.alive) continue;
                    const dx = p.pos[0] - f.pos[0];
                    const dz = p.pos[2] - f.pos[2];
                    const dy = p.pos[1] - f.pos[1];
                    if (dx*dx + dy*dy + dz*dz < 16) {
                        if (p.team === f.team) {
                            // Own flag: return if not at home, capture if carrying enemy
                            if (f.state !== 0) { f.state = 0; f.pos = [...f.homePos]; }
                            else if (p.carryingFlag >= 0) {
                                // Capture
                                const cf = this.flags[p.carryingFlag];
                                cf.state = 0; cf.pos = [...cf.homePos]; cf.carrierIdx = -1;
                                p.carryingFlag = -1;
                                this.teamScore[p.team]++;
                                if (this.teamScore[p.team] >= this.scoreLimit) {
                                    this.matchState = MATCH_END;
                                }
                            }
                        } else if (p.carryingFlag < 0) {
                            // Enemy flag pickup
                            f.state = 1; f.carrierIdx = p.id;
                            p.carryingFlag = f.team;
                        }
                    }
                }
            }
        }
    }

    stepMatchState(dt: number) {
        if (this.matchState === MATCH_WARMUP) {
            this.warmupTimer -= dt;
            if (this.warmupTimer <= 0) {
                this.matchState = MATCH_IN_PROGRESS;
                this.warmupTimer = 0;
            }
        } else if (this.matchState === MATCH_IN_PROGRESS) {
            this.roundTimer -= dt;
            if (this.roundTimer <= 0) {
                this.roundTimer = 0;
                this.matchState = MATCH_END;
            }
        }
    }

    captureLagCompFrame() {
        const positions = new Map<number, [number, number, number]>();
        for (const p of this.players.values()) {
            positions.set(p.id, [...p.pos]);
        }
        this.lagCompBuffer.push({ tick: this.tick, positions });
        if (this.lagCompBuffer.length > LAGCOMP_BUFFER_TICKS) {
            this.lagCompBuffer.shift();
        }
    }

    // Lag-comp lookup (used by hitscan; R19 scaffold doesn't fully wire raycast)
    getRewoundPos(playerId: number, ticksAgo: number): [number, number, number] | null {
        const idx = this.lagCompBuffer.length - 1 - Math.min(ticksAgo, LAGCOMP_BUFFER_TICKS - 1);
        if (idx < 0) return null;
        const frame = this.lagCompBuffer[idx];
        return frame.positions.get(playerId) ?? null;
    }

    tickSimulation() {
        this.tick++;
        this.stepMatchState(TICK_DT);
        for (const p of this.players.values()) this.stepPlayerPhysics(p, TICK_DT);
        this.stepProjectiles(TICK_DT);
        this.stepFlags(TICK_DT);
        this.captureLagCompFrame();
    }

    serializeSnapshot(): Uint8Array {
        const playersArr = [...this.players.values()].map(p => ({
            id: p.id, alive: p.alive, visible: true, jetting: p.jetting, skiing: p.skiing, firing: false,
            team: p.team, armor: p.armor,
            pos: p.pos, rot: p.rot, vel: p.vel,
            health: p.health, energy: p.energy,
            weaponIdx: p.weaponIdx, carryingFlag: p.carryingFlag, botRole: -1,
        }));
        const projsArr = this.projectiles.filter(p => p.alive).slice(0, 200).map(p => ({
            id: p.id, type: p.type, team: p.team, alive: p.alive, pos: p.pos, age: p.age,
        }));
        const flagsArr = this.flags.map(f => ({
            team: f.team, state: f.state, carrierIdx: f.carrierIdx, pos: f.pos,
        }));
        return encodeSnapshot({
            tick: this.tick, matchTick: this.tick & 0xFFFF, matchState: this.matchState,
            teamScore: this.teamScore,
            players: playersArr, projectiles: projsArr, flags: flagsArr,
        });
    }
    serializeDelta(): Uint8Array {
        // R19 scaffold: same payload, different msg type. Real per-field delta is R20+.
        const snap = this.serializeSnapshot();
        const delta = encodeDelta({
            tick: this.tick, matchTick: this.tick & 0xFFFF, matchState: this.matchState,
            teamScore: this.teamScore,
            players: [], projectiles: [], flags: this.flags.map(f => ({ team: f.team, state: f.state, carrierIdx: f.carrierIdx, pos: f.pos })),
        });
        return delta;
    }
}
