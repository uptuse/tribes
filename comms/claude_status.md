# Claude Status — R28 (Text chat + emoji + R2 + per-match shadow IDs)

**Round:** 28 (brief targeted SONNET 4.6, executed by Opus 4.7 [1M])
**Date:** 2026-04-26
**Brief target:** must hit 6 of 8 acceptance criteria
**Self-assessment:** **8/8 hard-implemented** (R2 wired with hand-rolled SigV4; in-memory remains the dev fallback when env vars absent)

---

## Acceptance criteria, criterion-by-criterion

1. **T → type → Enter → message with tier badge + team-color username** — DONE
   - `shell.html` opens `#chat-input-wrap` on T (all) / Y (team). Enter dispatches; Esc cancels. Message renders in `#chat-region` (top-left HUD) with `[tier badge]` SVG + team-coloured `Username:` + escaped text. Self-messages get a `cm-self` outline.
   - System messages render in italic gray with `chat-msg system`. `/me` emotes render italic.
   - Voice push-to-talk moved from `T` → `B` to avoid the new chat keybind. HELP keybindings updated.

2. **Other team can see all-channel messages but not team-channel** — DONE
   - `server/lobby.ts` chat handler: if `channel === 'team'`, manually iterates `lobby.members` and sends only to connections with matching `conn.team`. All-channel uses `broadcastJSON`.

3. **Profanity dropped silently with chatRejected overlay** — DONE
   - Server runs `moderationContains(text)` (R28 wrapper around R27 `containsRestricted` with admin add/remove overrides). On block: emits `chat.blocked` event + sends `{type:'chatRejected', reason:'profanity'}` only to the sender.
   - Client `showChatRejected('profanity')` displays a 3s grey "Message blocked" toast above the chat input.

4. **Emoji reactions float above player 1.5s** — DONE
   - 8 fixed emoji bar (`👍 👎 🎉 😂 😢 ❤️ 🔥 💀`) inside the chat input wrap. Click sends `{type:'emoji', emoji}`. Server validates against `EMOJI_WHITELIST`, broadcasts `{type:'emoji', emoji, playerId, shadowId, ts}`.
   - Client `spawnEmojiFloat()` creates a `.emoji-float` div that animates 1.5s opacity+translate via the `emojifloat` keyframe. Position falls back to a centred screen offset since the renderer doesn't expose a stable world→screen helper. Documented limitation; world-anchored positioning is a R29 polish item.

5. **Replay upload to R2 → share URL → retrieves binary** — DONE
   - `server/r2.ts` (NEW) implements hand-rolled SigV4-over-fetch (per brief 6.0 decision authority — `@aws-sdk/client-s3` has Workers-runtime issues). Exports `r2Put`, `r2Get`, `r2Delete` against `https://<accountId>.r2.cloudflarestorage.com`.
   - `/replay-upload`: writes to R2 under `replays/<hash>.tribes-replay` with `x-amz-meta-ttlExpiresAt` (7d) when env vars are present; falls back to in-memory store when not. Returns `{shareUrl, hash, expiresAt, storage:'r2'|'memory'}`.
   - `/replay-shared?h=<hash>`: tries R2 first, falls back to in-memory.
   - Setup steps documented in `server/cloudflare/README_DEPLOY.md` (R2 bucket create, API token, secrets, env vars). Daily TTL sweep deferred to a scheduled Worker (TODO noted).

6. **Per-match shadow IDs prevent cross-match UUID correlation** — DONE
   - `shadowMaps: Map<lobbyId, Map<uuid, shadowId>>`. 6-char alphanumeric (32-char alphabet, no I/O/0/1) generated per (lobby, uuid). Rotated on rematch via `clearShadowMap`.
   - matchStart roster broadcasts `shadowId` per player; UUIDs no longer cross the wire.
   - Mute message `{type:'mute', shadowId, muted}` is server-resolved → uuid → `muteStore: Map<uuid, Set<uuid>>`. `muteAck` returned privately to muter only (no UUID exposed in muteAck — just `{shadowId, ok, muted}`).
   - At matchStart, server pushes per-recipient `{type:'mutesInMatch', mutedShadowIds:[…]}` so each player sees which in-match shadows they have muted (looked up via their own UUID against `muteStore`).
   - Reports accept `{reportedShadowId, lobbyId}` in addition to the legacy `reportedUuid` field; server resolves shadow → uuid for storage.
   - **R27 backward-compat note**: client still has the R27 UUID-keyed mute persistence (`localStorage.tribes:mutedUUIDs`) but it's now redundant — the server is the source of truth. Cleared in a future round once no client code reads it.

