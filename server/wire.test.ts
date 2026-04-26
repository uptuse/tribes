// ============================================================
// Wire format roundtrip test (R19 acceptance criterion 4)
// Run: bun test server/wire.test.ts  (or just `bun run server/wire.test.ts`)
//
// Validates that encodeSnapshot → decodeSnapshot reproduces an identical
// game-state object (within quantization tolerance).
// ============================================================

import { encodeSnapshot, decodeSnapshot, encodeInput, decodeInput, encodeDelta, decodeDelta } from './wire.ts';
import { MATCH_IN_PROGRESS } from './constants.ts';

let passed = 0, failed = 0;

function assertEq(label: string, expected: unknown, actual: unknown, tol = 0.05) {
    const ok = (typeof expected === 'number' && typeof actual === 'number')
        ? Math.abs(expected - actual) <= tol
        : JSON.stringify(expected) === JSON.stringify(actual);
    if (ok) { passed++; console.log('  ✓ ' + label); }
    else { failed++; console.log('  ✗ ' + label + ' expected=' + JSON.stringify(expected) + ' actual=' + JSON.stringify(actual)); }
}

console.log('--- snapshot roundtrip ---');
const snap = {
    tick: 12345,
    matchTick: 678,
    matchState: MATCH_IN_PROGRESS,
    teamScore: [3, 2] as [number, number],
    players: [
        { id: 0, alive: true, visible: true, jetting: false, skiing: true, firing: false,
          team: 0, armor: 1,
          pos: [12.34, 5.67, -89.01], rot: [0.123, -0.456, 0],
          vel: [3.5, -1.0, 8.5], health: 0.75, energy: 0.50,
          weaponIdx: 2, carryingFlag: -1, botRole: -1 },
        { id: 1, alive: true, visible: true, jetting: true, skiing: false, firing: true,
          team: 1, armor: 0,
          pos: [-100.5, 30.2, 45.8], rot: [-0.5, 1.2, 0],
          vel: [0, 5, 0], health: 1.0, energy: 0.20,
          weaponIdx: 1, carryingFlag: 0, botRole: 0 },
    ],
    projectiles: [
        { id: 7, type: 2, team: 0, alive: true, pos: [10, 5, 10], age: 1.5 },
    ],
    flags: [
        { team: 0, state: 0, carrierIdx: -1, pos: [-100, 30, -50] },
        { team: 1, state: 1, carrierIdx: 1, pos: [-100.5, 30.2, 45.8] },
    ],
};
const encoded = encodeSnapshot(snap);
console.log('  size: ' + encoded.byteLength + ' bytes (estimate per spec: ~664B for 8p+30proj)');
const decoded = decodeSnapshot(encoded);
if (!decoded) { failed++; console.log('  ✗ decodeSnapshot returned null'); }
else {
    assertEq('tick', snap.tick, decoded.tick);
    assertEq('matchState', snap.matchState, decoded.matchState);
    assertEq('teamScore', snap.teamScore, decoded.teamScore);
    assertEq('player count', snap.players.length, decoded.players.length);
    assertEq('player[0].id', 0, decoded.players[0].id);
    assertEq('player[0].alive', true, decoded.players[0].alive);
    assertEq('player[0].skiing', true, decoded.players[0].skiing);
    assertEq('player[0].pos.x', 12.34, decoded.players[0].pos[0]);
    assertEq('player[0].pos.y', 5.67, decoded.players[0].pos[1]);
    assertEq('player[0].pos.z', -89.01, decoded.players[0].pos[2]);
    assertEq('player[0].rot.pitch', 0.123, decoded.players[0].rot[0], 0.001);
    assertEq('player[0].health', 0.75, decoded.players[0].health, 0.01);
    assertEq('player[0].carryingFlag', -1, decoded.players[0].carryingFlag);
    assertEq('player[1].team', 1, decoded.players[1].team);
    assertEq('player[1].carryingFlag', 0, decoded.players[1].carryingFlag);
    assertEq('player[1].botRole', 0, decoded.players[1].botRole);
    assertEq('projectile count', 1, decoded.projectiles.length);
    assertEq('projectile[0].type', 2, decoded.projectiles[0].type);
    assertEq('flag[0].state', 0, decoded.flags[0].state);
    assertEq('flag[1].carrierIdx', 1, decoded.flags[1].carrierIdx);
}

console.log('--- input roundtrip ---');
const inp = { tick: 999, buttons: 0x05, mouseDX: 0.123, mouseDY: -0.456, pingMs: 47, weaponSelect: 3 };
const ie = encodeInput(inp);
const id = decodeInput(ie);
if (!id) { failed++; console.log('  ✗ decodeInput returned null'); }
else {
    assertEq('input.tick', inp.tick, id.tick);
    assertEq('input.buttons', inp.buttons, id.buttons);
    assertEq('input.mouseDX', inp.mouseDX, id.mouseDX, 0.001);
    assertEq('input.pingMs', inp.pingMs, id.pingMs);
    assertEq('input.weaponSelect', inp.weaponSelect, id.weaponSelect);
}

console.log('--- delta roundtrip ---');
const de = encodeDelta(snap);
const dd = decodeDelta(de);
if (!dd) { failed++; console.log('  ✗ decodeDelta returned null'); }
else {
    assertEq('delta.tick', snap.tick, dd.tick);
    assertEq('delta.matchState', snap.matchState, dd.matchState);
}

console.log('--- malformed input rejected ---');
const garbage = new Uint8Array(4);
assertEq('decodeSnapshot(garbage)=null', null, decodeSnapshot(garbage));
assertEq('decodeInput(garbage)=null', null, decodeInput(garbage));

console.log('\nResult: ' + passed + ' passed, ' + failed + ' failed');
if (failed > 0) process.exit(1);
