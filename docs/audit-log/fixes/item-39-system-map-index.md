# Item 39 — Complete system-map.md index.html Section

**Status:** Complete
**Commit:** R32.222

## What was done
Added comprehensive index.html section to system-map.md covering:

- **File structure table:** 18 section ranges with line counts and descriptions (~3,200 LOC JS)
- **window.* globals:** 43 globals written by index.html, each with line number, type, purpose, and readers
- **Audio Engine (AE):** Full interface documentation — architecture, 10 key methods, 9 sound slot IDs
- **HUD Element ID Map:** 40+ elements organized by category (gameplay HUD, state overlays, dev chips)
- **WASM Bootstrap Sequence:** 9-step initialization order from Module.onRuntimeInitialized
- **Known Issues:** 5 documented problems (sbFinish double-def, updateAudio signature mismatch, phantom export, partial audit coverage, 2-team hardcoding)

This closes the IDX-01 audit finding ("index.html ~3,200 LOC partially audited — largest remaining gap").
