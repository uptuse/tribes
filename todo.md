# Tribes Multiplayer Rewrite — TODO

Plan doc: MULTIPLAYER_REWRITE_PLAN.md (critique pass + slice plan).

## Phase 0 — repo hygiene (in progress)
- [ ] Audit each modified file: keep vs discard
- [ ] Hard-revert server/anticheat.ts (R32.299 skip-N hack is an exploit)
- [ ] Hard-revert server/lobby.ts (R32.299 matchSync was a band-aid; will be redone properly in Slice 1)
- [ ] Commit kept changes in two groups: deploy infra; client static-asset fixes
- [ ] Push fix/spinfuser-rca-r32.279
- [ ] Fast-forward origin/master to fix/spinfuser-rca-r32.279

## Phase 1 — Slice 1: server-driven match clock + score
- [ ] wasm_main.cpp: add g_networked, setNetworked, applyServerMatchState
- [ ] wasm_main.cpp: gate clock decrement and match-end check behind !g_networked
- [ ] build.sh: export _setNetworked, _applyServerMatchState (+ REQUIRED_EXPORTS check)
- [ ] Rebuild wasm via emcc; verify solo PLAY clock still ticks
- [ ] lobby.ts: matchStart broadcast includes matchStartedMs/scoreLimit/timeLimit
- [ ] lobby.ts: 1Hz matchTick broadcast with full clock+score state
- [ ] lobby.ts: send matchTick on joinAck if match in progress
- [ ] network.js: on matchStart with multiplayer URL param, call _setNetworked(1)
- [ ] network.js: on matchStart and matchTick, call _applyServerMatchState
- [ ] Deploy to Fly; user-test: clocks sync between two browsers
- [ ] Verify solo PLAY still works

## Later slices (do NOT start until Slice 1 lands)
- [ ] Slice 2: remote-player snapshot interpolation
- [ ] Slice 3: local-player prediction + reconciliation
- [ ] Cold-start UX: prep overlay reflects real WebSocket state

---

# Old audit notes (R32.299 — superseded by rewrite plan above)

## Bugs reported by user

1. **Host clock != client clock** — match timer drifts between players
2. **Host rejoin restarts match clock** — clock should be server-authoritative; rejoining should snap you back into the match in progress
3. **Host teleports & freezes when 2nd player joins** — match-start spawn handling is broken; either a desync (client thinks pos=A, server says pos=B, snaps & freezes) or anti-cheat divergence (server kicks "inputRate" again under another name)
4. **PREPARING BATTLEFIELD last 10% takes forever** — bar is fake/poll-based and not tied to actual asset/scene-ready signal

## Audit checklist (server side)

- [ ] sim.ts: who owns `matchTime` / `matchClockSec` / `tickCount`? Is it broadcast in snapshots?
- [ ] sim.ts: spawn() — what positions are returned? Are spawn pads loaded from raindance.canonical.json?
- [ ] lobby.ts: maybeStartMatchIfReady — does it RESET or PRESERVE clock on rejoin?
- [ ] lobby.ts: reconnect handler — does it copy server position back to client, or accept client's stale pos?
- [ ] anticheat.ts: aimRate at tick=1 — initial mouseDX/Y from pointer-lock recenter is huge. Suppress for first N ticks after spawn.
- [ ] sim.ts: how is `matchStartedAt` set; how does server compute timeLeft?
- [ ] wire.ts: snapshot frame — does it include `matchTimeMs` / `matchTick`? Or does it rely on client's local clock?

## Audit checklist (client side)

- [ ] index.html: where does the timer rendering pull `matchTime` from? Local wasm? Or server snapshot?
- [ ] network.js: on `matchStart`, does the client RESET its local clock? Or sync to server-broadcast time?
- [ ] network.js: on reconnect, does it preserve match state or rebuild from scratch?
- [ ] renderer.js: PREPARING overlay dismiss — what signal triggers it? First snapshot? First frame? Asset count?
- [ ] index.html: prep-bar progress — what's the formula? Is it real or simulated?

## Fix plan (after audit)

- [ ] Server broadcasts `matchStartWallMs` in `matchStart` and every snapshot's header
- [ ] Client renders timer from `serverNow - matchStartWallMs - clockOffset`
- [ ] On reconnect, server replies with current matchState + matchStartWallMs + player's authoritative pos; client REPLACES local sim state from this
- [ ] Spawn — server is sole authority; client receives spawn pos in joinAck or first snapshot, teleports to it, then runs prediction from there
- [ ] Suppress aimRate for first 5 ticks after spawn (or skip first input frame's mouseDX/DY)
- [ ] Prep bar: tied to asset-load + first-snapshot-applied + first-render-frame events, with real progress numbers
