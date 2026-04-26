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
    TICK_DT, TICK_HZ, ARMORS, WEAPONS, CLASSES, GRAVITY,
    LAGCOMP_BUFFER_TICKS,
    MATCH_WARMUP_SEC, RESPAWN_TIMER_SEC, SPAWN_PROTECTION_SEC,
    MATCH_WARMUP, MATCH_IN_PROGRESS, MATCH_END,
    BTN_FORWARD, BTN_BACK, BTN_LEFT, BTN_RIGHT, BTN_JUMP, BTN_SKI, BTN_FIRE, BTN_USE_REPAIR,
    WORLD_HALF,
} from './constants.js';
import { encodeSnapshot, encodeDelta } from './wire.js';
import { BotAI } from './bot_ai.ts';

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
    // R20 additions:
    recentInputs: RecentInput[];        // ring of last ~5s inputs (for bot replay on disconnect)
    isBot: boolean;                     // tier-1 disconnect bot if true
    botReplayCursor: number;            // index into recentInputs being replayed
    botReplaySource: number;            // playerId whose inputs we're replaying (for jitter seed)
    divergeViolations: number[];        // wallTime stamps of recent diverge events (10s window)
    kills: number;                      // for MVP calculation
    deaths: number;
    uuid: string;                       // stable across reconnect
    // R23 additions:
    classId: number;                    // 0=light,1=medium,2=heavy (mirrors armor)
    inventory: { repairPacks: number };
    repairTimer: number;                // seconds remaining of active repair-pack heal
    loadoutViolations: number[];        // wallTime stamps for kick on 3-in-10s
    lastDamageFromIdx: number;          // -1 or attacker player id (R23 lastDamageFrom)
    lastDamageAtTick: number;           // server tick of last damage taken
    // R24 additions:
    skillRating: number;                // ELO-lite rating, default SKILL_INITIAL
    matchesPlayed: number;
    // Per-match telemetry counters (reset on resetForRematch)
    shotsFired: number;
    killsScored: number;                // computed elsewhere; mirror count for telemetry
    jetTicks: number;
    skiTicks: number;
    skiDistanceM: number;
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

interface LagCompEntry {
    pos: [number, number, number];
    rot: [number, number, number];
}
interface LagCompFrame {
    tick: number;
    positions: Map<number, [number, number, number]>;     // legacy
    entries: Map<number, LagCompEntry>;                    // R20: pos + rot
}

interface RecentInput {
    tick: number;
    input: PlayerInput;
    wallTime: number;
}

const HITSCAN_RANGE_M = 200;
const RECENT_INPUTS_PER_PLAYER = 300; // 5s at 60Hz
const BOT_INPUT_REPLAY_LOOP_LEN = 300; // 5s

// Ray-sphere intersection helper (returns t > 0 of nearest hit, or null)
function raySphereIntersect(orig: [number, number, number], dir: [number, number, number],
                            center: [number, number, number], radius: number): number | null {
    const ox = orig[0] - center[0], oy = orig[1] - center[1], oz = orig[2] - center[2];
    const b = ox * dir[0] + oy * dir[1] + oz * dir[2];
    const c = ox * ox + oy * oy + oz * oz - radius * radius;
    const disc = b * b - c;
    if (disc < 0) return null;
    const sq = Math.sqrt(disc);
    const t1 = -b - sq;
    if (t1 > 0) return t1;
    const t2 = -b + sq;
    if (t2 > 0) return t2;
    return null;
}

const NEXT_PROJ_ID = { v: 1 };

export class Match {
    tick = 0;
    players = new Map<number, SimPlayer>();
    botAI = new BotAI();   // R22: real A* bot AI
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

