# Multiplayer Rewrite Plan — Internal Critique Pass

> Internal working doc. Distills four hostile reviews into a revised plan.
> Original plan: add `_setNetworked(int)` runtime flag in wasm_main.cpp, gate
> local clock/physics/bots/projectiles/scoring behind it, expose
> `_applyServerSnapshot` + `_applyServerMatchState`, wire from network.js.

## Persona reviews

### 1. The Netcode Engineer (Glenn Fiedler / Quake-3-snapshot mindset)
- "**Snapshot replacement of `players[localPlayer]` will feel like garbage.**
  At 20 Hz server tick over real-world Internet (40-200 ms RTT) the local
  player will rubber-band on every keystroke. You need client-side prediction
  + server reconciliation, not naive snapshot overwrite."
- "**Define the input frame number explicitly.** Client must tag each input
  with a monotonically increasing seq. Server echoes back the last applied
  seq in every snapshot. On reconciliation, client rolls back to that seq,
  re-applies all inputs > that seq, then renders. Without this you cannot
  do prediction at all."
- "**Snapshot interpolation for *other* players, prediction for *self*.**
  Don't try to predict other players from inputs you don't have. Buffer
  100 ms of remote-player snapshots and render at `now - 100 ms`."
- "**Don't gate `players[localPlayer]` physics behind `g_networked` — gate it
  behind 'is this snapshot newer than my prediction state?'.** The wasm
  should *always* run physics. The server snapshot is a correction signal,
  not a replacement signal."

### 2. The Game-Feel Designer
- "**Solo PLAY must remain bit-identical or your testing is worthless.**
  If `_setNetworked(0)` causes any jitter / different jet feel / changed
  spawn protection / different scoring, you can't tell whether a bug is a
  netcode bug or a regression. Every gated `if (!g_networked)` block is a
  potential regression site. Add a smoke-test scene that runs solo for 60 s
  and asserts position / score / clock against a recorded golden run."
- "**Match clock drift is OK; match clock *jump* is not.** If server says
  T=120s and wasm says T=119s, smooth into it over ~250 ms. Don't snap."

### 3. The Security / Anti-cheat Reviewer
- "**Server must never trust client-reported position.** Even with prediction,
  the server runs the authoritative physics step from inputs. Client
  positions in snapshots are *outputs*, not inputs. Otherwise prediction
  becomes a speedhack vector."
- "**The `_setNetworked` flag is a client toggle. A cheater flips it off
  and runs the local sim with god-mode tuning.** Mitigation: server
  doesn't care what flag the client set — server runs the same authoritative
  loop regardless. The flag only controls what the *renderer* shows. Make
  this invariant explicit in code comments and in the lobby's input handler."
- "**Anti-cheat skip-N-inputs after spawn (R32.299 band-aid) is a real
  exploit window.** If we keep that hack, an attacker spawns repeatedly to
  reset their input counter and bypass speed checks. Better fix: server
  *teleports* on spawn, then server's *own* `prevPos` becomes the spawn
  pos, so distance check naturally passes. Drop the skip-N hack."

### 4. The Project Manager / "Will-this-actually-ship" Reviewer
- "**3302 LoC of C++ + a 200-LoC `network.js` + a 251 KB `index.html` is
  too big to refactor in one shot.** You will get partway, break solo,
  and have nothing to ship. Slice it into 3 wasm rebuilds, each one
  independently shippable and reversible:
    - **Slice 1**: Add `_setNetworked` + `_applyServerMatchState` only.
      Gate **only the match clock + score**. Solo unchanged. Networked
      mode: clock/score are server-driven, but movement is still local
      (i.e. bug-for-bug like today on movement, but clocks now sync).
      Ship this. Verify clock sync with user.
    - **Slice 2**: Add `_applyServerSnapshot` for *remote* players only
      (interpolate, render at now-100ms). Local player still uses local
      physics. Ship. Verify other player visible & moving.
    - **Slice 3**: Add input-seq tagging + reconciliation for *local*
      player. Now genuine server-authoritative. Ship."
