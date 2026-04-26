// ============================================================
// tools/genmap.ts — R25 map builder (Bun)
//
// Produces the three R25 launch maps as `.tribes-map` JSON in
// client/maps/. Deterministic (seeded PRNG) so re-running yields
// identical bytes — keeps the published files in git diff-friendly.
//
// Usage:
//   bun run tools/genmap.ts [raindance|dangercrossing|iceridge|all]
// ============================================================

import { writeFileSync } from 'fs';
import { Buffer } from 'buffer';

// ------------------------------------------------------------
// Helpers
// ------------------------------------------------------------

function mulberry32(seed: number) {
    let t = seed >>> 0;
    return () => {
        t = (t + 0x6D2B79F5) >>> 0;
        let r = t;
        r = Math.imul(r ^ (r >>> 15), r | 1);
        r ^= r + Math.imul(r ^ (r >>> 7), r | 61);
        return ((r ^ (r >>> 14)) >>> 0) / 0x100000000;
    };
}

function makeNoise(size: number, seed: number, octaves: number, baseFreq: number, amp: number, bias = 0): Float32Array {
    const rng = mulberry32(seed);
    // Pre-compute random gradients for value-noise lookup
    const grid = 64;
    const grad = new Float32Array(grid * grid);
    for (let i = 0; i < grad.length; i++) grad[i] = rng() * 2 - 1;

    const sample = (x: number, y: number) => {
        const xi = Math.floor(x), yi = Math.floor(y);
        const fx = x - xi, fy = y - yi;
        const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
        const i00 = ((yi & (grid - 1)) * grid + (xi & (grid - 1)));
        const i10 = ((yi & (grid - 1)) * grid + ((xi + 1) & (grid - 1)));
        const i01 = (((yi + 1) & (grid - 1)) * grid + (xi & (grid - 1)));
        const i11 = (((yi + 1) & (grid - 1)) * grid + ((xi + 1) & (grid - 1)));
        const a = grad[i00] + sx * (grad[i10] - grad[i00]);
        const b = grad[i01] + sx * (grad[i11] - grad[i01]);
        return a + sy * (b - a);
    };

    const out = new Float32Array(size * size);
    for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
            let v = 0, freq = baseFreq, ampL = amp;
            for (let o = 0; o < octaves; o++) {
                v += sample(x * freq, y * freq) * ampL;
                freq *= 2.0;
                ampL *= 0.5;
            }
            out[y * size + x] = v + bias;
        }
    }
    return out;
}

function encodeHeightmapInt16(arr: Float32Array, quantStep: number): string {
    const buf = Buffer.alloc(arr.length * 2);
    for (let i = 0; i < arr.length; i++) {
        let q = Math.round(arr[i] / quantStep);
        if (q > 32767) q = 32767;
        if (q < -32768) q = -32768;
        buf.writeInt16LE(q, i * 2);
    }
    return buf.toString('base64');
}

interface Structure { type: number; pos: [number, number, number]; halfSize: [number, number, number]; color: [number, number, number]; rot?: number; }

interface MapDoc {
    schemaVersion: 1;
    id: string;
    name: string;
    author: string;
    maxPlayers: number;
    recommendedMix: { L: number; M: number; H: number };
    terrain: { size: number; worldScale: number; encoding: 'int16-base64'; quantStep: number; data: string };
    structures: Structure[];
    gameplay: {
        flags:    Array<{ team: 0 | 1; pos: [number, number, number] }>;
        spawns:   Array<{ team: 0 | 1; pos: [number, number, number] }>;
        stations: Array<{ team: 0 | 1; pos: [number, number, number] }>;
    };
    atmosphere: {
        skyTopColor: string; skyHorizColor: string;
        sunAngleDeg: number; sunAzimuthDeg: number;
        fogColor: string; fogDensity: number; ambient: number;
    };
}

// ------------------------------------------------------------
// Map definitions
// ------------------------------------------------------------

