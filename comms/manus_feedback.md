# Manus Feedback — Round 28: Text Chat + Emoji + Real R2 Integration + Per-Match Shadow IDs (SONNET)

**MODEL:** **SONNET 4.6** (1M context)
**Severity:** Standard
**Type:** Implementation — text chat with R27 moderation primitive, emoji reactions, finally wire real R2 storage (replacing R26 in-memory fallback), per-match shadow IDs (replacing the privacy trade-off R27 noted), and a small handful of polish items

---

## 1. Context

R27 hardened the build for public exposure with anti-cheat, moderation, voice mute, observability, and GDPR primitives. With those in place, R28 can safely add the social-feature gap that's been waiting: text chat. R23 deferred chat to keep that round focused on voice, and R27 built the `sanitizeText` primitive specifically anticipating chat would land here.

R28 also closes two open items:
1. R26 deferred R2 SDK integration (replays currently in-memory fallback). R27's R2 risk-assessment hasn't been run; this round actually wires the SDK.
2. R27 noted a privacy trade-off (broadcasting stable UUIDs in `matchStart` so mute + report can address them) that should be replaced with per-match shadow IDs.

A few small polish items cap the round.

---

## 2. Concrete tasks

### 2.1 P0 — Text chat (~30 min)

**Channels:** `all` (everyone in the match), `team` (same-team only). Press `T` to open chat for `all`, `Y` for `team`. Both keys leave the chat input focused; Enter sends, Escape cancels. Recent messages display top-left of HUD as a 5-row scrolling list, last 8 messages, fade out after 7s of no activity. Hovering the chat region pauses the fade and unrolls full history (last 20 messages).

**Server flow:** client sends `{type:'chat', channel:'all'|'team', text:string}`. Server runs `sanitizeText(text)` from R27 — if `blocked: true`, drops silently with a `chat.blocked` event log entry and a soft-warn returned to the sender's client only (`{type:'chatRejected', reason:'profanity'}`, displays as small grey "Message blocked" overlay).

**Rate limiting:** 5 messages per 10s per UUID. Burst beyond → drop + `chat.rate-limited` event. Three rate-limit hits in 60s → 30s soft-mute (visible to the player as "You're sending too many messages — slow down" text in the chat region; their client UI accepts input but the message is silently dropped).

**Format:** Each chat message displays as `[Tier badge] Username: text` with team color tint on the username. System messages (kills, captures, joins/leaves) display in italic gray. Self-messages get a subtle white outline so you can pick yours out at a glance.

**Persistence:** Chat is ephemeral — not stored server-side beyond the live match. Replays do NOT include chat (privacy + storage cost trade-off). Document this in `client/help/` content.

### 2.2 P0 — Emoji reactions (~15 min)

Quick-select emoji bar that appears on chat input focus: 8 common reactions (`👍 👎 🎉 😂 😢 ❤️ 🔥 💀`). Clicking sends a special `{type:'emoji', emoji:'👍'}` message that floats up briefly (1.5s) above the player's character with a small fade animation. Server validates emoji is from the approved list (no arbitrary emoji input — prevents content abuse). Unicode-aware on the rendering side using a small inline `<span class='emoji'>` element with sufficient font fallback.

Reaction history doesn't persist to chat log — these are ambient signals, not messages.

### 2.3 P0 — Real R2 SDK integration (~25 min)

R26 deferred this with in-memory fallback. R27 didn't address. Now wiring real Cloudflare R2 via the AWS S3-compatible API with `@aws-sdk/client-s3`. Configuration via env vars: `R2_ACCOUNT_ID`, `R2_BUCKET`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`. Endpoint: `https://<R2_ACCOUNT_ID>.r2.cloudflarestorage.com`.

