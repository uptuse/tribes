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
    return {
        csv: get('csv', 'server/loadtest/balance_telemetry.csv'),  // R24: real telemetry path
        apply: argv.includes('--apply'),
    };
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
    // R24: balance_telemetry.csv has header:
    //   matchId,durationS,humanCount,scoreA,scoreB,
    //   blasterShots,blasterKills,chainShots,chainKills,discShots,discKills,
    //   grenShots,grenKills,plasmaShots,plasmaKills,mortarShots,mortarKills,
    //   lightK,lightD,medK,medD,heavyK,heavyD,
    //   avgJetS,avgSkiS,avgSkiM
    const WEAPON_COLS = [
        { name: 'Blaster', idx: 6 }, { name: 'Chaingun', idx: 8 }, { name: 'Disc', idx: 10 },
        { name: 'Grenade', idx: 12 }, { name: 'Plasma', idx: 14 }, { name: 'Mortar', idx: 16 },
    ];
    for (const line of lines) {
        const cols = line.split(',');
        if (cols.length < 26) continue;
        // Emit per-weapon-kill samples for kill-share aggregation
        for (const w of WEAPON_COLS) {
            const kills = Number(cols[w.idx + 1]) || 0;
            for (let k = 0; k < kills; k++) {
                samples.push({
                    weapon: w.name,
                    classId: -1, killerClass: -1, victimClass: -1,
                    jetTimeS: Number(cols[23]) || 0,
                    skiDistanceM: Number(cols[25]) || 0,
                });
            }
        }
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

async function main() {
    const args = parseArgs();
    const samples = loadCsv(args.csv);
    console.log(`[analyze] loaded ${samples.length} samples from ${args.csv}`);
    if (samples.length > 0 && samples.length < 5) {
        console.log('[analyze] WARNING: <5 samples — tweaks may be noisy. Recommend 50+ matches before applying.');
    }
    const tweaks = analyze(samples);
    console.log(`[analyze] suggested ${tweaks.length} tweaks:`);
    for (const t of tweaks) {
        console.log(`  ${t.constant}: ${t.fromValue} → ${t.toValue}`);
        console.log(`    reason: ${t.reason}`);
        console.log(`    evidence: ${t.csvEvidence}`);
    }
    if (args.apply) {
        const ok = await confirm('Apply these tweaks to comms/balance_log.md? (y/N) ');
        if (!ok) { console.log('[analyze] not applied.'); return; }
        const fs = require('fs');
        let logContent = '';
        try { logContent = fs.readFileSync('comms/balance_log.md', 'utf8'); } catch {}
        const date = new Date().toISOString().slice(0, 10);
        let newEntries = `\n\n## ${date} — analyze.ts auto-apply\n\n`;
        for (const t of tweaks) {
            newEntries += `### ${t.constant}: ${t.fromValue} → ${t.toValue}\n\n**Reason:** ${t.reason}\n\n**Evidence:** ${t.csvEvidence}\n\n`;
        }
        try {
            fs.writeFileSync('comms/balance_log.md', logContent + newEntries);
            console.log('[analyze] appended tweaks to comms/balance_log.md');
            console.log('[analyze] NOTE: actual constants.js edits require human review (per-tweak grep + edit).');
        } catch (e) { console.error('[analyze] write failed:', e); }
    } else {
        console.log('\n[analyze] re-run with --apply to write tweak proposals to comms/balance_log.md');
    }
}

// Bun doesn't have global confirm(); polyfill via stdin
async function confirm(prompt: string): Promise<boolean> {
    process.stdout.write(prompt);
    return new Promise(res => {
        process.stdin.once('data', d => res(d.toString().trim().toLowerCase().startsWith('y')));
    });
}

main().catch(e => { console.error(e); process.exit(1); });
