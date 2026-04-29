# Item 55 — Establish Code Deletion Ritual

**Status:** Complete
**Commit:** R32.223

## What was done
Created `docs/code-deletion.md` establishing:

- **@disabled marker convention:** `// @disabled YYYY-MM-DD tag: reason` for any disabled feature
- **30-day rule:** Code with @disabled markers older than 30 days gets archived to a branch and deleted from main
- **Enforcement:** Single grep command for any session to check; session checklist
- **Immediate candidates:** Rain, grass ring, dust, cohesion, jet exhaust (from audit findings)
- **Philosophy section:** Why dead code is actively harmful (AI context waste, GPU allocation bugs, developer confusion)

Aligns with Gate 8 ("play with it off — if you don't miss it, it doesn't ship") and directly addresses audit findings REN-05, REN-06.
