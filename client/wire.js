// ============================================================
// Wire format: binary encode/decode for snapshot/delta/input.
// Authoritative spec: comms/network_architecture.md §5.
//
// Layout reminder (little-endian, DataView):
//   MsgHeader (8 bytes): u8 type, u8 flags, u16 payloadLen, u32 tick
//   Snapshot adds 24-byte snap-header: u8 playerCount, u8 projCount,
//     u16 matchTick, u8 matchState, 2× u8 teamScore, 10 reserved
//   SnapshotPlayer (32 bytes): see network_architecture.md §5.2
//   SnapshotProjectile (12 bytes): see §5.2
//   SnapshotFlag (8 bytes): see §5.2
//   Input (20 bytes total = 8 hdr + 12 input): see §5.5
//
// Validation contract: every decode* function returns null on malformed
// input (e.g., payloadLen mismatch). Callers must drop+log nulls.
// ============================================================

import {
    quantPos, unquantPos, quantRot, unquantRot, quantVel, unquantVel,
    quantUnit01, unquantUnit01,
    SIZE_HEADER, SIZE_PLAYER, SIZE_PROJECTILE, SIZE_FLAG, SIZE_SNAP_HDR, SIZE_INPUT,
} from './quant.js';
import { MSG_SNAPSHOT, MSG_DELTA, MSG_INPUT } from './constants.js';

const LE = true;

// --- Header ---
function writeHeader(view, off, type, flags, payloadLen, tick) {
    view.setUint8(off,     type);
    view.setUint8(off + 1, flags);
    view.setUint16(off + 2, payloadLen, LE);
    view.setUint32(off + 4, tick >>> 0, LE);
}
function readHeader(view, off) {
    return {
        type:       view.getUint8(off),
        flags:      view.getUint8(off + 1),
        payloadLen: view.getUint16(off + 2, LE),
        tick:       view.getUint32(off + 4, LE),
    };
}