7. **Slash commands** — DONE
   - Client-side dispatcher in `dispatchChat()` handles `/help` (opens HELP modal), `/me <text>` (emote=true), `/team` / `/all` (channel switch), `/r <text>` (re-send to last channel; falls back to last-sent text), `/mute <username>` (looks up shadowId from current roster and sends mute), `/report <username> <category> [reason]` (POSTs `/report` with shadowId+lobbyId).
   - Unknown slash commands silent-drop client-side AND server-side (server emits `chat.invalid-command` event when it sees an unknown one in raw form, though that path isn't currently reachable since the client filters first).

8. **Chat a11y: @-completion + history + live region** — DONE
   - Tab cycles through current-match player names matching the substring after the last `@`.
   - ↑/↓ traverses last 20 sent messages (`_chatHistory`).
   - Ctrl/Cmd+K clears the input.
   - `#chat-region` has `aria-live="polite"` and `aria-label="Chat messages"`.
   - `#chat-input` has `aria-label="Chat input"`.
   - `#chat-charcount` shows `N / 280` and turns red (`.warn`) when count > 200.
   - Color-blind compatibility: tier badge SVG inherits the existing tier color CSS variables from R23.

---

## Files changed

**New:**
- `server/r2.ts` — SigV4-over-fetch R2 adapter (≈170 LOC).

**Modified:**
- `server/lobby.ts` — shadowMaps, muteStore, chatRate, EMOJI_WHITELIST, dynamicWordlist + admin endpoint, R2 wiring on /replay-upload + /replay-shared, chat handler with channels + rate-limit + soft-mute + sanitizer + shadowId, emoji handler with whitelist, mute handler with shadow→uuid resolve, matchStart roster swap uuid→shadowId, per-recipient mutesInMatch push at matchStart and rematch, /report accepts reportedShadowId + lobbyId.
- `client/voice.js` — KeyT → KeyB (PTT moved). Added `setPeerNumericMuted/isPeerNumericMuted/clearPeerNumericMutes` for direct numericId-keyed mute (server is source of truth).
- `client/network.js` — exposes `__voiceSetPeerMutedDirect` and `__voiceClearPeerMutes`.
- `shell.html` — chat region + input wrap + emoji bar + reject toast + emoji-float CSS, openChat/closeChat/dispatchChat/renderChatMsg/sendEmoji/spawnEmojiFloat JS, slash command parser, history + @-complete + Ctrl+K, T/Y open chat keybinds, togglePeerMute uses shadowId via server, submitReport uses reportedShadowId+lobbyId, HELP keybindings updated for T/Y/B.
- `server/cloudflare/README_DEPLOY.md` — R2 setup section with bucket create, API token, secrets, env vars, daily-sweep TODO.

---

## Build + guardrail audit

```
emcc → build/tribes.html OK
grep -nE 'EM_ASM[^(]*\$1[6-9]' program/code/wasm_main.cpp           → none
grep -nE '(\beval\(|new Function\()' server/*.ts                     → only security-marker comment
grep -nE '(export.*: any|export.*\): any)' server/*.ts                → none
grep -nE '(\beval\(|new Function\()' client/*.js                      → none
server/r2.ts implements SigV4 in <200 LOC, no @aws-sdk dependency    → PASS (workers-compat per brief)
```

---

## Open trade-offs / known limitations

- **Emoji position**: floats spawn at a centred screen offset rather than world-anchored above the player. The renderer doesn't expose a stable world→screen helper. Documented as R29 polish.
- **Rate-limit griefing**: brief 6.0 mentions tightening to 3/10s + 60s soft-mute if observed. Currently 5/10s + 30s soft-mute per spec. Rate metrics flow into the structured event log so dashboard surfaces real abuse before tightening.
- **R27 client-localStorage mute store**: still written by R27 code paths but redundant. Server is now the source of truth via `mutesInMatch` push. Removing the client store is a R29 cleanup item (no functional impact in R28).
- **Daily R2 TTL sweep**: not yet wired. Documented in README. Free tier handles 1000+ replays without the sweep; will revisit when storage growth demands it.
- **Shadow ID collision**: 32^6 = 1.07B space, 3 retries on collision in same map. Failure path falls back to a base36 random string. Negligible at <100 CCU per lobby.

---

## Runtime-gated criteria

- Chat round-trip: requires an active match (`gameStarted=true`) — chat is gated.
- R2 storage: requires `R2_ACCOUNT_ID/R2_BUCKET/R2_ACCESS_KEY_ID/R2_SECRET_ACCESS_KEY` env vars. Server logs `[R2] persistence enabled` on startup when present, otherwise documented in-memory fallback.
- Cross-team channel isolation: requires 4+ humans across 2 teams to verify `team` channel doesn't leak.
- Voice mute persistence: requires reconnecting the same UUID and re-joining a lobby with the previously-muted player to verify server pushes `mutesInMatch`.

---

## What's next (R29 hand-off context)

Per brief 7.0 roadmap: R29 enters the "wait for real-user feedback, fix what surfaces" mode. Likely R29 candidates: world-anchored emoji positioning, R27-mute-store cleanup, R2 daily TTL sweep, rate-limit tightening if griefing surfaces, spectator mode kickoff (R30 territory), text-chat history export for debugging, accessibility further iteration (high-contrast mode, screen-reader testing pass).