function buildRaindance(): MapDoc {
    const size = 256, worldScale = 8;
    const heightmap = makeNoise(size, 0xCAFE01, 5, 0.04, 18, 30); // medium hills, ~30m base
    return {
        schemaVersion: 1,
        id: 'raindance',
        name: 'Raindance',
        author: 'Dynamix (port)',
        maxPlayers: 16,
        recommendedMix: { L: 4, M: 4, H: 0 },
        terrain: { size, worldScale, encoding: 'int16-base64', quantStep: 0.1, data: encodeHeightmapInt16(heightmap, 0.1) },
        structures: [
            // Two team bases (interior + tower + station + 2 turrets + generator)
            // Team 0 base — south-west corner
            { type: 0, pos: [-110, 30, -50], halfSize: [10, 6, 8], color: [0.40, 0.38, 0.34] },     // interior
            { type: 1, pos: [-130, 35, -65], halfSize: [4, 18, 4],  color: [0.42, 0.40, 0.36] },     // tower
            { type: 2, pos: [-100, 30, -65], halfSize: [3, 4, 3],   color: [0.30, 0.30, 0.30] },     // generator
            { type: 3, pos: [-115, 38, -40], halfSize: [2, 2, 2],   color: [0.35, 0.35, 0.35] },     // turret
            { type: 3, pos: [-105, 38, -55], halfSize: [2, 2, 2],   color: [0.35, 0.35, 0.35] },     // turret
            { type: 4, pos: [-90, 30, -50],  halfSize: [3, 3, 3],   color: [0.40, 0.40, 0.40] },     // inv station
            // Team 1 base — north-east corner
            { type: 0, pos: [110, 30,  50],  halfSize: [10, 6, 8],  color: [0.40, 0.38, 0.34] },
            { type: 1, pos: [130, 35,  65],  halfSize: [4, 18, 4],  color: [0.42, 0.40, 0.36] },
            { type: 2, pos: [100, 30,  65],  halfSize: [3, 4, 3],   color: [0.30, 0.30, 0.30] },
            { type: 3, pos: [115, 38,  40],  halfSize: [2, 2, 2],   color: [0.35, 0.35, 0.35] },
            { type: 3, pos: [105, 38,  55],  halfSize: [2, 2, 2],   color: [0.35, 0.35, 0.35] },
            { type: 4, pos: [90, 30,  50],   halfSize: [3, 3, 3],   color: [0.40, 0.40, 0.40] },
        ],
        gameplay: {
            flags: [
                { team: 0, pos: [-100, 30, -50] },
                { team: 1, pos: [ 100, 30,  50] },
            ],
            spawns: [
                { team: 0, pos: [-95, 30, -45] },
                { team: 1, pos: [ 95, 30,  45] },
            ],
            stations: [
                { team: 0, pos: [-90, 30, -50] },
                { team: 1, pos: [ 90, 30,  50] },
            ],
        },
        atmosphere: {
            skyTopColor: '#9bb5d6', skyHorizColor: '#cfe0ee',
            sunAngleDeg: 55, sunAzimuthDeg: 200,
            fogColor: '#a8b8c8', fogDensity: 0.0008, ambient: 0.45,
        },
    };
}

function buildDangerCrossing(): MapDoc {
    const size = 256, worldScale = 5;     // smaller world (1280 m × 1280 m)
    const heightmap = makeNoise(size, 0xDA1467, 3, 0.06, 6, 20);  // shallower, choppy — arena feel
    return {
        schemaVersion: 1,
        id: 'dangercrossing',
        name: 'Danger Crossing',
        author: 'Tribes BE — procedural',
        maxPlayers: 8,
        recommendedMix: { L: 2, M: 4, H: 2 },
        terrain: { size, worldScale, encoding: 'int16-base64', quantStep: 0.1, data: encodeHeightmapInt16(heightmap, 0.1) },
        structures: [
            // Two compact bases facing across a central bridge area
            { type: 0, pos: [-50, 22, 0], halfSize: [6, 5, 6], color: [0.42, 0.35, 0.30] },
            { type: 1, pos: [-65, 28, 0], halfSize: [3, 14, 3], color: [0.45, 0.38, 0.32] },
            { type: 3, pos: [-55, 32, 10], halfSize: [2, 2, 2], color: [0.35, 0.30, 0.28] },
            { type: 4, pos: [-40, 22, 0],  halfSize: [3, 3, 3], color: [0.40, 0.35, 0.30] },
            { type: 0, pos: [ 50, 22, 0], halfSize: [6, 5, 6], color: [0.42, 0.35, 0.30] },
            { type: 1, pos: [ 65, 28, 0], halfSize: [3, 14, 3], color: [0.45, 0.38, 0.32] },
            { type: 3, pos: [ 55, 32, -10], halfSize: [2, 2, 2], color: [0.35, 0.30, 0.28] },
            { type: 4, pos: [ 40, 22, 0],  halfSize: [3, 3, 3], color: [0.40, 0.35, 0.30] },
            // Central crossings — two bridge slabs
            { type: 0, pos: [0, 18, -15], halfSize: [10, 0.5, 3], color: [0.50, 0.48, 0.45] },
            { type: 0, pos: [0, 18,  15], halfSize: [10, 0.5, 3], color: [0.50, 0.48, 0.45] },
        ],
        gameplay: {
            flags: [
                { team: 0, pos: [-45, 22, 0] },
                { team: 1, pos: [ 45, 22, 0] },
            ],
            spawns: [
                { team: 0, pos: [-50, 22, -5] },
                { team: 1, pos: [ 50, 22,  5] },
            ],
            stations: [
                { team: 0, pos: [-40, 22, 0] },
                { team: 1, pos: [ 40, 22, 0] },
            ],
        },
        atmosphere: {
            skyTopColor: '#b87850', skyHorizColor: '#e8c8a0',
            sunAngleDeg: 25, sunAzimuthDeg: 90,
            fogColor: '#d8b890', fogDensity: 0.0012, ambient: 0.55,
        },
    };
}