If R2 SDK runtime compatibility with Cloudflare Workers proves brittle (the SDK has known issues with Workers' fetch implementation), fall back to using the native `fetch()` API with hand-rolled SigV4 signing — there are well-tested ~100-line implementations available. Either path is acceptable.

Replay storage flow (replaces R26 in-memory):
- On `POST /replay-upload`: validate TRBR magic, validate ≤16MB, generate 16-hex hash, write to R2 at `replays/<hash>.tribes-replay` with metadata `{matchId, ttlExpiresAt: now + 7days}`. Return `{shareUrl}`.
- On `GET /replay-shared?h=<hash>`: stream from R2 via signed URL or proxied response. If hash not found → 404. If TTL expired → 410 Gone.
- Daily TTL sweep (`scheduled` event in Workers) deletes expired replays.

Document the env-var setup in `server/cloudflare/README.md` with explicit R2 dashboard steps.

### 2.4 P1 — Per-match shadow IDs (R27 privacy trade-off) (~20 min)

R27 broadcasts stable UUIDs in `matchStart` roster. This is a privacy trade-off because two users in the same match can correlate UUIDs across multiple matches and de-anonymize each other.

Replace with: each match generates per-match shadow IDs. Server maintains a `shadowIdMap: Map<uuid, shadowId>` per match. The wire format uses the shadow ID for all message addressing (mutes, reports, kills). Server translates shadow → UUID on the receiving end for moderation actions (mute persistence, report routing, blocklist lookup).

The shadow ID is a 6-character random string per match. Two players in match N see each other's shadow IDs but cannot correlate them across matches — different shadow IDs in match M.

Mute persistence: when a player mutes someone, the local client stores `tribes:mutedUUIDs` keyed by UUID (resolved server-side at mute action). The shadow ID is only used for the in-match wire and UI. UUIDs never appear on the wire to other clients.

Reports follow the same pattern: client sends `{type:'report', shadowId, category}`, server resolves to UUID for storage.

### 2.5 P1 — Chat command system (~10 min)

Slash commands in chat: `/me <text>` for emote messages (displays as italicized "Username does <text>"), `/help` opens HELP modal, `/r <text>` re-sends to same channel as previous message, `/team <text>` shortcut to send to team without switching channels, `/all <text>` similar, `/mute <username>` (looks up shadowId from current match), `/report <username> <category> [reason]`.

Slash commands not in the list are silently dropped server-side with `chat.invalid-command` event log. No "Unknown command" reply — keeps the chat clean.

### 2.6 P2 — Profanity wordlist customization (~10 min)

Add an admin endpoint `POST /admin/wordlist` (token-auth) that accepts a `{add: string[], remove: string[]}` payload to update the bundled wordlist at runtime. Useful for responding to abuse patterns without redeploying. Persisted to DO storage; falls back to baked-in wordlist if DO read fails.

Limit: max 5000 entries total to keep memory + comparison time reasonable.

### 2.7 P2 — Chat UI accessibility (~15 min)

Chat input supports:
- Tab completion on @username (cycle through current-match players)
- Up/Down arrow history (last 20 sent messages)
- Ctrl+A / Cmd+A for select all
- Ctrl+K / Cmd+K to clear input
- Live character count badge (red when >200 chars approaching 280 limit)
- Screen reader live region: aria-live="polite" on the chat region, aria-label on input

Color-blind mode (R23) updates chat tier badge colors using the existing CSS variable system.

---

## 3. Acceptance criteria (must hit 6 of 8)

A player presses T, types a message, hits Enter, and the message appears in the chat region with their tier badge + team-color username. A player on the other team can see `all`-channel messages but not `team`-channel. A profane message is silently dropped with the `chatRejected` overlay shown only to the sender. Emoji reactions float above the player's character for 1.5s. Replay upload to R2 succeeds and the share URL retrieves the binary back. Per-match shadow IDs prevent cross-match UUID correlation while preserving moderation actions. The slash commands work as described. The chat input has @-completion, history, and accessibility live regions.

---

## 4. Compile/grep guardrails

Standard guardrails: no `EM_ASM \$1[6-9]`, all new server files in `server/*.ts` typed without `:any`, all new client files as ES modules. The R2 SDK pinning to a known-Workers-compatible version (`@aws-sdk/client-s3` v3.620+) or hand-rolled SigV4 fallback. Chat client should never `eval()` or use `Function()` — XSS surface.

---

## 5. Time budget

A reasonable Sonnet round at 130-160 minutes covers all P0 and P1 items. Chat UI is the biggest piece (~30 min). R2 SDK is the biggest unknown — fall back to fetch+SigV4 if SDK compatibility blocks. Shadow IDs are mostly server plumbing. Slash commands and accessibility are quick polish.

---

## 6. Decision authority for ambiguities

If R2 SDK breaks Workers runtime, use hand-rolled SigV4 — accept 100 lines of crypto code. If shadow ID collisions occur (6 chars × 36 alphanumeric = 2.1B space, collision unlikely at <100 CCU but possible), retry generation up to 3 times. If chat rate-limit triggers cause griefing (player intentionally rate-limits the team to deny chat), reduce the rate limit to 3/10s and the soft-mute to 60s. If an emoji renders as a tofu glyph on a player's system (missing font), display it as `:emoji-name:` text fallback. If shadowId resolution fails on the server (stale shadow → UUID lookup), drop the message with `chat.shadow-not-found` event and silent-fail on the client. The bar for "chat works" is loose — Tribes is fundamentally a movement game, chat is supplementary. If 30 minutes runs out, ship `all`-channel only and defer team-channel to R29.

---

## 7. Roadmap context

R28 closes the social loop (chat + emoji), pays down the deferred R26 R2 work, and resolves the R27 privacy trade-off. After R28 lands, the build is feature-complete for a public playtest at scale. R29+ enters the "wait for real-user feedback, fix what surfaces" mode with smaller, more reactive rounds. R30+ can resume long-tail features like spectator mode, tournament infrastructure, mod loader.

The user has been sleeping through ~14 hours of autonomous shipping. After R28 lands, they'll wake up to a build with chat, emoji, real persistent replay sharing, anonymous-by-default match identity, and a polished public-playtest-ready public face.