- "**The Fly free tier hibernates idle apps.** First connection after idle
  takes ~5–15 s for the Bun process to wake. The PREPARING BATTLEFIELD
  bar must show 'Server cold-starting…' during this, not stall at 90%.
  Otherwise users will think it's broken."
- "**Branch state is messy** — uncommitted .cpp/.wasm/.js changes already
  live in the working tree. Resolve those *before* starting the rewrite,
  or you'll lose track of what's spinfuser-fix vs what's network-rewrite.
  Commit the keep-pile, hard-revert the discard-pile, push, then start."

## Revised plan (slice-by-slice, smallest-first)

### Phase 0 — repo hygiene (do FIRST, before any C++ edit)
1. Audit `program/code/wasm_main.cpp` modifications — these are spinfuser
   commits' territory; the working-tree diff there is **part of the spinfuser
   branch's intent**, keep it.
2. Audit `tribes.wasm` / `tribes.js` modifications — these are the spinfuser
   rebuild outputs, keep them.
3. Audit `server/anticheat.ts` and `server/lobby.ts` mods — these are R32.299
   band-aids. Per the security reviewer, the anti-cheat skip-N-inputs is
   actually an exploit. **Discard** the anticheat.ts changes. Discard the
   lobby.ts matchSync/spawn-pos broadcast changes too — they will be
   re-implemented properly in Slice 1.
4. Keep all the new files: `Dockerfile`, `fly.toml`, `.dockerignore`,
   `RUNBOOK.md`, `build_local.sh`, `server/test_bot.ts`, `server/bun.lock`,
   `server/client/` symlink, `assets/sfx/`, `renderer_kenney_base.js`,
   `todo.md`, `MULTIPLAYER_REWRITE_PLAN.md` (this file).
5. `index.html` — keep the `__tribesOnMatchStart` second-handler that
   force-dismisses the prep overlay (it's a real fix). Discard nothing
   so far in index.html.
6. `client/constants.js` — `AC_MAX_INPUT_RATE_HZ` raised from 100 to 1000.
   Per anti-cheat reviewer, raising rate limits is fine if server runs
   the authoritative sim from those inputs. Keep.
7. `client/shell.js`, `renderer.js` — review then keep (probably static-asset
   fixes from earlier in session).
8. Commit kept files in two logical groups:
     a. `chore(deploy): Fly.io infrastructure (Dockerfile, fly.toml, RUNBOOK)`
     b. `chore(client): static-asset fixes for Fly serving`
9. Hard-revert anticheat.ts + lobby.ts to last committed state.
10. Fast-forward `master` to current branch, push.

### Phase 1 — Slice 1: server-driven match clock + score (smallest unit, highest user value)
**Goal:** when both browsers join the same lobby, match clock and team
scores tick from the same source. Movement still works exactly as today.

C changes (wasm_main.cpp):
- Add `static bool g_networked = false;`
- Add `extern "C" EMSCRIPTEN_KEEPALIVE void setNetworked(int on)`.
- Add `extern "C" EMSCRIPTEN_KEEPALIVE void applyServerMatchState(int state, double startedMs, int scoreLimit, int timeLimit, int teamScore0, int teamScore1)`. Sets `g_matchState`, `g_roundTimer = timeLimit - (now - startedMs)/1000`, `g_scoreLimit`, `teamScore[0/1]`.
- In the per-tick clock decrement block, wrap with `if (!g_networked)`.
- In the score-checking branch (which decides when match ends), wrap with `if (!g_networked)` so server alone can declare match end.
- Add `_setNetworked` and `_applyServerMatchState` to EXPORTED_FUNCTIONS in build.sh and to REQUIRED_EXPORTS check.

Server changes (server/lobby.ts):
- On matchStart broadcast, include `matchStartedMs: Date.now()`,
  `scoreLimit`, `timeLimit`. (Re-add this — it was in R32.299 band-aid,
  but now it goes through a real sink.)
- Every 1000 ms, broadcast `matchTick` with `{ matchState, matchStartedMs, scoreLimit, timeLimit, teamScore: [s0, s1] }`.
- On joinAck, if a match is in progress, send a `matchTick` immediately.

Client changes (network.js + index.html):
- On matchStart with `multiplayer` URL param, call
  `Module._setNetworked(1)`. (On solo, never called → flag stays 0.)
- On matchStart and on every matchTick, call
  `Module._applyServerMatchState(state, startedMs, scoreLimit, timeLimit, s0, s1)`.

Smoke test:
- Open http://localhost:8082/ → solo PLAY → verify clock counts down,
  bots fight, team can score and win at limit.
- Open two browsers at /?multiplayer=local&lobbyId=test → verify clocks
  on both browsers match within ±250 ms.

### Phase 2 — Slice 2: remote-player interpolation
**Goal:** each browser sees the other player at their server-reported
position (with ~100 ms delay buffer for smoothness).

C changes:
- Add `extern "C" EMSCRIPTEN_KEEPALIVE void applyRemotePlayerSnapshot(int playerId, float x, float y, float z, float yaw, float pitch, float vx, float vy, float vz, int health, double serverMs)`.
- Internally, push into a per-player ring buffer of (serverMs, pos, rot,
  vel). On render tick, look up `now - 100 ms`, lerp between buffered
  samples, write into `players[playerId]`.
- Wrap the local AI/physics for non-local players (and for bots in
  networked mode) with `if (!g_networked || playerId == localPlayer)`.

Server: snapshot (already exists in sim.ts) is broadcast to all peers
with serverMs. Client decodes, calls `_applyRemotePlayerSnapshot` per
non-local player.

Smoke test: two browsers, each can see the other player walking around.
Hosts shouldn't be teleported when guest joins (the host's *own* player
is still local-physics in this slice).

