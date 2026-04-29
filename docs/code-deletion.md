# Code Deletion Ritual

> Dead code is a liability. It confuses new sessions, bloats the codebase, and hides real bugs behind noise. This document establishes the process for managing disabled features and removing dead code.

---

## The @disabled Marker Convention

When disabling a feature (instead of deleting it), mark it with a structured comment:

```javascript
// @disabled 2025-05-01 rain-system: allocates GPU buffers unconditionally; needs lazy-init refactor
```

**Format:** `// @disabled YYYY-MM-DD tag: reason`

- **YYYY-MM-DD** — the date the code was disabled
- **tag** — short kebab-case identifier for the feature
- **reason** — why it was disabled, what needs to happen before it could be re-enabled

### Where to Place Markers

- At the **top of the disabled function** (not inline in the middle)
- At the **call site** where the init/update was commented out
- Both locations if they're in different files

### Examples

```javascript
// @disabled 2025-05-01 grass-ring: allocates 213MB GPU; needs quality-tier gate
function initGrassRing() { ... }

// @disabled 2025-05-01 rain-particles: unconditional allocation; needs lazy-init
// initRain();  // was called from start()
```

---

## The 30-Day Rule

Any code with an `@disabled` marker **older than 30 days** gets archived and deleted from main:

1. **Grep for markers:** `grep -rn '@disabled' --include='*.js' --include='*.html'`
2. **Check dates:** Any marker with a date > 30 days old is a candidate
3. **Archive to branch:** `git checkout -b archive/feature-name`, commit the current state, push the branch
4. **Delete from main:** Remove the disabled code, remove the markers, commit
5. **Document:** Add a note to the audit log: "Archived {feature} to branch archive/{feature-name}"

### Why 30 Days?

- Short enough that dead code doesn't accumulate
- Long enough that a disabled feature can be tested and decided on
- If it's been disabled for 30 days and nobody missed it, it doesn't ship (Gate 8: "play with it off — if you don't miss it, it doesn't ship")

---

## Enforcement

A fresh session can enforce this rule with a single command:

```bash
# Find all @disabled markers
grep -rn '@disabled' --include='*.js' --include='*.html' ~/workspace/tribes/

# Check for markers older than 30 days (manual date comparison)
# Any marker dated before $(date -d '30 days ago' +%Y-%m-%d) is overdue
```

### Session Checklist

When starting a new coding session on Firewolf:

1. ☐ Read `docs/lessons-learned.md`
2. ☐ Run `grep -rn '@disabled'` — anything overdue?
3. ☐ If overdue markers exist: archive and delete before starting new work

---

## Current @disabled Inventory

*Update this section when adding/removing markers.*

| Tag | Date | File | Reason |
|-----|------|------|--------|
| (none yet) | — | — | Ritual just established; existing disabled code should be retroactively marked |

### Candidates for Immediate Marking

Based on the R32.153 audit, these disabled/dead systems should receive `@disabled` markers:

- **Rain particles** (renderer.js) — disabled but still allocates GPU buffers
- **Grass ring** (renderer.js) — disabled, allocates ~213MB GPU if enabled
- **Dust particles** (renderer.js) — disabled alongside rain
- **renderer_cohesion.js** — `tick()` returns immediately; 82/124 lines dead
- **Jet exhaust** (renderer.js) — disabled, superseded by ski particles

---

## Philosophy

> "The cheapest code is code that doesn't exist." — Casey Muratori

Deleted code is in git history forever. You can always get it back. But dead code in the working tree actively harms:

- **AI sessions** waste context understanding disabled features
- **Developers** can't tell what's live vs. dead without reading every line
- **GPU/CPU** sometimes still pays for disabled features (see: rain allocation bug)
- **Tests** (when we have them) must either test dead code or skip it — both are wrong

Delete early, delete often. Git remembers so you don't have to.