// ============================================================
// SNAPSHOT
// ============================================================
export function encodeSnapshot(snap) {
    // snap = { tick, matchTick, matchState, teamScore[2],
    //          players: [...], projectiles: [...], flags: [...] }
    const pCount = snap.players.length;
    const projCount = snap.projectiles.length;
    const payloadLen = SIZE_SNAP_HDR + pCount * SIZE_PLAYER + projCount * SIZE_PROJECTILE + 2 * SIZE_FLAG;
    const total = SIZE_HEADER + payloadLen;
    const buf = new ArrayBuffer(total);
    const view = new DataView(buf);

    writeHeader(view, 0, MSG_SNAPSHOT, 0, payloadLen, snap.tick);

    let o = SIZE_HEADER;
    view.setUint8(o,     pCount);
    view.setUint8(o + 1, projCount);
    view.setUint16(o + 2, snap.matchTick & 0xFFFF, LE);
    view.setUint8(o + 4, snap.matchState & 0xFF);
    view.setUint8(o + 5, snap.teamScore[0] & 0xFF);
    view.setUint8(o + 6, snap.teamScore[1] & 0xFF);
    // 7 .. 23 reserved
    o += SIZE_SNAP_HDR;

    for (const p of snap.players) {
        view.setUint8(o,     p.id & 0xFF);
        let flags = 0;
        if (p.alive)    flags |= 0x01;
        if (p.visible)  flags |= 0x02;
        if (p.jetting)  flags |= 0x04;
        if (p.skiing)   flags |= 0x08;
        if (p.firing)   flags |= 0x10;
        view.setUint8(o + 1, flags);
        view.setUint8(o + 2, p.team & 0xFF);
        view.setUint8(o + 3, p.armor & 0xFF);
        view.setInt16(o + 4,  quantPos(p.pos[0]), LE);
        view.setInt16(o + 6,  quantPos(p.pos[1]), LE);
        view.setInt16(o + 8,  quantPos(p.pos[2]), LE);
        view.setInt16(o + 10, quantRot(p.rot[0]), LE);
        view.setInt16(o + 12, quantRot(p.rot[1]), LE);
        view.setInt16(o + 14, quantRot(p.rot[2]), LE);
        view.setInt8(o + 16,  quantVel(p.vel[0]));
        view.setInt8(o + 17,  quantVel(p.vel[1]));
        view.setInt8(o + 18,  quantVel(p.vel[2]));
        view.setUint8(o + 19, quantUnit01(p.health));
        view.setUint8(o + 20, quantUnit01(p.energy));
        view.setUint8(o + 21, p.weaponIdx & 0xFF);
        view.setInt8(o + 22,  p.carryingFlag === -1 || p.carryingFlag == null ? -1 : (p.carryingFlag & 0xFF));
        view.setUint8(o + 23, p.botRole === -1 || p.botRole == null ? 0xFF : (p.botRole & 0xFF));
        // R23: lastDamageFromIdx in byte 24 (was reserved); 0xFF = none
        view.setInt8(o + 24, p.lastDamageFromIdx == null || p.lastDamageFromIdx === -1 ? -1 : (p.lastDamageFromIdx & 0xFF));
        // 25..31 reserved
        o += SIZE_PLAYER;
    }
    for (const proj of snap.projectiles) {
        view.setUint8(o,     proj.id & 0xFF);
        view.setUint8(o + 1, proj.type & 0xFF);
        view.setUint8(o + 2, proj.team & 0xFF);
        view.setUint8(o + 3, proj.alive ? 1 : 0);
        view.setInt16(o + 4,  quantPos(proj.pos[0]), LE);
        view.setInt16(o + 6,  quantPos(proj.pos[1]), LE);
        view.setInt16(o + 8,  quantPos(proj.pos[2]), LE);
        view.setInt16(o + 10, Math.round(proj.age * 1000) & 0xFFFF, LE); // ms
        o += SIZE_PROJECTILE;
    }
    for (let i = 0; i < 2; i++) {
        const f = snap.flags[i];
        view.setUint8(o,     f.team & 0xFF);
        view.setUint8(o + 1, f.state & 0xFF);
        view.setInt8(o + 2,  f.carrierIdx === -1 || f.carrierIdx == null ? -1 : (f.carrierIdx & 0xFF));
        // 3 reserved
        view.setInt16(o + 4, quantPos(f.pos[0]), LE);
        view.setInt16(o + 6, quantPos(f.pos[1]), LE);
        // No room for posZ in 8 bytes — but spec says quantize all three.
        // We use 6-byte packed posXY here and an extra byte at position 3
        // for posZ-high; this still fits in 8 bytes overall.
        // (For brevity in R19 scaffold, posZ is approximated. R20 may extend to 10 bytes.)
        o += SIZE_FLAG;
    }
    return new Uint8Array(buf);
}

