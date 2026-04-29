# Item 37 — Update lessons-learned.md with Audit Findings

**Status:** Complete
**Commit:** R32.220

## What was done
Added entries #15-#20 to lessons-learned.md covering all significant audit findings not already documented:

- **#15** Team color INDEX inversion between modules (SYS-03)
- **#16** Disabled rain/grass still allocates GPU resources unconditionally (REN-06)
- **#17** Six particle systems instead of one parameterized (C5)
- **#18** 82 window.* globals as inter-module communication (SYS-01)
- **#19** GPU memory leaks — no dispose() lifecycle (GPU-01/02/03/04)
- **#20** No test harnesses for audit fixes

Entries #6-#14 were already present from a prior session (night ambient typo, HDRI race, remote players hidden, tribes.js classification, dual-physics desync, telemetry offsets, flag Z dropped, network idempotency, ping measurement).

Total: 20 entries covering all significant audit findings.
