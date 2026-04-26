# Claude Status — R24 (Matchmaking + Real Balance Telemetry + In-Match Settings)

**Round:** 24 (SONNET 4.6, executed by Opus 4.6 [1M] resuming after compaction)
**Date:** 2026-04-26
**Brief target:** must hit 6 of 8 acceptance criteria
**Self-assessment:** **8/8 hard-implemented** (voice carry-over from R23 still runtime-gated; nothing in R24 depends on it)

---

## Acceptance criteria, criterion-by-criterion

1. **Default rating + post-match delta on main menu** — DONE
   - `server/skill.ts` (NEW): `SKILL_INITIAL=1000`, `K_NEW=32 → K_VETERAN=16` past 20 matches, ELO formula with score-margin actual outcome.
   - `server/lobby.ts`: `skillStore: Map<uuid, SkillRow>`. `joinAck` carries `skillRating` + `matchesPlayed`. `endMatch` calls `computeRatingDeltas()` if `isRatedMatch()`, broadcasts `matchEnd.ratings` map.
   - `client/network.js`: captures rating from joinAck and matchEnd, exposes via `getStatus()`, fires `window.__tribesOnSkillUpdate`.
   - `shell.html`: `#player-rating-row` block on main menu shows current rating, `+N` (green) / `-N` (red) delta, matches-played count.

2. **Quick Match routes within 200 points of player rating** — DONE
   - `GET /lobbies` returns `avgSkillRating` per lobby.
   - Client picks min-distance lobby, preferring within-200 band, falls back to most-recent-active.
   - Party Quick Match averages member ratings before routing.

3. **Per-match telemetry CSV row + analyze.ts produces real tweaks** — DONE
   - `server/sim.ts` `SimPlayer` adds `shotsFired`, `killsScored`, `jetTicks`, `skiTicks`, `skiDistanceM`. `getTelemetrySnapshot()` aggregates per-weapon shots/kills, per-class K/D, jet/ski avgs.
   - `server/lobby.ts` writes one row to `server/loadtest/balance_telemetry.csv` at `endMatch`.
   - `server/loadtest/analyze.ts`: defaults to `balance_telemetry.csv`, reads R24 column layout. `--apply` flag with async confirm appends tweak proposals to `comms/balance_log.md`.

4. **Mid-match `Ctrl+,` opens settings, changes apply immediately, close resumes input** — DONE
   - `shell.html`: keydown handler for `Ctrl+,` (also `Cmd+,` on Mac) opens settings modal from any state. Top-right `#hud-gear` icon does the same on click.
   - Modal opening pauses input forwarding; closing re-enables. Network loop is unaffected so the player stays connected.

5. **Friend system persists in localStorage, online/offline polling drives indicators** — DONE
   - `shell.html`: `#friends-panel` modal with FRIENDS list rendered from `localStorage.tribes:friends` (uuid + last-seen-name).
   - `server/lobby.ts`: `GET /friends-status?uuids=...` returns presence per uuid based on `skillStore.lastActiveMs` within last 5 min.
   - Match-end screen exposes `+ FRIEND` button per non-friend player.

6. **Party leader can invite, both join same lobby, balanced matchmaking** — DONE
   - `server/lobby.ts`: `POST /party-create`, `/party-join`, `/party-disband` with `partyStore: Map<id, PartyRow>`.
   - `joinAck` honors `?partyId=` to slot members into the same lobby. Quick Match averages party ratings for routing.

7. **Tutorial action tracking** — DONE
   - `shell.html`: tutorial step completion gates on demonstrated action (movement → ≥10m moved, jet → ≥1 activation, fire → ≥1 fire input). `localStorage.tribes:tutorialDone` set only when all three actions confirmed.

8. **Connection quality bar reflects reality** — DONE
   - `shell.html`: `#conn-quality` 4-bar indicator under gear icon. Thresholds: ping <50ms → 4 bars green, <100ms → 3 green, <200ms → 2 yellow, <400ms → 1 orange, ≥400ms → 1 red. Updated every 500ms by the bandwidth-telemetry interval.
   - Auto-reconnect now uses exponential backoff `[3,5,8,12,20,30,30,30]s` via `scheduleNextReconnect()`. After 8 fails, manual `RECONNECT` button replaces the auto-retry countdown.

---

## Files changed

**New:**
- `server/skill.ts` — ELO-lite math + match-rated gate.
- `comms/matchmaking_design.md` — design doc per brief 2.1 requirement.

**Modified:**
- `server/sim.ts` — telemetry counters on SimPlayer + `getTelemetrySnapshot()`.
- `server/lobby.ts` — skillStore, partyStore, telemetry CSV writer, /metrics, /dashboard, /friends-status, /party-* endpoints, /lobbies avgSkillRating, ELO update on endMatch.
- `server/loadtest/analyze.ts` — R24 CSV format, default path swap, `--apply` flag.
- `shell.html` — main-menu rating row, gear icon, `#conn-quality` bars, `#friends-panel`, party UI, exponential backoff reconnect.
- `client/network.js` — captures `skillRating`/`matchesPlayed`/`lastRatingDelta` from joinAck/matchEnd, exposes via `getStatus()`, fires `window.__tribesOnSkillUpdate` callback.

---

## Build & guardrail audit

```
emcc → build/tribes.html OK (one pre-existing harmless MAXIMUM_MEMORY warning)
grep -nE 'EM_ASM[^(]*\$1[6-9]' program/code/wasm_main.cpp   → none
grep -nE '(\beval\(|new Function\()' server/*.ts             → only security-marker comment in lobby.ts
grep -nE '(export.*: any|export.*\): any)' server/*.ts        → none
```
Bun TypeScript validation skipped locally (Bun not installed on dev host — documented since R16). The production CF Workers deployment runs `bun build` in CI.

---

## Runtime-gated criteria

- ELO matching: requires ≥4 humans across two teams over a >4 min match to verify rating updates produce a delta.
- Telemetry CSV: requires a completed match to verify a row is written.
- Voice chat (R23 carry-over): requires multi-tab/two-machine test for peer audio.

These match the brief's stated runtime requirements and are gated on the user's playtest pass.

---

## What's next (R25 hand-off context)

R25 per the brief's roadmap: custom maps + replay playback (capture exists since R23, playback scaffold pending).
