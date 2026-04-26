# Manus Feedback — Round 27: Public Playtest Hardening + Content Moderation (SONNET)

**MODEL:** **SONNET 4.6** (1M context)
**Severity:** Standard
**Type:** Implementation — harden the build for public playtest exposure with anti-cheat improvements, content moderation primitives, observability deepening, and post-playtest survey instrumentation

---

## 1. Context

R17→R26 delivered a feature-complete multiplayer experience with classes, voice, custom maps, replays, ranked tiers, and a fully wired social layer. The build is technically ready to handle public exposure, but going public introduces categories of risk the synthetic playtest hasn't surfaced: account abuse (multiple accounts farming rating), text-channel abuse (slurs, harassment in usernames or chat), bot/cheat sophistication (more than the divergence anti-cheat catches), and operational blindness (not knowing what's actually happening in production).

R27 hardens these surfaces before public exposure. Expect smaller-scoped items than recent rounds — the work is mostly defensive and observability-focused rather than feature-additive.

---

## 2. Concrete tasks

### 2.1 P0 — Anti-cheat: speed/jet-energy server-side validation (~25 min)

The R20 divergence anti-cheat catches gross client-server position drift but doesn't catch sophisticated cheats that respect the server's authoritative position while abusing client-side reported velocity. Add server-side velocity bounds checking in `sim.ts`: max horizontal velocity 60 m/s (sustained ski, downhill), max vertical jet velocity +20 m/s, max jet energy consumption rate matches class regen rate. If a player's reported velocity exceeds bounds for >3 consecutive ticks, log a warning to telemetry with the player UUID and clamp the velocity server-side.

Three strikes within 60 seconds = soft-kick (close 4003 with reason "speed-validation-failed"). The kick is logged to a server-only audit file `comms/audit_log.jsonl` with timestamp + UUID + violation details. UUIDs accumulating ≥5 kicks in 7 days are added to a `BLOCKED_UUIDS` server set with daily review surfacing in `/dashboard`.

### 2.2 P0 — Username & chat moderation (~20 min)

Profanity-filter username on creation. Use a small bundled wordlist (the standard `naughty-words` or equivalent, ~1500 entries) plus l33t-speak normalization. Block username creation that matches; show "Username contains restricted content" with no further detail. The wordlist file ships in `client/moderation.js` and runs both client-side (UX feedback before submission) and server-side (definitive enforcement).

For text chat (R23 didn't include chat — chat is the next logical add but defer to R28), the moderation primitive should be ready to drop in. Add `client/moderation.js` `sanitizeText(text): {clean, blocked: boolean}` exporting both functions.

Reporting: Add a "REPORT PLAYER" button on right-click of a player's nameplate (or via the scoreboard's three-dot menu). Submitting a report sends `POST /report` with the reporter's UUID, the reported UUID, the offense category (cheating, harassment, slurs, voice-abuse, other), and an optional 200-char description. Reports accumulate in DO storage; the `/dashboard` shows top 10 reported UUIDs with action buttons (warn / kick / blocklist 7d).

### 2.3 P0 — Voice-chat moderation: mute UI (~15 min)

R23 shipped WebRTC mesh voice chat without moderation surfaces. Add a per-player mute control: each remote player's nameplate gets a small voice icon when they speak, and clicking it toggles mute for that player on the local client only (sets the audio gain to 0). Muted state persists in `tribes:mutedUUIDs` localStorage so the player stays muted across sessions.

Bulk action: settings has a "MUTE ALL" toggle that mutes all incoming voice (default off). Server reporting integrates: clicking "REPORT PLAYER" with category "voice-abuse" auto-mutes that player.

### 2.4 P1 — Observability: structured event log (~25 min)

Extend the existing `/metrics` endpoint with structured event logs. Define a small set of events: `match.started`, `match.ended`, `player.connected`, `player.disconnected`, `player.kicked`, `player.reported`, `cheat.detected`, `error.5xx`. Each event has a JSON payload with relevant fields (UUIDs, match ID, timestamp, error message).

Endpoint `GET /events?since=<timestamp>&type=<event>&limit=100` (token-auth gated like /dashboard) returns recent events filtered by type. The `/dashboard` adds a tail-events panel showing the last 50 events live (poll every 5s). Filter dropdown for event type.

This unblocks debugging real production issues — a player reports "lost connection mid-match," you check the dashboard for that match ID's events and see "player.disconnected reason=ws-close-1006" with the timestamp, and triangulate from there.

### 2.5 P1 — Auto-restart server on crash (~15 min)

The Cloudflare Workers Durable Object should auto-recover on crash, but verify and document the behavior. Add a top-level try-catch in the main lobby tick loop in `lobby.ts` that catches any uncaught exception, logs `error.5xx` event, persists the current match state to DO storage, and restarts the tick loop after a 100ms cooldown. Players experience a brief stall but stay connected.

