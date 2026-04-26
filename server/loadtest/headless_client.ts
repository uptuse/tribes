// ============================================================
// Headless multiplayer client for load testing (R21).
// Connects to a server, joins a lobby, sends realistic 60Hz inputs.
// Logs ping p50/p95/p99 + bandwidth stats.
//
// Usage:
//   bun run server/loadtest/headless_client.ts \
//       --server wss://tribes-lobby.workers.dev/ws \
//       --lobby-id LOAD01 \
//       --duration 300 \
//       --client-id 0
// ============================================================

import { encodeInput } from '../wire.ts';
import { BTN_FORWARD, BTN_JUMP, INPUT_HZ } from '../constants.ts';

interface Args {
    server: string;
    lobbyId: string;
    durationSec: number;
    clientId: number;
    silent: boolean;
}

function parseArgs(): Args {
    const argv = process.argv.slice(2);
    const get = (k: string, def: string) => {
        const i = argv.indexOf('--' + k);
        return i >= 0 ? argv[i + 1] : def;
    };
    if (argv.includes('--help')) {
        console.log(`
Headless Tribes load test client (R21)

Flags:
  --server <wss://...>      Server WebSocket URL (default ws://localhost:8080/ws)
  --lobby-id <ID>           Lobby to join (default LOAD01)
  --duration <sec>          Test duration (default 60)
  --client-id <N>           Logical id for log prefix (default 0)
  --silent                  Suppress per-second output, print summary only
  --help                    This message
`);
        process.exit(0);
    }
    return {
        server: get('server', 'ws://localhost:8080/ws'),
        lobbyId: get('lobby-id', 'LOAD01'),
        durationSec: Number(get('duration', '60')),
        clientId: Number(get('client-id', '0')),
        silent: argv.includes('--silent'),
    };
}

interface Stats {
    pingsMs: number[];
    bytesIn: number;
    bytesOut: number;
    snapshotsRecv: number;
    deltasRecv: number;
    matchStarted: boolean;
    crashed: boolean;
}

async function runClient(args: Args): Promise<Stats> {
    const stats: Stats = {
        pingsMs: [],
        bytesIn: 0, bytesOut: 0,
        snapshotsRecv: 0, deltasRecv: 0,
        matchStarted: false,
        crashed: false,
    };
    const url = `${args.server}?lobbyId=${encodeURIComponent(args.lobbyId)}`;
    if (!args.silent) console.log(`[LT-${args.clientId}] connecting → ${url}`);
    const ws = new WebSocket(url);
    let nextTick = 0;
    let inputInterval: ReturnType<typeof setInterval> | null = null;
    let pingInterval: ReturnType<typeof setInterval> | null = null;

    return new Promise<Stats>((resolve) => {
        const tearDown = () => {
            if (inputInterval) clearInterval(inputInterval);
            if (pingInterval) clearInterval(pingInterval);
            try { ws.close(); } catch {}
            resolve(stats);
        };

        ws.binaryType = 'arraybuffer';
        ws.onopen = () => {
            if (!args.silent) console.log(`[LT-${args.clientId}] socket open`);
            // 60Hz input loop — mostly forward + occasional jump every ~3s
            inputInterval = setInterval(() => {
                let buttons = BTN_FORWARD;
                if (Math.random() < 0.005) buttons |= BTN_JUMP; // ~3s jump
                const input = {
                    tick: nextTick++,
                    buttons,
                    mouseDX: (Math.random() - 0.5) * 0.02, // small look jitter
                    mouseDY: 0,
                    pingMs: stats.pingsMs.length ? stats.pingsMs[stats.pingsMs.length - 1] : 0,
                    weaponSelect: 0xFF,
                };
                const buf = encodeInput(input);
                stats.bytesOut += buf.byteLength;
                try { ws.send(buf); } catch {}
            }, 1000 / INPUT_HZ);
            // Ping every 2s for clock-sync + RTT measurement
            pingInterval = setInterval(() => {
                const pingPayload = JSON.stringify({ type: 'ping', clientTs: Date.now() });
                stats.bytesOut += pingPayload.length;
                try { ws.send(pingPayload); } catch {}
            }, 2000);
        };

        ws.onmessage = (e: MessageEvent) => {
            const data = e.data;
            if (data instanceof ArrayBuffer) {
                stats.bytesIn += (data as ArrayBuffer).byteLength;
                const u8 = new Uint8Array(data);
                if (u8[0] === 1) stats.snapshotsRecv++;
                else if (u8[0] === 2) stats.deltasRecv++;
            } else if (typeof data === 'string') {
                stats.bytesIn += data.length;
                try {
                    const msg = JSON.parse(data);
                    if (msg.type === 'pong') stats.pingsMs.push(msg.serverTs - msg.clientTs);
                    if (msg.type === 'matchStart') stats.matchStarted = true;
                } catch {}
            }
        };

        ws.onerror = (e: Event) => {
            if (!args.silent) console.error(`[LT-${args.clientId}] socket error`);
            stats.crashed = true;
        };
        ws.onclose = () => {
            if (!args.silent) console.log(`[LT-${args.clientId}] socket closed`);
            tearDown();
        };

        setTimeout(() => {
            if (!args.silent) console.log(`[LT-${args.clientId}] duration expired`);
            tearDown();
        }, args.durationSec * 1000);
    });
}

function pct(arr: number[], p: number): number {
    if (!arr.length) return 0;
    const sorted = [...arr].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length * p)];
}

async function main() {
    const args = parseArgs();
    const stats = await runClient(args);
    const p50 = pct(stats.pingsMs, 0.5);
    const p95 = pct(stats.pingsMs, 0.95);
    const p99 = pct(stats.pingsMs, 0.99);
    const kbInPerSec = (stats.bytesIn / 1024 / args.durationSec).toFixed(2);
    const kbOutPerSec = (stats.bytesOut / 1024 / args.durationSec).toFixed(2);
    // CSV: clientId,duration,matchStarted,crashed,pingP50,pingP95,pingP99,kbInPerSec,kbOutPerSec,snapshots,deltas
    console.log(
        `${args.clientId},${args.durationSec},${stats.matchStarted ? 1 : 0},${stats.crashed ? 1 : 0},` +
        `${p50},${p95},${p99},${kbInPerSec},${kbOutPerSec},${stats.snapshotsRecv},${stats.deltasRecv}`
    );
}
main().catch(err => { console.error(err); process.exit(1); });
