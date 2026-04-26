// ============================================================
// Loadtest analyzer (R23) — reads loadtest_balance.csv and prints
// suggested balance tweaks based on observed weapon kill-rates,
// per-class K/D, and movement distribution.
//
// Expected CSV format (one row per kill or per-tick sample):
//   ts,event,playerId,classId,weapon,killerClass,victimClass,
//     kdScore,jetTimeS,skiDistanceM
//
// Usage:
//   bun run server/loadtest/analyze.ts --csv server/loadtest/loadtest_balance.csv
// ============================================================

interface Sample {
    weapon: string;
    classId: number;
    killerClass: number;
    victimClass: number;
    jetTimeS: number;
    skiDistanceM: number;
}

interface Tweak {
    constant: string;
    fromValue: number;
    toValue: number;
    reason: string;
    csvEvidence: string;
}

const WEAPON_NAMES = ['Blaster', 'Chaingun', 'Disc', 'Grenade', 'Plasma', 'Mortar'];
const CLASS_NAMES = ['Light', 'Medium', 'Heavy'];

function parseArgs() {
    const argv = process.argv.slice(2);
    const get = (k: string, def: string) => {
        const i = argv.indexOf('--' + k);
        return i >= 0 ? argv[i + 1] : def;
    };
    return { csv: get('csv', 'server/loadtest/loadtest_balance.csv') };
}

function loadCsv(path: string): Sample[] {
    let text = '';
    try {
        text = require('fs').readFileSync(path, 'utf8');
    } catch (e) {
        console.error('[analyze] cannot read', path, '-', (e as Error).message);
        return [];
    }
    const lines = text.trim().split('\n').slice(1); // skip header
    const samples: Sample[] = [];
    for (const line of lines) {
        const cols = line.split(',');
        if (cols.length < 10) continue;
        samples.push({
            weapon: cols[4],
            classId: Number(cols[3]),
            killerClass: Number(cols[5]),
            victimClass: Number(cols[6]),
            jetTimeS: Number(cols[8]),
            skiDistanceM: Number(cols[9]),
        });
    }
    return samples;
}

function analyze(samples: Sample[]): Tweak[] {
    const tweaks: Tweak[] = [];
    if (samples.length === 0) {
        console.log('[analyze] no samples — synthesizing default tweaks from R22 self-play observations');
        // R23 synthetic baseline: data not yet captured from real loadtest run.
        // Apply one conservative tweak based on commonly-reported imbalances.
        tweaks.push({
            constant: 'GROUND_FRICTION',
            fromValue: 0.85,
            toValue: 0.82,
            reason: 'R22 self-play: walking deceleration felt slightly too sticky vs original Tribes',
            csvEvidence: '(no CSV — synthetic baseline; rerun loadtest in R24 to validate)',
        });
        return tweaks;
    }

    // Per-weapon kill share
    const killCounts = new Map<string, number>();
    let totalKills = 0;
    for (const s of samples) {
        if (s.weapon) {
            killCounts.set(s.weapon, (killCounts.get(s.weapon) ?? 0) + 1);
            totalKills++;
        }
    }
    for (const [weapon, kills] of killCounts) {
        const share = kills / totalKills;
        if (weapon === 'Mortar' && share > 0.30) {
            tweaks.push({
                constant: 'WEAPONS[5].damage',
                fromValue: 1.0,
                toValue: 0.85,
                reason: `Mortar kill share ${(share * 100).toFixed(1)}% > 30%`,
                csvEvidence: `mortar kills: ${kills}/${totalKills}`,
            });
        }
        if (weapon === 'Chaingun' && share > 0.35) {
            tweaks.push({
                constant: 'WEAPONS[1].spread',
                fromValue: 0.05,
                toValue: 0.07,
                reason: `Chaingun kill share ${(share * 100).toFixed(1)}% > 35%`,
                csvEvidence: `chaingun kills: ${kills}/${totalKills}`,
            });
        }
    }

    // Per-class K/D
    const classKD = [0, 0, 0].map(() => ({ kills: 0, deaths: 0 }));
    for (const s of samples) {
        if (s.killerClass >= 0 && s.killerClass < 3) classKD[s.killerClass].kills++;
        if (s.victimClass >= 0 && s.victimClass < 3) classKD[s.victimClass].deaths++;
    }
    const ratios = classKD.map(c => c.kills / Math.max(1, c.deaths));
    const median = [...ratios].sort()[1];
    if (ratios[0] < median * 0.85) {
        tweaks.push({
            constant: 'CLASSES[0].maxDamage',
            fromValue: 0.66,
            toValue: 0.72,
            reason: `Light K/D ${ratios[0].toFixed(2)} < 0.85× class median ${median.toFixed(2)}`,
            csvEvidence: `light: ${classKD[0].kills}K/${classKD[0].deaths}D`,
        });
    }

    // Average jet/ski airtime
    const avgJet = samples.reduce((a, s) => a + s.jetTimeS, 0) / samples.length;
    const avgSki = samples.reduce((a, s) => a + s.skiDistanceM, 0) / samples.length;
    if (avgJet < 15 && avgJet > 0) {
        tweaks.push({
            constant: 'JET_ENERGY_DRAIN',
            fromValue: 1.0,
            toValue: 0.85,
            reason: `Avg jet airtime ${avgJet.toFixed(1)}s < 15s suggests over-punitive drain`,
            csvEvidence: `avgJetS: ${avgJet.toFixed(1)}`,
        });
    }
    if (avgSki < 200 && avgSki > 0) {
        tweaks.push({
            constant: 'SKI_FRICTION',
            fromValue: 0.005,
            toValue: 0.004,
            reason: `Avg ski distance ${avgSki.toFixed(0)}m < 200m suggests too sticky`,
            csvEvidence: `avgSkiM: ${avgSki.toFixed(0)}`,
        });
    }

    return tweaks;
}

function main() {
    const args = parseArgs();
    const samples = loadCsv(args.csv);
    console.log(`[analyze] loaded ${samples.length} samples from ${args.csv}`);
    const tweaks = analyze(samples);
    console.log(`[analyze] suggested ${tweaks.length} tweaks:`);
    for (const t of tweaks) {
        console.log(`  ${t.constant}: ${t.fromValue} → ${t.toValue}`);
        console.log(`    reason: ${t.reason}`);
        console.log(`    evidence: ${t.csvEvidence}`);
    }
    console.log('\n[analyze] applied tweaks should be documented in comms/balance_log.md');
}
main();
