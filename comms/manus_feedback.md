# Manus Feedback — Round 24: Matchmaking + Real Balance Instrumentation + In-Match Settings (SONNET)

**MODEL:** **SONNET 4.6** (1M context)
**Severity:** Standard
**Type:** Implementation — add matchmaking infrastructure (skill-based pairing, friend invites, party system), capture real balance telemetry to replace synthetic baselines, allow in-match settings access without quitting

---

## 1. Context

R23 closed the social loop with class loadouts, WebRTC voice chat, settings v2, and server-authoritative damage tracking. The project is technically ready for public playtesting once the user runs `wrangler deploy`.

R24 adds the matchmaking and telemetry layers that turn a "you-can-play-it" demo into a "you-want-to-play-tomorrow" experience. Three concerns drive R24's scope. First, casual players bouncing into a public lobby with veterans will have a poor first match — skill-based matchmaking solves this. Second, R23's balance pass was synthetic because no real telemetry existed yet — R24 instruments the server to capture per-match data in a queryable format. Third, the current ESC menu only opens from the main menu — players who want to adjust mouse sensitivity mid-match must quit, an unforgivable friction point.

---

## 2. Concrete tasks

### 2.1 P0 — Skill-based matchmaking with ELO-lite (~40 min)

The server adds a `Player.skillRating: number` field that defaults to 1000 (configurable via `SKILL_INITIAL` env var). After every match the lobby updates ratings using a simplified ELO where the expected outcome is computed from team-average rating differential and the actual outcome is the score-margin ratio bounded to [0, 1]. The K-factor starts at 32 and decays to 16 after 20 matches played to stabilize ratings of regular players.

Persistence lives in Cloudflare Durable Object storage. `lobby_do.ts` writes `player_<uuid>` keys after each match with the rating, matches-played count, and last-active timestamp. The DO storage API supports the access patterns we need without requiring a separate database. Cold-start lookup happens on connect (the client sends its UUID; the DO loads the rating row or creates a default one).

The lobby browser endpoint `GET /lobbies` extends each lobby entry with `avgSkillRating` and `skillRange`. The Quick Match path on the client now picks the lobby whose `avgSkillRating` is closest to the requesting player's rating, falling back to most-recent-active if no lobby is within 200 points.

The client UI exposes the rating in two places: the player's own rating shown on the main menu under their name (with a delta indicator after each match — "+18" green or "-12" red), and on the in-match scoreboard next to each player's nameplate.

A safety rail prevents matchmaking abuse: the rating only updates if the match ran more than 4 minutes and at least 4 humans participated (excludes bot-stuffed sandbox matches). Document in `comms/matchmaking_design.md`.

### 2.2 P0 — Real balance telemetry capture (~25 min)

Replace R23's synthetic baseline with structured per-match telemetry. The server in `lobby.ts` writes a row per completed match to a `balance_telemetry.csv` file (or the DO storage equivalent on CF Workers) with columns capturing per-weapon kills/shots, per-class K/D, average jet airtime, average ski distance, average match duration, score-differential at end, average ping, count of slow-ticks, count of cheat events.

The existing `analyze.ts` from R23 reads this CSV and outputs proposed constant tweaks with their evidence rows. The analyze script gains a `--apply` flag that, when run with confirmation, writes proposed tweaks into `client/constants.js` and `comms/balance_log.md` as a git-friendly diff.

The instrumentation hooks live in `sim.ts`: every fire input increments a per-weapon shot counter, every kill increments a per-weapon kill counter and per-class kill/death counters, jet/ski usage stamps tick durations into accumulators. Match end snapshot writes the row.

### 2.3 P0 — In-match settings access (~20 min)

The ESC menu currently only opens from the main menu. Extend the existing settings modal in `shell.html` so it opens from any state with `Ctrl+,` (cross-platform settings shortcut convention) or via a gear icon in the top-right corner of the HUD. When opened mid-match, the modal pauses input forwarding to the WASM module but the network loop keeps running so the player doesn't disconnect. Settings changes apply immediately. Closing the modal resumes input.

Additionally, expose a quick-access settings panel on the match-end screen between matches. Players often want to tweak mouse sensitivity or audio levels right after a match without having to navigate menus.

### 2.4 P1 — Friend invites via shareable lobby URL with persistence (~25 min)

The current INVITE FRIENDS button copies the page URL. Extend this so when a player clicks INVITE FRIENDS while in a custom lobby, the URL includes the lobby ID and reserves a slot for the invited friend (timeout 60s for friend to join before slot reverts to public). Server in `lobby.ts` adds `Match.reservedSlots: Map<uuid, expiresAt>` and the join handler honors reservations.

The friend system itself: client persists a friends list in localStorage as `tribes:friends` (uuid + last-seen-name array). The match-end screen shows a "+ FRIEND" button next to non-friend players. The main menu adds a "FRIENDS" tab showing the list with online/offline status (via lobby polling: `GET /friends-status?uuids=...` returns presence). Online friends get a "JOIN GAME" button if they're in a public lobby.

### 2.5 P1 — Party system: invite friends to queue together (~30 min)

