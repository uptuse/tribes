# Manus Play-Test Log

Bugs and improvements observed during autonomous play-testing. Each entry: timestamp, build commit, severity, finding, proposed fix, target round.

Severity: **P0** = unplayable / crash; **P1** = major UX/gameplay break; **P2** = polish; **P3** = nitpick.

---

## 2026-04-25 22:57 EDT — build `9763953`

| # | Sev | Finding | Proposed fix | Target |
|---|-----|---------|---------|--------|
| 1 | P2 | "QUICK START" button on main menu routes to the *same* multi-step Game Setup screen as "PLAY GAME". There is no actual quick-start (deploy with defaults) path. | "QUICK START" should bypass setup and call `setGameSettings(team=0, armor=0, mode=ctf, size=4, scoreLimit=5, timeLimit=600)` directly, then enter match. ~10-line JS edit to `index.html`. | R14.x polish or fold into R15 brief |