function buildIceRidge(): MapDoc {
    const size = 256, worldScale = 12;     // huge world (3072 m × 3072 m)
    const heightmap = makeNoise(size, 0x1CE111, 6, 0.025, 35, 40);  // rolling, ski-friendly
    return {
        schemaVersion: 1,
        id: 'iceridge',
        name: 'Ice Ridge',
        author: 'Tribes BE — procedural',
        maxPlayers: 32,
        recommendedMix: { L: 6, M: 6, H: 4 },
        terrain: { size, worldScale, encoding: 'int16-base64', quantStep: 0.1, data: encodeHeightmapInt16(heightmap, 0.1) },
        structures: [
            // Far-flung bases — encourage long ski transits
            { type: 0, pos: [-400, 50, -200], halfSize: [12, 7, 10], color: [0.85, 0.88, 0.92] },
            { type: 1, pos: [-430, 55, -220], halfSize: [4, 22, 4],  color: [0.88, 0.90, 0.94] },
            { type: 2, pos: [-380, 50, -220], halfSize: [3, 4, 3],   color: [0.55, 0.55, 0.60] },
            { type: 3, pos: [-410, 60, -180], halfSize: [2, 2, 2],   color: [0.60, 0.60, 0.65] },
            { type: 4, pos: [-370, 50, -200], halfSize: [3, 3, 3],   color: [0.75, 0.78, 0.82] },
            { type: 0, pos: [ 400, 50,  200], halfSize: [12, 7, 10], color: [0.85, 0.88, 0.92] },
            { type: 1, pos: [ 430, 55,  220], halfSize: [4, 22, 4],  color: [0.88, 0.90, 0.94] },
            { type: 2, pos: [ 380, 50,  220], halfSize: [3, 4, 3],   color: [0.55, 0.55, 0.60] },
            { type: 3, pos: [ 410, 60,  180], halfSize: [2, 2, 2],   color: [0.60, 0.60, 0.65] },
            { type: 4, pos: [ 370, 50,  200], halfSize: [3, 3, 3],   color: [0.75, 0.78, 0.82] },
        ],
        gameplay: {
            flags: [
                { team: 0, pos: [-390, 50, -200] },
                { team: 1, pos: [ 390, 50,  200] },
            ],
            spawns: [
                { team: 0, pos: [-380, 50, -195] },
                { team: 1, pos: [ 380, 50,  195] },
            ],
            stations: [
                { team: 0, pos: [-370, 50, -200] },
                { team: 1, pos: [ 370, 50,  200] },
            ],
        },
        atmosphere: {
            skyTopColor: '#d6e4f0', skyHorizColor: '#f5f8fb',
            sunAngleDeg: 35, sunAzimuthDeg: 145,
            fogColor: '#e8eef4', fogDensity: 0.0006, ambient: 0.60,
        },
    };
}

const BUILDERS: Record<string, () => MapDoc> = {
    raindance: buildRaindance,
    dangercrossing: buildDangerCrossing,
    iceridge: buildIceRidge,
};

function emit(name: string) {
    const builder = BUILDERS[name];
    if (!builder) throw new Error('unknown map: ' + name);
    const doc = builder();
    const path = `client/maps/${name}.tribes-map`;
    writeFileSync(path, JSON.stringify(doc));
    const sizeKB = (JSON.stringify(doc).length / 1024).toFixed(1);
    console.log(`[genmap] wrote ${path} (${sizeKB} KB, ${doc.structures.length} structures)`);
}

const target = process.argv[2] || 'all';
if (target === 'all') {
    for (const name of Object.keys(BUILDERS)) emit(name);
} else {
    emit(target);
}