For local development (Bun server), add a basic process supervisor: `server/run.sh` starts the server, monitors for crashes, restarts within 5 seconds with exponential backoff capping at 60s. Crashes are logged to `server/crashlog.txt` with timestamp + stack trace + last 100 events from the structured log.

### 2.6 P1 — Post-match survey + sentiment tracking (~15 min)

R24's per-match feedback (1-5 stars + tag list) is a good foundation. Extend with a trailing question after the rating: "What's the one thing you'd change about Tribes?" — free-text 280 chars, optional submit. Aggregated sentiment lives in DO storage with a daily summary at `/dashboard`: total responses, average rating, top 5 most-cited issues from the tag list, sample of free-text submissions (first 20 chars + ellipsis to preserve writer privacy in the dashboard view, full text only via a "VIEW FULL" gate that requires admin token).

This is the highest-leverage instrument we can add — it captures what players actually care about, not what we think they should care about.

### 2.7 P2 — GDPR-lite: data export + delete (~15 min)

Add `/account/export?uuid=<uuid>&token=<oneTimeToken>` returning a JSON dump of all stored data for that UUID (skill rating, match history, reports made, reports received, mute list, friends list). The token is a 32-char random string emailed... wait, no email — instead, the token is generated client-side and only works if presented by the same UUID it's claiming, with a 5-minute expiry, fired via the in-game settings "EXPORT MY DATA" button.

`POST /account/delete?uuid=<uuid>&token=<oneTimeToken>` removes all stored data for that UUID after a 7-day grace period. Settings adds "DELETE MY ACCOUNT" with a confirmation modal. After 7 days the player's data is purged; if they reconnect within 7 days the delete is auto-cancelled.

### 2.8 P2 — Help & support page (~15 min)

The main menu adds a "HELP" tab (next to PROFILE from R26). Static page with: keybindings reference, troubleshooting (mic permission denied → instructions, low FPS → suggest graphics tier change, lag → check ping, crashes → link to support discord), report-a-bug button (opens a templated email to `tribes-bugs@<your-domain>` or a GitHub issue link if you've created one), credits, fan-project disclaimer.

The static content lives in `client/help/` as Markdown files compiled to HTML at build time, or just inline in `shell.html`. Either approach acceptable.

---

## 3. Acceptance criteria (must hit 6 of 8)

The first six lines below capture what must function end-to-end. The last two are nice-to-have polish.

A player reporting unrealistic velocity (>60 m/s sustained for >3 ticks) gets server-clamped and after 3 violations in 60s, soft-kicked with audit log entry. Profanity in usernames is blocked at creation time both client and server-side. Right-click on a player's nameplate opens a report menu and selecting a category sends a `/report` request that appears in the dashboard. Voice mute persists across sessions and the auto-mute on report-voice-abuse works. The `/events` endpoint returns recent events with filter support, and the dashboard tail panel updates every 5s. The post-match survey collects free-text feedback and the daily summary appears on the dashboard. The GDPR export and delete flows work end-to-end. The HELP page covers all listed sections.

---

## 4. Compile/grep guardrails

Standard guardrails: no `EM_ASM \$1[6-9]`, all new server files in `server/*.ts` typed without `:any`, all new client files as ES modules, dependencies pinned. The bundled profanity wordlist must be UTF-8 and ≤50KB compressed. Server-side moderation must run before client-side feedback (defense-in-depth: never trust client feedback as authoritative).

---

## 5. Time budget

A reasonable Sonnet round at 130-160 minutes covers all P0 and P1 items. P0 anti-cheat + moderation are mechanical; observability is mostly endpoint plumbing; auto-restart is small. P2 items are independent and ship if budget allows. The post-match survey free-text is the highest user-impact small item — prioritize over stretch P2.

---

## 6. Decision authority for ambiguities

If the bundled profanity wordlist licensing is unclear (most are MIT or CC), pick the MIT-licensed list (commonly `bad-words` or `naughty-words`) and document the source in `client/moderation.js` header. If the velocity bounds prove too tight in legitimate gameplay (Tribes ski + downhill can hit 80+ m/s), bump max horizontal to 80 m/s and add a graduated warning system: 60-80 = log only, 80-100 = warn, >100 = clamp. If GDPR delete grace-period reverts cause race conditions with active matches, just hard-delete after 7 days and note in policy that 7 days is the window for cancellation. If the dashboard's tail-events panel causes performance issues (poll-rate too high), drop poll rate to 30s with a manual refresh button. If `/report` is abused (e.g., a single UUID report-spamming), rate-limit to 10 reports per UUID per day with a soft block after.

---

## 7. Roadmap context

R27 is the safety + observability layer for going public. R28 will add text chat + emoji + chat moderation reading from the R27 sanitizer primitive. R29 will iterate on what the public playtest reveals — bug fixes, balance, performance issues. R30 enters mod-loader / Steam Workshop-style content sharing.

After R27 lands, you can confidently share the URL widely without worrying that the first abusive player crashes the experience for everyone else. That's the threshold to actually start marketing the project.