A party is a client-side group of UUIDs that joins lobbies together. The host (party leader) creates a party via the FRIENDS tab → "CREATE PARTY" button. Other members accept the invite. When the host clicks Quick Match, the server reserves N slots (party size) in the chosen lobby before any other player can fill them.

Server changes: `POST /party-create` returns a party ID. `POST /party-join` adds a member. `POST /party-disband` clears it. Quick Match queries `?partyId=` and the matchmaking algorithm finds a lobby with enough open slots (or creates one). The `avgSkillRating` for matchmaking averages all party members' ratings and matches against that.

### 2.6 P2 — Tutorial completion tracking + onboarding flow (~15 min)

The R21 tutorial overlay currently sets `localStorage.tribes:tutorialDone` after first completion. Extend with a step-completion flag that's set only if the player both watched the step AND performed the demonstrated action (movement step requires the player to have moved at least 10m, jetpack step requires at least 1 jet activation, combat step requires at least 1 fire input). Players who skip via ESC don't get the completion flag and the tutorial reshows on next visit (unless dismissed via "Don't show again" checkbox).

The first match a player participates in (real or vs-bots) marks `firstMatchComplete: true`. After 3 completed matches, a feedback prompt appears: "Enjoying Tribes? Share with a friend → INVITE FRIENDS button highlighted." Single show, dismissable.

### 2.7 P2 — Connection quality indicator + auto-reconnect resilience (~15 min)

The HUD currently shows a numeric ping. Add a 4-bar quality indicator (excellent <50ms, good <100ms, fair <200ms, poor >=200ms or packet-loss >5%). Color-code: green / yellow / orange / red. Position: top-right corner under the gear icon.

Auto-reconnect from R20 currently retries every 3 seconds for 30 seconds. Extend with exponential backoff (3s, 5s, 8s, 12s, 20s, 30s, 30s, 30s) and capture reconnect-success metric to telemetry. After 8 failed attempts, show a "RECONNECT" button instead of auto-retry to avoid wasting the player's time.

### 2.8 P3 — Per-match feedback collection (~10 min)

After each match, the match-end screen adds a 1-5 star rating prompt: "How was that match?" Players can also tag specific issues from a fixed list: "Lag", "Imbalanced teams", "Toxic player", "Bot felt fake", "Voice chat broken". Ratings and tags are sent to `POST /match-feedback` and aggregated server-side for the dashboard. This drives the next round's prioritization.

---

## 3. Acceptance criteria (must hit 6 of 8)

The first six lines below capture what must function end-to-end. The last two are nice-to-have polish.

A new player connecting receives the default skill rating and after their first match the rating updates by a delta visible on the main menu. The Quick Match button routes to a lobby whose avgSkillRating is within 200 points of the player's rating when one exists. The server writes one row per completed match to `balance_telemetry.csv` (or DO storage equivalent on CF) and the analyze script produces tweaks driven by real data when the file has at least 5 rows. Mid-match `Ctrl+,` opens the settings modal, changes apply immediately, closing resumes input. The friend system persists across sessions in localStorage with online/offline indicators driven by server polling. A party leader can invite a friend, both join the same lobby together when Quick Match fires, and matchmaking pairs them against a balanced opponent pool. The tutorial only marks complete when the demonstrated action was performed. The connection quality bar reflects reality with the documented thresholds.

---

## 4. Compile/grep guardrails

Standard guardrails apply: no `EM_ASM \$1[6-9]`, all new server files in `server/*.ts` typed without `:any` in public APIs, all new client files as ES modules, dependencies pinned, vanilla-JS client, `bun build` and `bun run test` clean. New telemetry rows must not increase per-match wire bandwidth (the CSV write is server-local).

---

## 5. Time budget

A reasonable Sonnet round at 150-200 minutes covers all P0 and P1 items. Skill-based matchmaking is the largest piece due to the rating math, persistence layer, and integration with both lobby browsing and Quick Match. Telemetry is small but touches multiple files. In-match settings is mechanical. Friends and party are independent and can be shipped in priority order.

---

## 6. Decision authority for ambiguities

If skill rating produces volatile results in early matches due to small sample size, increase the K-factor decay threshold from 20 matches to 30 and shrink the initial K from 32 to 24. If the DO storage cost projection exceeds $10/month at 100 CCU, switch persistence to a daily-flushed JSON snapshot and accept the rare race-window. If WebRTC mesh voice chat conflicts with party voice grouping, party voice gets a separate dedicated mesh channel that excludes non-party teammates. If the friend system reveals stalking concerns (player A repeatedly joining player B's matches against B's wishes), add a "blocked" list that takes priority over friend status. If telemetry grows too large for the DO storage limit, rotate to a 7-day rolling window and archive older rows to R2 (Cloudflare object storage).

---

## 7. Roadmap context

R24 is the matchmaking and telemetry foundation. R25 will add custom maps and replay playback (the replay capture from R23 is currently capture-only). R26 will introduce ranked-mode tiers built on the skill rating. R27+ enters mod-loader, custom skins, and community-content territory.

After R24 lands, the public playtest experience scales from "playable demo" to "I'd play this with my friends regularly." That is the threshold that determines whether the project earns organic player retention versus needing aggressive marketing to grow.