### Phase 3 — Slice 3: local-player prediction + reconciliation
**Goal:** local input is predicted instantly; server snapshots correct
small drift. No more rubber-banding.

C changes:
- Each input the wasm processes carries a monotonic `inputSeq`. Wasm
  exports `_getLastProcessedInputSeq()`.
- New export `_applyServerLocalCorrection(int lastAppliedSeq, float x, y, z, vx, vy, vz)`.
  Internally:
    - Save current `players[localPlayer]` state.
    - Roll back position to server's reported state.
    - Re-apply every queued input with seq > `lastAppliedSeq`.
    - Result is the new predicted state.
- Smooth visual position toward this corrected state over ~80 ms to
  avoid pop on small corrections.

Server: in input handler, after applying input N, store input seq N as
"last applied for player". Snapshot includes per-player last-applied seq.

Smoke test: two browsers, both can move. Latency-injection test (Chrome
DevTools throttle to 200ms) → no rubber-banding visible.

### Phase 4 — cold-start UX (low-effort, high payoff)
- network.js: when WebSocket fails to connect within 1500 ms, update the
  prep-overlay message to "Server warming up… (Fly.io free tier)" so
  users don't think it's broken.
- Once WebSocket opens, jump bar to 60%. On first matchTick, jump to 90%.
  On first remote snapshot OR first local input echoed back, jump to 100%
  and dismiss.

## Concrete decisions baked into the plan

1. **Slice 1 only** for this work session. Ship it. Get user signoff that
   clocks sync. Then Slice 2 in the next session.
2. Drop R32.299 anti-cheat skip-N-inputs hack entirely. The fix is server
   teleporting on spawn so server's own `prevPos` is correct.
3. Keep solo PLAY bit-identical: every gated block must be `if (!g_networked)`,
   never `if (something_else)`. Default `g_networked = false`. Solo never
   calls `_setNetworked`.
4. Use the existing branch `fix/spinfuser-rca-r32.279`, fast-forward
   master to it after Phase 0. No new branch.
5. All edits go in one repo, one binary, one deploy target.