    addPlayer(id: number, name: string, team: number, armor = 0, uuid = '', classId = -1): SimPlayer {
        const flagPos = this.flags[team].homePos;
        // R23: classId defaults to armor (backward compat with R22 callers)
        const klass = CLASSES[classId >= 0 ? classId : armor] || CLASSES[0];
        const p: SimPlayer = {
            id, name, team, armor: klass.id,
            pos: [flagPos[0] + (Math.random() * 6 - 3), flagPos[1] + 5, flagPos[2] + (Math.random() * 6 - 3)],
            vel: [0, 0, 0],
            rot: [0, 0, 0],
            health: 1, energy: 1,
            alive: true,
            onGround: false,
            jetting: false,
            skiing: false,
            weaponIdx: klass.weapons[1] ?? klass.weapons[0],   // start on second weapon if exists (e.g., Disc for light)
            fireCooldown: 0,
            carryingFlag: -1,
            spawnProtectUntil: Date.now() + SPAWN_PROTECTION_SEC * 1000,
            respawnAt: 0,
            inputRateWindow: [],
            recentInputs: [],
            isBot: false,
            botReplayCursor: 0,
            botReplaySource: -1,
            divergeViolations: [],
            kills: 0, deaths: 0,
            uuid,
            classId: klass.id,
            inventory: { repairPacks: klass.repairPacks },
            repairTimer: 0,
            loadoutViolations: [],
            lastDamageFromIdx: -1,
            lastDamageAtTick: -1,
            skillRating: 1000,         // R24: lobby will overwrite from store on join
            matchesPlayed: 0,
            shotsFired: 0,
            killsScored: 0,
            jetTicks: 0,
            skiTicks: 0,
            skiDistanceM: 0,
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
        while (p.inputRateWindow.length > 0 && p.inputRateWindow[0] < now - 1000) {
            p.inputRateWindow.shift();
        }
        // R20: keep recent inputs ring for bot fill on disconnect
        p.recentInputs.push({ tick: input.tick, input, wallTime: now });
        if (p.recentInputs.length > RECENT_INPUTS_PER_PLAYER) p.recentInputs.shift();

        // Apply rotation (clamped pitch)
        p.rot[0] = Math.max(-1.4, Math.min(1.4, p.rot[0] + input.mouseDY));
        p.rot[1] += input.mouseDX;

        // Weapon switch — R23: validate against class loadout
        const klass = CLASSES[p.classId] || CLASSES[0];
        if (input.weaponSelect != null && input.weaponSelect !== 0xFF && input.weaponSelect < WEAPONS.length) {
            if (klass.weapons.indexOf(input.weaponSelect) >= 0) {
                p.weaponIdx = input.weaponSelect;
            } else {
                // Loadout violation — drop input + record for kick threshold
                const nowMs = Date.now();
                p.loadoutViolations.push(nowMs);
                while (p.loadoutViolations.length > 0 && p.loadoutViolations[0] < nowMs - 10_000) {
                    p.loadoutViolations.shift();
                }
                console.log(`[CHEAT-LOADOUT] playerId=${p.id} selected=${input.weaponSelect} class=${klass.name}`);
            }
        }

        // R23: also validate fire input weapon-of-fire against class
        if ((input.buttons & BTN_FIRE) && klass.weapons.indexOf(p.weaponIdx) < 0) {
            const nowMs = Date.now();
            p.loadoutViolations.push(nowMs);
            while (p.loadoutViolations.length > 0 && p.loadoutViolations[0] < nowMs - 10_000) {
                p.loadoutViolations.shift();
            }
            console.log(`[CHEAT-LOADOUT] playerId=${p.id} fired=${p.weaponIdx} class=${klass.name}`);
            return;  // drop fire
        }

        // R23: Repair pack use (R key)
        if ((input.buttons & BTN_USE_REPAIR) && p.alive && p.inventory.repairPacks > 0 && p.repairTimer <= 0) {
            p.inventory.repairPacks--;
            p.repairTimer = 5.0;   // 5s of healing
            console.log(`[REPAIR] playerId=${p.id} used repair pack (remaining=${p.inventory.repairPacks})`);
        }

        // Hitscan: if firing chaingun (or other hitscan), do lag-comp raycast
        if ((input.buttons & BTN_FIRE) && (this.matchState === 1) && p.fireCooldown <= 0) {
            const w = WEAPONS[p.weaponIdx];
            if (w && w.hitscan) {
                const cooldown = (w.fireTime + (w.reloadTime || 0));
                this.fireHitscan(p, input);
                p.fireCooldown = cooldown;
                p.shotsFired++;        // R24 telemetry
            }
        }
    }

    // R23: caller (lobby.ts) checks this after applyInput; kicks on violation
    isLoadoutViolator(p: SimPlayer): boolean {
        return p.loadoutViolations.length >= 3;
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
        // R23: per-class energy regen mul
        const klassEnergyMul = (CLASSES[p.classId] || CLASSES[0]).energyRegenMul;
        p.energy = Math.min(1, p.energy + 0.15 * klassEnergyMul * dt);
        // R23: repair pack heal — +10 HP/sec for 5 sec (caps at full)
        if (p.repairTimer > 0) {
            p.repairTimer -= dt;
            p.health = Math.min(1, p.health + 0.10 * dt);
        }
        // R24 telemetry — per-tick movement accumulators
        if (p.jetting) p.jetTicks++;
        if (p.skiing) {
            p.skiTicks++;
            p.skiDistanceM += Math.hypot(p.vel[0], p.vel[2]) * dt;
        }

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
                    // Find shooter (matches projectile.team to first player on that team is approximate)
                    let shooter: SimPlayer | undefined;
                    for (const pp of this.players.values()) { if (pp.team === proj.team) { shooter = pp; break; } }
                    this.damagePlayer(target, w.damage, shooter);
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

    // R20: kill events accumulated per-tick, drained by lobby for broadcast
    pendingKillEvents: { killer: string, victim: string, weapon: number, killerTeam: number, victimTeam: number }[] = [];

    damagePlayer(target: SimPlayer, dmg: number, attacker?: SimPlayer) {
        target.health -= dmg;
        // R23: stamp last-damage-from for client damage-arc directional accuracy
        if (attacker && attacker.id !== target.id) {
            target.lastDamageFromIdx = attacker.id;
            target.lastDamageAtTick = this.tick;
        }
        if (target.health <= 0) {
            target.health = 0;
            target.alive = false;
            target.deaths++;
            if (attacker && attacker.team !== target.team) {
                attacker.kills++;
                this.pendingKillEvents.push({
                    killer: attacker.name, victim: target.name,
                    weapon: attacker.weaponIdx,
                    killerTeam: attacker.team, victimTeam: target.team,
                });
            }
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
        const entries = new Map<number, LagCompEntry>();
        for (const p of this.players.values()) {
            positions.set(p.id, [...p.pos]);
            entries.set(p.id, { pos: [...p.pos] as [number, number, number], rot: [...p.rot] as [number, number, number] });
        }
        this.lagCompBuffer.push({ tick: this.tick, positions, entries });
        if (this.lagCompBuffer.length > LAGCOMP_BUFFER_TICKS) {
            this.lagCompBuffer.shift();
        }
    }

    getRewoundPos(playerId: number, ticksAgo: number): [number, number, number] | null {
        const idx = this.lagCompBuffer.length - 1 - Math.min(ticksAgo, LAGCOMP_BUFFER_TICKS - 1);
        if (idx < 0) return null;
        const frame = this.lagCompBuffer[idx];
        return frame.positions.get(playerId) ?? null;
    }

    getRewoundEntry(playerId: number, ticksAgo: number): LagCompEntry | null {
        const idx = this.lagCompBuffer.length - 1 - Math.min(Math.max(0, ticksAgo), LAGCOMP_BUFFER_TICKS - 1);
        if (idx < 0) return null;
        const frame = this.lagCompBuffer[idx];
        return frame.entries.get(playerId) ?? null;
    }

    // R20: hitscan with lag compensation
    private _lagcompLogLast = new Map<number, number>(); // shooterId → wallTime
    fireHitscan(shooter: SimPlayer, input: PlayerInput) {
        const w = WEAPONS[shooter.weaponIdx];
        if (!w || !w.hitscan) return;
        const rttMs = input.pingMs | 0;
        const clientLagTicks = Math.round((rttMs / 2) / (1000 / TICK_HZ));
        const ticksAgo = Math.max(0, Math.min(LAGCOMP_BUFFER_TICKS - 1, clientLagTicks));

        // Use rewound shooter pos+rot (so fire direction matches what shooter saw)
        const shooterEntry = this.getRewoundEntry(shooter.id, ticksAgo) ??
            { pos: [...shooter.pos] as [number, number, number], rot: [...shooter.rot] as [number, number, number] };
        const eye: [number, number, number] = [shooterEntry.pos[0], shooterEntry.pos[1] + 1.6, shooterEntry.pos[2]];
        const yaw = shooterEntry.rot[1], pitch = shooterEntry.rot[0];
        const dir: [number, number, number] = [
            Math.sin(yaw) * Math.cos(pitch),
            Math.sin(pitch),
            -Math.cos(yaw) * Math.cos(pitch),
        ];

        let bestT = HITSCAN_RANGE_M;
        let bestTarget: SimPlayer | null = null;
        for (const target of this.players.values()) {
            if (target.id === shooter.id) continue;
            if (!target.alive) continue;
            if (target.team === shooter.team) continue;
            if (Date.now() < target.spawnProtectUntil) continue;
            const tEntry = this.getRewoundEntry(target.id, ticksAgo);
            if (!tEntry) continue;
            const center: [number, number, number] = [tEntry.pos[0], tEntry.pos[1] + 1.2, tEntry.pos[2]];
            const r = (ARMORS[target.armor]?.hitW ?? 0.6) + 0.5;
            const t = raySphereIntersect(eye, dir, center, r);
            if (t !== null && t < bestT) {
                bestT = t;
                bestTarget = target;
            }
        }
        if (bestTarget) {
            this.damagePlayer(bestTarget, w.damage, shooter);
            // Rate-limit lag-comp log (1/sec/shooter)
            const now = Date.now();
            const last = this._lagcompLogLast.get(shooter.id) ?? 0;
            if (now - last > 1000) {
                this._lagcompLogLast.set(shooter.id, now);
                console.log(`[LAG-COMP] shooter=${shooter.id} target=${bestTarget.id} rewindMs=${ticksAgo * (1000 / TICK_HZ) | 0}`);
            }
        }
    }

    // R20: divergence anti-cheat. Called by lobby with client-acked snapshot data.
    checkDivergence(playerId: number, clientPos: [number, number, number], clientRotYaw: number): boolean {
        const p = this.players.get(playerId);
        if (!p || !p.alive) return true;
        // Skip checks during spawn protection (just respawned, knockback, etc.)
        if (Date.now() < p.spawnProtectUntil) return true;
        const dx = p.pos[0] - clientPos[0];
        const dy = p.pos[1] - clientPos[1];
        const dz = p.pos[2] - clientPos[2];
        const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
        const dyaw = Math.abs(p.rot[1] - clientRotYaw) * 180 / Math.PI;
        if (dist > 2.0 || dyaw > 30) {
            const now = Date.now();
            p.divergeViolations.push(now);
            // Trim to 10s window
            while (p.divergeViolations.length > 0 && p.divergeViolations[0] < now - 10000) {
                p.divergeViolations.shift();
            }
            console.log(`[CHEAT-DIVERGE] playerId=${playerId} pos=${dist.toFixed(2)}m yaw=${dyaw.toFixed(1)}°`);
            if (p.divergeViolations.length >= 3) {
                console.log(`[CHEAT-DIVERGE-KICK] playerId=${playerId} 3+ violations in 10s`);
                return false; // signal kick
            }
        }
        return true;
    }

    // R20: bot fill — replay another player's recent inputs with jitter
    addDisconnectBot(disconnectedPlayer: SimPlayer): SimPlayer {
        const botId = 1000 + this.tick + Math.floor(Math.random() * 1000);
        const flagPos = this.flags[disconnectedPlayer.team].homePos;
        const bot: SimPlayer = {
            ...disconnectedPlayer,
            id: botId,
            name: `Bot_${disconnectedPlayer.name}`,
            pos: [flagPos[0] + (Math.random() * 6 - 3), flagPos[1] + 5, flagPos[2] + (Math.random() * 6 - 3)],
            vel: [0, 0, 0],
            health: 1, energy: 1,
            alive: true,
            spawnProtectUntil: Date.now() + SPAWN_PROTECTION_SEC * 1000,
            respawnAt: 0,
            isBot: true,
            botReplayCursor: 0,
            botReplaySource: disconnectedPlayer.id,
            recentInputs: [...disconnectedPlayer.recentInputs],
            inputRateWindow: [],
            divergeViolations: [],
            kills: 0, deaths: 0,
            uuid: '',
        };
        this.players.set(botId, bot);
        // R22: register with BotAI so per-tick computeInput() runs A*-driven behavior
        this.botAI.addBot(botId, this.players.size);
        console.log(`[BOT-FILL] replacing playerId=${disconnectedPlayer.id} (${disconnectedPlayer.name}) with botId=${botId}`);
        return bot;
    }

    evictBot(botId: number) {
        const bot = this.players.get(botId);
        if (!bot || !bot.isBot) return;
        this.players.delete(botId);
        this.botAI.removeBot(botId);
        console.log(`[BOT-EVICT] botId=${botId} (${bot.name}) removed`);
    }

    // R22: BotAI-driven input step (replaces R20 input-replay loop)
    private stepBotInputs(bot: SimPlayer) {
        const aiInput = this.botAI.computeInput(bot, this, this.tick);
        if (!aiInput) {
            // BotAI declined (bot dead) — fall back to input-replay if we have history
            if (bot.recentInputs.length > 0) {
                const entry = bot.recentInputs[bot.botReplayCursor % bot.recentInputs.length];
                bot.botReplayCursor++;
                bot.lastInput = entry.input;
                bot.rot[0] = Math.max(-1.4, Math.min(1.4, bot.rot[0] + entry.input.mouseDY));
                bot.rot[1] += entry.input.mouseDX;
            }
            return;
        }
        bot.lastInput = aiInput;
        bot.rot[0] = Math.max(-1.4, Math.min(1.4, bot.rot[0] + aiInput.mouseDY));
        bot.rot[1] += aiInput.mouseDX;
    }

    tickSimulation() {
        this.tick++;
        this.stepMatchState(TICK_DT);
        // Bots step their replay inputs first (sets lastInput before physics)
        for (const p of this.players.values()) {
            if (p.isBot) this.stepBotInputs(p);
        }
        for (const p of this.players.values()) this.stepPlayerPhysics(p, TICK_DT);
        this.stepProjectiles(TICK_DT);
        this.stepFlags(TICK_DT);
        this.captureLagCompFrame();
    }

    // R24: telemetry getter — caller (lobby endMatch) builds CSV row
    getTelemetrySnapshot() {
        const perWeapon = new Map<number, { shots: number; kills: number }>();
        const perClass = [
            { kills: 0, deaths: 0 },
            { kills: 0, deaths: 0 },
            { kills: 0, deaths: 0 },
        ];
        let totalJet = 0, totalSki = 0, totalSkiM = 0, humanCount = 0;
        for (const p of this.players.values()) {
            if (!p.isBot) humanCount++;
            const w = perWeapon.get(p.weaponIdx) || { shots: 0, kills: 0 };
            w.shots += p.shotsFired;
            w.kills += p.kills;
            perWeapon.set(p.weaponIdx, w);
            if (p.classId >= 0 && p.classId < 3) {
                perClass[p.classId].kills += p.kills;
                perClass[p.classId].deaths += p.deaths;
            }
            totalJet += p.jetTicks;
            totalSki += p.skiTicks;
            totalSkiM += p.skiDistanceM;
        }
        const ticks = Math.max(1, this.tick);
        return {
            durationS: ticks * TICK_DT,
            humanCount,
            perWeapon,
            perClass,
            avgJetS: totalJet * TICK_DT / Math.max(1, this.players.size),
            avgSkiS: totalSki * TICK_DT / Math.max(1, this.players.size),
            avgSkiM: totalSkiM / Math.max(1, this.players.size),
            scores: this.teamScore,
        };
    }

    // R20: full sim reset for "play again" (preserves player roster + teams)
    resetForRematch() {
        this.tick = 0;
        this.projectiles = [];
        this.teamScore = [0, 0];
        this.matchState = MATCH_WARMUP;
        this.warmupTimer = MATCH_WARMUP_SEC;
        this.roundTimer = 600;
        this.lagCompBuffer = [];
        for (const f of this.flags) {
            f.pos = [...f.homePos];
            f.state = 0; f.carrierIdx = -1; f.dropTimer = 0;
        }
        for (const p of this.players.values()) {
            p.kills = 0; p.deaths = 0;
            p.health = 1; p.energy = 1;
            p.alive = true; p.respawnAt = 0;
            p.carryingFlag = -1;
            p.divergeViolations = [];
            p.spawnProtectUntil = Date.now() + SPAWN_PROTECTION_SEC * 1000;
            const flagPos = this.flags[p.team].homePos;
            p.pos = [flagPos[0] + (Math.random() * 6 - 3), flagPos[1] + 5, flagPos[2] + (Math.random() * 6 - 3)];
            p.vel = [0, 0, 0];
            // R24: telemetry reset
            p.shotsFired = 0;
            p.killsScored = 0;
            p.jetTicks = 0;
            p.skiTicks = 0;
            p.skiDistanceM = 0;
        }
    }

    // R20: MVP per team for match-end screen
    getMvpPerTeam(): { team0: SimPlayer | null, team1: SimPlayer | null } {
        let m0: SimPlayer | null = null;
        let m1: SimPlayer | null = null;
        for (const p of this.players.values()) {
            if (p.team === 0 && (!m0 || p.kills > m0.kills)) m0 = p;
            if (p.team === 1 && (!m1 || p.kills > m1.kills)) m1 = p;
        }
        return { team0: m0, team1: m1 };
    }

    serializeSnapshot(): Uint8Array {
        const playersArr = [...this.players.values()].map(p => ({
            id: p.id, alive: p.alive, visible: true, jetting: p.jetting, skiing: p.skiing, firing: false,
            team: p.team, armor: p.armor,
            pos: p.pos, rot: p.rot, vel: p.vel,
            health: p.health, energy: p.energy,
            weaponIdx: p.weaponIdx, carryingFlag: p.carryingFlag,
            botRole: p.isBot ? 0 : -1,
            // R23: damage-from-idx is fresh (within last 8 ticks) so client can show arc
            lastDamageFromIdx: (p.lastDamageAtTick > 0 && this.tick - p.lastDamageAtTick < 8) ? p.lastDamageFromIdx : -1,
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