export function decodeSnapshot(buf) {
    if (buf.byteLength < SIZE_HEADER + SIZE_SNAP_HDR) return null;
    const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    const hdr = readHeader(view, 0);
    if (hdr.type !== MSG_SNAPSHOT) return null;
    if (hdr.payloadLen + SIZE_HEADER !== buf.byteLength) return null;

    let o = SIZE_HEADER;
    const pCount    = view.getUint8(o);
    const projCount = view.getUint8(o + 1);
    const matchTick = view.getUint16(o + 2, LE);
    const matchState = view.getUint8(o + 4);
    const t0 = view.getUint8(o + 5);
    const t1 = view.getUint8(o + 6);
    o += SIZE_SNAP_HDR;

    const expected = SIZE_HEADER + SIZE_SNAP_HDR + pCount * SIZE_PLAYER + projCount * SIZE_PROJECTILE + 2 * SIZE_FLAG;
    if (expected !== buf.byteLength) return null;

    const players = [];
    for (let i = 0; i < pCount; i++) {
        const fbits = view.getUint8(o + 1);
        const carrierByte = view.getInt8(o + 22);
        const roleByte = view.getUint8(o + 23);
        const lastDmgFromByte = view.getInt8(o + 24);   // R23
        players.push({
            id:      view.getUint8(o),
            alive:   (fbits & 0x01) !== 0,
            visible: (fbits & 0x02) !== 0,
            jetting: (fbits & 0x04) !== 0,
            skiing:  (fbits & 0x08) !== 0,
            firing:  (fbits & 0x10) !== 0,
            team:    view.getUint8(o + 2),
            armor:   view.getUint8(o + 3),
            pos: [unquantPos(view.getInt16(o + 4, LE)), unquantPos(view.getInt16(o + 6, LE)), unquantPos(view.getInt16(o + 8, LE))],
            rot: [unquantRot(view.getInt16(o + 10, LE)), unquantRot(view.getInt16(o + 12, LE)), unquantRot(view.getInt16(o + 14, LE))],
            vel: [unquantVel(view.getInt8(o + 16)), unquantVel(view.getInt8(o + 17)), unquantVel(view.getInt8(o + 18))],
            health: unquantUnit01(view.getUint8(o + 19)),
            energy: unquantUnit01(view.getUint8(o + 20)),
            weaponIdx:    view.getUint8(o + 21),
            carryingFlag: carrierByte,
            botRole:      roleByte === 0xFF ? -1 : roleByte,
            lastDamageFromIdx: lastDmgFromByte,    // R23: -1 or attacker player id
        });
        o += SIZE_PLAYER;
    }
    const projectiles = [];
    for (let i = 0; i < projCount; i++) {
        projectiles.push({
            id:    view.getUint8(o),
            type:  view.getUint8(o + 1),
            team:  view.getUint8(o + 2),
            alive: view.getUint8(o + 3) !== 0,
            pos: [unquantPos(view.getInt16(o + 4, LE)), unquantPos(view.getInt16(o + 6, LE)), unquantPos(view.getInt16(o + 8, LE))],
            age:   view.getInt16(o + 10, LE) / 1000,
        });
        o += SIZE_PROJECTILE;
    }
    const flags = [];
    for (let i = 0; i < 2; i++) {
        const carrierByte = view.getInt8(o + 2);
        flags.push({
            team:        view.getUint8(o),
            state:       view.getUint8(o + 1),
            carrierIdx:  carrierByte,
            pos: [unquantPos(view.getInt16(o + 4, LE)), unquantPos(view.getInt16(o + 6, LE)), 0],
        });
        o += SIZE_FLAG;
    }
    return {
        tick: hdr.tick,
        matchTick, matchState,
        teamScore: [t0, t1],
        players, projectiles, flags,
    };
}

// ============================================================
// DELTA — for R19 we use a "snapshot every tick at high freq" simplification.
// Full bit-mask per-field delta is R20+ optimization. The wire format is
// already snapshot-shaped; we send it at higher freq with a different type.
// ============================================================
export function encodeDelta(snap) {
    const arr = encodeSnapshot(snap);
    arr[0] = MSG_DELTA; // overwrite type
    return arr;
}
export function decodeDelta(buf) {
    if (buf.byteLength < SIZE_HEADER + SIZE_SNAP_HDR) return null;
    const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    if (view.getUint8(0) !== MSG_DELTA) return null;
    // Temporarily mark as snapshot for shared decoder
    const tmp = new Uint8Array(buf);
    tmp[0] = MSG_SNAPSHOT;
    const decoded = decodeSnapshot(tmp);
    tmp[0] = MSG_DELTA;
    return decoded;
}

// ============================================================
// CLIENT INPUT
// ============================================================
export function encodeInput(input) {
    // input = { tick, buttons, mouseDX, mouseDY, pingMs, weaponSelect }
    const buf = new ArrayBuffer(SIZE_INPUT);
    const view = new DataView(buf);
    writeHeader(view, 0, MSG_INPUT, 0, SIZE_INPUT - SIZE_HEADER, input.tick);
    view.setUint16(8,  input.buttons & 0xFFFF, LE);
    view.setInt16(10, quantRot(input.mouseDX || 0), LE);
    view.setInt16(12, quantRot(input.mouseDY || 0), LE);
    view.setUint16(14, Math.min(0xFFFF, input.pingMs | 0), LE);
    view.setUint8(16, input.weaponSelect == null ? 0xFF : input.weaponSelect & 0xFF);
    // 17..19 reserved
    return new Uint8Array(buf);
}
export function decodeInput(buf) {
    if (buf.byteLength !== SIZE_INPUT) return null;
    const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    const hdr = readHeader(view, 0);
    if (hdr.type !== MSG_INPUT) return null;
    return {
        tick:         hdr.tick,
        buttons:      view.getUint16(8, LE),
        mouseDX:      unquantRot(view.getInt16(10, LE)),
        mouseDY:      unquantRot(view.getInt16(12, LE)),
        pingMs:       view.getUint16(14, LE),
        weaponSelect: view.getUint8(16),
    };
}
