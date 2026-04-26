# Matchmaking Design (R24)

## Overview
Skill-based pairing using an ELO-lite rating per UUID, persisted server-side.
The goal is to keep first-time players away from veterans without overcomplicating
the rating math or requiring an external database.

## Rating
- Initial rating: 1000 (env var `SKILL_INITIAL`).
- K-factor: 32 for the first 20 matches, 16 thereafter (env constants `K_NEW`,
  `K_VETERAN`, `K_DECAY_THRESHOLD` in `server/skill.ts`).
- Expected outcome per team: standard ELO `1 / (1 + 10^((avgB-avgA)/400))`.
- Actual outcome: `teamScore / (teamScoreA + teamScoreB)`, bounded to `[0,1]`.
  A 5-0 sweep ≈ 1.0 (full win), 3-2 ≈ 0.6 (close win), 0-0 = 0.5 (draw).
- Per-player delta = `round(K * (actual - expected))`, applied uniformly to all
  members of the team (we deliberately do not weight by individual K/D — team
  outcome is the rated event).

## Safety rails
- A match is rated only if `durationS > 240` AND `humanCount >= 4`. The intent
  is to exclude bot-stuffed sandbox matches, ragequits, and warmup-only games.
- The lobby (`server/lobby.ts → endMatch`) is the sole caller of
  `computeRatingDeltas`, and it gates on `isRatedMatch()` before applying.

## Persistence
- Bun dev server: in-memory `skillStore: Map<uuid, SkillRow>`. Lost on restart.
- Cloudflare DO: `lobby_do.ts` writes `player_<uuid>` keys with
  `{rating, matchesPlayed, lastActiveMs}` after each match. DO storage is
  durable and per-region; the same UUID joining a different DO will start at
  default rating until we add a global registry (deferred to R26 ranked).
- The client persists its UUID in `localStorage.tribes_player_uuid` so the same
  player keeps their rating across reconnects.

## Cold-start lookup
- `joinAck` carries `skillRating` and `matchesPlayed` so the client can render
  them on the main menu the moment a connection is established.
- A new UUID gets a default `SkillRow` lazily on first lookup.

## Quick Match routing
- `GET /lobbies` includes `avgSkillRating` per lobby.
- The client picks the lobby with the smallest `|avgSkillRating - myRating|`,
  preferring those within 200 points; if no lobby is within range, it falls
  back to the most recently active lobby.
- For party Quick Match, the routing rating is the average of all party member
  ratings (computed client-side from `party.members` cache).

## Match-end broadcast
- `matchEnd.ratings` is a map from numeric playerId → `{rating, delta}`. The
  client looks up its own row and shows `+N` (green) or `-N` (red) on the
  main menu under the player name. The delta clears on the next match start.

## Anti-abuse
- Self-matched (single-human) lobbies don't update ratings (humanCount gate).
- Score-margin-based actual outcome means deliberate score-keeping doesn't
  inflate gains beyond `K * 0.5` per match.
- K-factor decay caps long-term volatility once a player has > 20 matches.

## Future work (not in R24)
- Global rating registry across DOs (needed for cross-region ranked play).
- Per-class rating splits (a Heavy main shouldn't penalize their Light play).
- Decay for inactive players (a 90-day inactive should drift back toward
  median to avoid stale top-of-leaderboard entries).
