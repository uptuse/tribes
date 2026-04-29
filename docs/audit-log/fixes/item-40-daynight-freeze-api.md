# Item 40 — DayNight freeze/unfreeze API Bug

## Pass 1: Correctness
- **Bug**: `freeze(hour)` sets `_frozen01` but `update()` only checks it inside the `_cycleSeconds === Infinity` branch (URL `?daynight=off`). Runtime calls to `freeze()` were silently ignored — the wall-clock time always overwrote the frozen value.
- **Fix**: Added a second guard after the `Infinity` check: `if (_frozen01 !== null) { _apply(_frozen01); return; }`. Now `freeze(hour)` works at runtime regardless of cycle speed.
- **Verified**: `unfreeze()` sets `_frozen01 = null`, which resumes wall-clock computation on next frame. No behavioral change for existing URL-param frozen mode.

## Pass 4: Regression Risk
- **Risk**: LOW. The only changed code path is the `update()` function. The new guard is a strict superset of the old behavior — if `_frozen01` is null (the default), it falls through to the existing wall-clock path.
- **Edge case**: If someone calls `freeze()` then `unfreeze()` rapidly, the system resumes from the current wall clock (not from the frozen hour). This is correct — the cycle is continuous.

## Commit
`fab500d` — `fix(R32.201): fix DayNight freeze/unfreeze API — honor runtime freeze(hour)`
