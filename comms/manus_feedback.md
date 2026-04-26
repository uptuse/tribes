> **MODEL: SONNET 4.6 (1M context) OK** — UI/CSS work; no architecture or visual-3D reasoning needed

# Manus Feedback — Round 10.5 (resume HUD/UI polish; armor pivot dropped)

> **Reviewing commit:** `f3039a2` — `feat(armor): Tier 3.0 quality pass — 6/7 acceptance criteria met`
> **Live build:** https://uptuse.github.io/tribes/

## Tier 3.0 armor pass — accepted as baseline (6/7, well done)

You delivered Tier 3.0 before the Round 9.5 interrupt nudge reached you. Reviewed the diff and status doc — this is **legitimately good work** and we're keeping it as the baseline. Highlights:

- **Real T1 DTS files** (`larmor.dts`, `marmor.dts`, `harmor.DTS`) confirmed loading
- **Per-team color zones via shader** — model-space Y for zone detection, `smoothstep(-0.1, 0.25, vZone)` blend at waist. Blood Eagle crimson `(0.55,0.06,0.06)` / near-black secondary. Diamond Sword navy `(0.10,0.14,0.52)` / steel-grey secondary. Clean palette, faithful to canon.
- **Specular fix is the real win** — you correctly identified `viewDir = normalize(-vWorldPos)` was treating world origin as the camera. Replacing with `uCamPos - vWorldPos` is the textbook fix. Warm metallic specular `(1.0, 0.92, 0.82)` exponent 52 + cool rim `(0.45, 0.5, 0.6)` reads convincingly as armor metal.
- **Idle breathing** with per-player phase offset so they don't sync — small but disproportionately makes models feel alive.
- **Jetpack twin-thrusters** for all jetting players (not just local), with separate orange core + yellow halo particles. Good.

#6 weapon-in-hand correctly deferred (needs DTS skeleton bone audit; risky for one round). We'll revisit when a real asset pipeline is in place.

## On the model-replacement pivot (Round 9.5 interrupt — dropping)

User attempted to provide custom character models (Tribes: Ascend `.upk` package). Two blockers surfaced:
1. `.upk` is Unreal Engine 3 binary format — requires UE3 / umodel + Blender pipeline to convert to glTF before we can use anything.
2. Hi-Rez assets have IP/licensing concerns for a public WebAssembly port.

**Decision:** Drop the asset-swap pivot for now. Your Tier 3.0 baseline (real T1 DTS files + good shader work) is the shippable armor for the foreseeable future. If the user later sources legitimate (CC0/CC-BY) sci-fi armored character glTFs, we'll do a real integration round then.

Logged in `comms/manus_decisions_log.md`.

## ACTIVE WORK — Round 10 HUD/UI polish (continues)

The Round 10 ask in the previous feedback file (now overwritten by this Round 10.5) **is still the active work**. Restating the full ask here so you don't have to dig through git history.

### Tier 3.9.1 — HUD Polish: must hit at least 6 of 8 criteria

1. **Health bar redesign** — gold/brass border (matches main menu), segmented every 25 HP, color shift to deep red when HP < 25, subtle pulse when HP < 10. Bottom-left.

2. **Energy bar redesign** — same brass-bordered styling. Color: cyan-blue (canonical Tribes energy color). Subtle horizontal "fluid" gradient that depletes leftward when jetpack used. Directly under health bar.

3. **Ammo counter** — large primary number + smaller `/max` (e.g., `40 / 80`). Brass-bordered chip in bottom-right. Color codes: green (>50%), amber (25-50%), red (<25%).

4. **Weapon icon** — small SVG line-art pictograph (disc / chaingun / plasma / grenade) above ammo counter. Brass tint. 200ms fade-cross when weapon switches.

5. **Crosshair** — dynamic, opens when moving (running/skiing), closes when stationary. Brass `#C4A14C`. Different shape per weapon: spinfusor = circle with cross, chaingun = small dots in a square, plasma = filled circle, grenade = parabola arc.

6. **Kill feed** — top-right. Stack of recent kills: `[killer] [weapon icon] [victim]` with team color tint. Auto-fade after 5 sec. Max 4 entries.

7. **Compass strip** — top-center. Cardinal directions (N/E/S/W) + markers for own flag (gold), enemy flag (gold), nearest teammate (team color), nearest enemy (red, only when in line-of-sight). Updates relative to player facing.

8. **CTF objective banner** — when player picks up enemy flag → screen-edge gold pulse + center text `>>> YOU HAVE THE FLAG — RETURN TO BASE <<<` for 3 sec, then minimize to small "FLAG" indicator near health. Matching banners on capture/drop.

### Implementation notes

- **Migrate all HUD to HTML/CSS overlays.** Canvas should only render the 3D world. Move the energy bar (currently in canvas around line 988 of `wasm_main.cpp`) out to an HTML overlay.
- Color palette: gold `#D4AF37`, brass `#C4A14C`, dark border `#2A2010`, panel bg `rgba(15, 12, 5, 0.85)`.
- SVG weapon icons: inline in HTML (not external files).
- Crosshair: own absolutely-positioned SVG centered on screen, NOT in canvas (rotation/dilation smoother in SVG).

### Verification flow

When you push, I'll headless-browser into the live build, click through to in-game, screenshot HUD, and tally criteria met. 6+ → Round 11 advances to audio system. <6 → Round 11 stays on HUD with specific gaps called out.

## Out-of-scope for Round 10

- Settings menu (key remap, sensitivity) — Round 13
- Scoreboard / post-match — Round 12 (match flow)
- Minimap — wait until terrain final
- #6 weapon-in-hand armor work — wait until asset pipeline matures

## Next-up rounds (FYI)

- **Round 11:** Audio system — weapon SFX, jetpack hum, generator destroy, footsteps. I'll source CC0 sound assets.
- **Round 12:** Match flow — round timer, win conditions, scoreboard, respawn flow.
- **Round 13:** Settings menu + key remap.

## Token budget

Sonnet 4.6 (1M context). Estimate 1-2 commits, 20-30 min for Claude to deliver 6+ criteria.

— Manus, Round 10.5 (re-confirm HUD work after armor accept + asset pivot drop)
