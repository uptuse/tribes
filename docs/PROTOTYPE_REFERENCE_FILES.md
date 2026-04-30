# Prototype Reference Files

These five files are the **exemplar lock** referenced in `Integration_Plan.md` Section 10.4. They are the entire visual + interaction surface of the unified shell prototype that Claude must port verbatim into the production Firewolf client. The Manus-internal prototype repo is not directly accessible; this bundle exists so Claude has the source code in the same `tribes` repo it is already reading.

## How to use this file

| Section | What it is | Where it ports to |
|---|---|---|
| 1 | `index.css` — design tokens, typography, panel chrome, motion | `client/css/firewolf-shell.css` (new file, included from `index.html`) |
| 2 | `Wordmark.tsx` — vector logotype | `client/editor_core/Wordmark.tsx` |
| 3 | `TopBar.tsx` — wordmark + mode badge + icon cluster | `client/editor_core/TopBar.tsx` |
| 4 | `HelpOverlay.tsx` — welcome / help card | `client/editor_core/HelpOverlay.tsx` |
| 5 | `ShellPanel.tsx` — the 12-tile mode grid + per-mode body copy | `client/editor_core/ShellPanel.tsx` |
| 6 | `Slider` primitive (extracted from `AudioPalette.tsx`) | `client/editor_core/Slider.tsx` |

The Firewolf production client is currently vanilla JS / Three.js, not React. **Claude must adapt these files to the production stack** — JSX → DOM construction, hooks → small classes or vanilla state — but the **visual output, the labels, the layout, the motion timing, and the color tokens must be byte-identical**. The prototype uses Tailwind utility classes; reproduce the equivalent rules in plain CSS keyed off the design tokens in Section 1. Do not introduce React, Tailwind, shadcn, Wouter, Radix, or any other framework into the production client just to use these files.

When the prototype references `useShellState`, `shellStore`, `useShellState((s) => s.props.length)`, etc., those are placeholder calls into the prototype's local store. In production, replace them with reads/writes against the live game state (the existing `THREE.Scene` children, the live `triggers[]`, etc.). The store calls show *what data the UI consumes*; the production wiring will read the same data from real game objects.

The prototype targets **12 modes** including `edit-bindings`. The five files below are at the state where 11 modes are implemented; the 12th (Bindings) is to be added during the port per Section 6.7 of the Integration Plan.

---

## 1. `client/src/index.css` — design tokens, typography, panel chrome, motion

The single source of truth for the warm-paper light theme. Pure black and pure white are forbidden. Amber (`--amber`) is reserved for active state (active mode, active tool, active selection, value being changed). The 3D scene is the dark island floating in this bright cream room.

```css
/*
 * ============================================================
 * Firewolf Shell · Mission Operations Console
 * Design commitments:
 *   1. Bright, warm, paper-cream world. The 3D scene is the dark island.
 *   2. Amber is the only accent. It marks the ACTIVE thing — never decoration.
 *   3. Ink is warm, never pure black. Hairlines are visible, calm, intentional.
 *   4. No centered layouts. Chrome floats at viewport edges.
 *   5. Transitions are linear / cubic. Never spring.
 * ============================================================
 */
@import "tailwindcss";
@import "tw-animate-css";

@custom-variant dark (&:is(.dark *));

@theme inline {
  --font-sans: "IBM Plex Sans", system-ui, sans-serif;
  --font-mono: "JetBrains Mono", ui-monospace, monospace;

  --color-amber: var(--amber);
  --color-amber-dim: var(--amber-dim);
  --color-teal: var(--teal);
  --color-brick: var(--brick);
  --color-ink: var(--ink);
  --color-ink-dim: var(--ink-dim);
  --color-ink-faint: var(--ink-faint);
  --color-panel: var(--panel);
  --color-panel-glass: var(--panel-glass);
  --color-hairline: var(--hairline);

  /* shadcn compatibility aliases — collapse into your own design system */
  --color-background: var(--background);
  --color-foreground: var(--foreground);
  --color-card: var(--card);
  --color-popover: var(--popover);
  --color-primary: var(--primary);
  --color-secondary: var(--secondary);
  --color-muted: var(--muted);
  --color-accent: var(--accent);
  --color-destructive: var(--destructive);
  --color-border: var(--border);
  --color-input: var(--input);
  --color-ring: var(--ring);

  --radius-sm: 2px;
  --radius-md: 3px;
  --radius-lg: 4px;
}

:root {
  /* ---- Firewolf · Warm Paper Light Theme ---- */
  --amber: oklch(0.72 0.16 60);              /* Warm amber #e89030 — active state */
  --amber-dim: oklch(0.72 0.16 60 / 0.18);
  --teal: var(--amber);                      /* legacy alias; collapse to amber */
  --brick: oklch(0.55 0.18 28);              /* Warning */

  --ink: oklch(0.22 0.015 60);               /* Warm near-black — headings */
  --ink-dim: oklch(0.45 0.012 60);           /* Body text */
  --ink-faint: oklch(0.62 0.010 60);         /* Tertiary / hints */

  --panel: oklch(0.96 0.008 75);             /* Warm cream paper #f5f3ee */
  --panel-glass: oklch(0.99 0.005 75 / 0.78);/* Floating cards — brighter than the world */
  --hairline: oklch(0.22 0.015 60 / 0.10);   /* Real ink hairline at 10% */

  --background: var(--panel);
  --foreground: var(--ink);
  --card: oklch(0.99 0.005 75);
  --card-foreground: var(--ink);
  --popover: oklch(0.99 0.005 75);
  --popover-foreground: var(--ink);
  --primary: var(--amber);
  --primary-foreground: oklch(0.99 0.005 75);
  --secondary: oklch(0.92 0.008 75);
  --secondary-foreground: var(--ink);
  --muted: oklch(0.93 0.008 75);
  --muted-foreground: var(--ink-dim);
  --accent: var(--amber);
  --accent-foreground: oklch(0.99 0.005 75);
  --destructive: var(--brick);
  --destructive-foreground: oklch(0.99 0.005 75);
  --border: var(--hairline);
  --input: oklch(0.93 0.008 75);
  --ring: var(--amber);
}

@layer base {
  * { @apply border-border; }

  html, body, #root {
    height: 100%;
    width: 100%;
    overflow: hidden;
  }

  body {
    @apply bg-background text-foreground;
    font-family: var(--font-sans);
    font-feature-settings: "ss01", "cv11";
    -webkit-font-smoothing: antialiased;
    -moz-osx-font-smoothing: grayscale;
  }

  /* Subtle paper grain. Multiply at very low opacity so cream stays cream. */
  body::before {
    content: "";
    position: fixed;
    inset: 0;
    pointer-events: none;
    z-index: 1000;
    background-image: url("data:image/svg+xml,%3Csvg viewBox='0 0 200 200' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='2' stitchTiles='stitch'/%3E%3CfeColorMatrix values='0 0 0 0 0.15 0 0 0 0 0.13 0 0 0 0 0.10 0 0 0 0.06 0'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E");
    opacity: 0.5;
    mix-blend-mode: multiply;
  }

  button, [role="button"] { cursor: pointer; }
}

@layer components {
  /* Monospace numeric / coordinate readout — RARE AND EARNED.
     Use only for cursor coordinates and frame rate. Never for slider values
     or HUD numbers — those use the proportional sans with tabular figures. */
  .mono {
    font-family: var(--font-mono);
    font-variant-numeric: tabular-nums;
    letter-spacing: 0;
  }

  /* Floating panel — brighter than the world, with a warm shadow. */
  .panel-glass {
    background: var(--panel-glass);
    border: 1px solid var(--hairline);
    backdrop-filter: blur(14px) saturate(120%);
    -webkit-backdrop-filter: blur(14px) saturate(120%);
    box-shadow: 0 1px 2px oklch(0.22 0.015 60 / 0.04),
                0 8px 24px oklch(0.22 0.015 60 / 0.06);
  }

  /* Console transition: 240ms cubic, no spring */
  .console-transition {
    transition-property: transform, opacity, background-color, border-color, color;
    transition-duration: 240ms;
    transition-timing-function: cubic-bezier(0.4, 0, 0.2, 1);
  }

  /* Amber hairline that can reposition with a 180ms linear tween */
  .amber-hairline {
    background: var(--amber);
    height: 1px;
    transition: transform 180ms linear;
  }
}
```

---

## 2. `client/src/components/shell/Wordmark.tsx` — vector logotype

The Firewolf brand mark. Lowercase humanist sans where the dot of the *i* is replaced by an upward triangle in `--amber`. Vector, transparent, scales from 14px (favicon-adjacent) to 80px (loading screen). **Do not generate a raster logo file.** This component is the brand asset.

```tsx
/*
 * Wordmark — Firewolf logotype as inline SVG.
 *
 * Rebuilt as vector so it has a true transparent background, scales crisply
 * at any size, and lets us color the letters and the flame independently
 * via CSS. Echoes the source wordmark: lowercase humanist sans, the dot of
 * the `i` replaced by a small upward triangle in amber.
 */
type WordmarkProps = {
  height?: number;
  ink?: string;
  flame?: string;
};

export function Wordmark({
  height = 18,
  ink = "var(--ink)",
  flame = "var(--amber)",
}: WordmarkProps) {
  return (
    <span
      aria-label="Firewolf"
      role="img"
      style={{
        display: "inline-flex",
        alignItems: "center",
        height,
        lineHeight: 1,
        fontFamily:
          "'IBM Plex Sans', system-ui, -apple-system, Segoe UI, sans-serif",
        fontWeight: 500,
        letterSpacing: "-0.012em",
        fontSize: height,
        color: ink,
        position: "relative",
      }}
    >
      <span style={{ position: "relative", display: "inline-block" }}>
        firewolf
        {/* Flame "dot" replacing the dot of the i */}
        <svg
          width={height * 0.36}
          height={height * 0.36}
          viewBox="0 0 10 10"
          style={{
            position: "absolute",
            // Empirically positioned over the i in IBM Plex Sans Medium
            left: `${height * 0.78}px`,
            top: `-${height * 0.22}px`,
            display: "block",
          }}
          aria-hidden
        >
          <polygon points="5,0.5 9,9 1,9" fill={flame} />
        </svg>
      </span>
    </span>
  );
}
```

---

## 3. `client/src/components/shell/TopBar.tsx` — wordmark + mode badge + icon cluster

Persistent header. Three things in the left cluster (wordmark, slash separator, current mode + optional "edit · paused" subtitle); two icon-only buttons in the right cluster (help, panel toggle). No FPS, no version, no telemetry — those belong in a dev overlay, not the chrome.

The `MODE_BADGE` map encodes the contract: **Play badge is ink (calm, normal state); every edit mode badge is amber (active intent to change).** This is the visual contract that tells the operator at a glance whether they are playing or editing.

```tsx
/*
 * TopBar — persistent header with title, mode badge, FPS, and controls.
 * Mission-console DNA: thin, transparent, one pixel of amber hairline.
 */
import type { ShellMode } from "@/lib/shellStore";
import { HelpCircle, PanelRightOpen, PanelRightClose } from "lucide-react";
import { Wordmark } from "./Wordmark";

const MODE_BADGE: Record<ShellMode, { label: string; color: string }> = {
  play:             { label: "Play",     color: "var(--ink)"   },
  "edit-assets":    { label: "Place",    color: "var(--amber)" },
  "edit-buildings": { label: "Build",    color: "var(--amber)" },
  "edit-animations":{ label: "Animate",  color: "var(--amber)" },
  "edit-terrain":   { label: "Sculpt",   color: "var(--amber)" },
  "edit-tuning":    { label: "Tune",     color: "var(--amber)" },
  "edit-triggers":  { label: "Triggers", color: "var(--amber)" },
  "edit-materials": { label: "Paint",    color: "var(--amber)" },
  "edit-audio":     { label: "Sound",    color: "var(--amber)" },
  "edit-vfx":       { label: "Effects",  color: "var(--amber)" },
  "edit-ai":        { label: "Bots",     color: "var(--amber)" },
  // Add: "edit-bindings": { label: "Bindings", color: "var(--amber)" },
};

export function TopBar({
  mode,
  panelOpen,
  onTogglePanel,
  onToggleHelp,
}: {
  mode: ShellMode;
  panelOpen: boolean;
  onTogglePanel: () => void;
  onToggleHelp: () => void;
}) {
  const badge = MODE_BADGE[mode];
  const editing = mode !== "play";

  return (
    <div className="pointer-events-none absolute left-0 right-0 top-0 z-30">
      <div className="pointer-events-auto flex items-center justify-between px-5 py-3">
        {/* Left: wordmark + active mode */}
        <div className="flex items-center gap-4">
          <Wordmark height={17} />
          <span
            className="text-foreground/20"
            style={{ fontSize: 14, lineHeight: 1 }}
            aria-hidden
          >
            /
          </span>
          <span
            className="text-[14px] tracking-tight"
            style={{ color: badge.color, fontWeight: 500 }}
          >
            {badge.label}
          </span>
          {editing && (
            <span className="text-[10.5px] text-foreground/45" style={{ letterSpacing: "0.04em" }}>
              edit · paused
            </span>
          )}
        </div>

        {/* Right: minimal icons — no labels until hover */}
        <div className="flex items-center gap-1">
          <button
            className="p-1.5 rounded-sm text-foreground/40 hover:text-foreground hover:bg-foreground/5 console-transition"
            onClick={onToggleHelp}
            aria-label="Help"
            title="Help (H)"
          >
            <HelpCircle size={15} />
          </button>
          <button
            className="p-1.5 rounded-sm text-foreground/40 hover:text-foreground hover:bg-foreground/5 console-transition"
            onClick={onTogglePanel}
            aria-label="Toggle panel"
            title="Editor panel (Shift+Enter)"
          >
            {panelOpen ? <PanelRightClose size={15} /> : <PanelRightOpen size={15} />}
          </button>
        </div>
      </div>
    </div>
  );
}
```

---

## 4. `client/src/components/shell/HelpOverlay.tsx` — welcome / help card

The first thing the operator sees. Three numbered steps, four labeled keys, one Start button. **This is the tone of voice exemplar.** Every label, button, toast, and log line in the production editor follows the same restraint: plain English, sentence case, no jargon, no SCREAMING_CAPS, no "stub", no "TODO", no insider syntax.

```tsx
/*
 * HelpOverlay — first card you see. Plain words, three steps, then out of the way.
 * Toggle with H or click the X. Esc also closes.
 */
import { X } from "lucide-react";
import { Wordmark } from "./Wordmark";

export function HelpOverlay({ onClose }: { onClose: () => void }) {
  return (
    <div
      className="pointer-events-auto absolute inset-0 z-40 flex items-center justify-center p-6"
      style={{ background: "color-mix(in oklch, var(--panel) 70%, transparent)", backdropFilter: "blur(6px)" }}
    >
      <div
        className="panel-glass rounded-sm border border-hairline"
        style={{ width: "min(480px, 92vw)" }}
      >
        <div className="flex items-center justify-between px-5 py-3 border-b border-hairline">
          <Wordmark height={22} />
          <button
            onClick={onClose}
            className="text-foreground/40 hover:text-foreground console-transition"
            aria-label="Close"
          >
            <X size={14} />
          </button>
        </div>

        <div className="px-5 py-4 space-y-4">
          <p className="text-[13px] leading-relaxed text-foreground/80">
            Two modes. <strong className="text-foreground">Play</strong> the game, or open the editor to{" "}
            <strong className="text-foreground">change</strong> it. Switch any time with{" "}
            <Key>Shift Enter</Key>.
          </p>

          <div className="space-y-2.5">
            <Step n={1}>Click the screen to start playing.</Step>
            <Step n={2}>Press <Key>Shift Enter</Key> and pick a mode — Place, Build, Paint, Bots, anything.</Step>
            <Step n={3}>Click on the ground to use the tool. Switch back to Play to see your changes live.</Step>
          </div>

          <div className="grid grid-cols-[80px_1fr] gap-y-1.5 gap-x-3 text-[12px] pt-1">
            <Key>W A S D</Key>
            <span className="text-foreground/55">Move</span>
            <Key>R</Key>
            <span className="text-foreground/55">Rotate the piece you're about to place</span>
            <Key>H</Key>
            <span className="text-foreground/55">Show this card again</span>
            <Key>Esc</Key>
            <span className="text-foreground/55">Release the mouse</span>
          </div>
        </div>

        <div className="flex items-center justify-end px-5 py-3 border-t border-hairline">
          <button
            onClick={onClose}
            className="text-[12px] rounded-sm border border-hairline px-4 py-1.5 text-foreground/80 hover:text-foreground hover:border-foreground/30 console-transition"
          >
            Start
          </button>
        </div>
      </div>
    </div>
  );
}

function Step({ n, children }: { n: number; children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-3">
      <span
        className="mono text-[10px] flex items-center justify-center rounded-full shrink-0 mt-0.5"
        style={{
          width: 18, height: 18,
          color: "var(--amber)",
          border: "1px solid var(--amber)",
        }}
      >
        {n}
      </span>
      <span className="text-[12.5px] leading-relaxed text-foreground/75">{children}</span>
    </div>
  );
}

function Key({ children }: { children: React.ReactNode }) {
  return (
    <span
      className="mono text-[11px] px-1.5 py-0.5 rounded-sm inline-block"
      style={{ color: "var(--amber)", backgroundColor: "color-mix(in oklch, var(--amber) 10%, transparent)" }}
    >
      {children}
    </span>
  );
}
```

---

## 5. `client/src/components/shell/ShellPanel.tsx` — the 12-tile mode grid

The right-side editor panel. Slides in/out via the panel toggle in the TopBar. Top section is the **mode switcher** — two rows of tiles, amber border on the active tile, ink-on-cream on the inactive ones. Below the grid, one short paragraph + one tip per mode in plain English. Footer shows a scene summary ("3 walls and 2 triggers") and a Clear button.

The 11 modes shown here are the prototype's set. **In production, add a 12th tile for `edit-bindings`** in the bottom row per Section 6.7 of the Integration Plan.

The `BodyPlay`, `BodyPlace`, `BodyBuild`, etc. helpers below the main component are the **canonical body copy for each mode**. Port them verbatim.

```tsx
/*
 * ShellPanel — the Shift+Enter editor panel.
 * Top: 11 mode tiles. Middle: one sentence + tip per mode. Bottom: clear + close.
 *
 * Design lens: plain words for non-technical users; Ive-grade restraint —
 * one word per tile, one sentence per body, no developer chat anywhere.
 */
import type { ShellMode } from "@/lib/shellStore";
import { shellStore, useShellState } from "@/lib/shellStore";
import { X } from "lucide-react";

type ModeTile = { id: ShellMode; label: string; hint: string };

/** Two rows of six. Verbs on top (what you do); nouns/feel on the bottom. */
const MODE_ROWS: ModeTile[][] = [
  [
    { id: "play",            label: "Play",     hint: "Walk around. WASD to move, click to look." },
    { id: "edit-assets",     label: "Place",    hint: "Drop flags, spawns, turrets on the ground." },
    { id: "edit-buildings",  label: "Build",    hint: "Place walls and floors. They snap together." },
    { id: "edit-terrain",    label: "Sculpt",   hint: "Push the ground up or down. Paint snow, rock, grass." },
    { id: "edit-animations", label: "Animate",  hint: "Pose characters and play back motion." },
    { id: "edit-materials",  label: "Paint",    hint: "Recolor walls. Pick a color, click a piece." },
  ],
  [
    { id: "edit-tuning",     label: "Tune",     hint: "Sliders for damage, gravity, match length." },
    { id: "edit-triggers",   label: "Triggers", hint: "Mark spots that fire when the player walks in." },
    { id: "edit-audio",      label: "Sound",    hint: "Play and tune the game's sounds." },
    { id: "edit-vfx",        label: "Effects",  hint: "Drop sparks, explosions, smoke." },
    { id: "edit-ai",         label: "Bots",     hint: "Drop a bot. Pick how it behaves." },
    // Add in production: { id: "edit-bindings", label: "Bindings", hint: "Connect events to effects and sounds." },
  ],
];

export function ShellPanel({
  open,
  mode,
  onModeSwitch,
  onClose,
}: {
  open: boolean;
  mode: ShellMode;
  onModeSwitch: (m: ShellMode) => void;
  onClose: () => void;
}) {
  const propCount     = useShellState((s) => s.props.length);
  const pieceCount    = useShellState((s) => s.pieces.length);
  const triggerCount  = useShellState((s) => s.triggers.length);
  const botCount      = useShellState((s) => s.bots.length);

  const sceneSummary = summarize({ props: propCount, walls: pieceCount, triggers: triggerCount, bots: botCount });

  return (
    <aside
      className="absolute right-0 top-0 bottom-0 z-20 console-transition"
      style={{
        transform: open ? "translateX(0)" : "translateX(calc(100% + 8px))",
        width: "340px",
        paddingTop: 52, // leave room for top bar
      }}
    >
      <div className="panel-glass m-3 mt-0 rounded-sm border border-hairline h-[calc(100%-12px)] flex flex-col">
        {/* Header — single label, no shouting */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-hairline">
          <span className="text-[13px] text-foreground/80" style={{ fontWeight: 500 }}>Editor</span>
          <button
            onClick={onClose}
            className="text-foreground/30 hover:text-foreground console-transition"
            aria-label="Close panel"
          >
            <X size={14} />
          </button>
        </div>

        {/* Mode switcher — 2 rows of tiles, no count, no header */}
        <div className="px-3 pt-3 pb-3">
          <div className="flex flex-col gap-1.5">
            {MODE_ROWS.map((row, rowIdx) => (
              <div
                key={rowIdx}
                className="grid gap-1.5"
                style={{ gridTemplateColumns: `repeat(${row.length}, minmax(0, 1fr))` }}
              >
                {row.map((m) => {
                  const active = m.id === mode;
                  return (
                    <button
                      key={m.id}
                      onClick={() => onModeSwitch(m.id)}
                      title={m.hint}
                      className="group relative flex items-center justify-center rounded-sm px-1 py-2 console-transition"
                      style={{
                        borderWidth: 1,
                        borderStyle: "solid",
                        borderColor: active ? "var(--amber)" : "transparent",
                        backgroundColor: active
                          ? "color-mix(in oklch, var(--amber) 12%, transparent)"
                          : "color-mix(in oklch, var(--ink-dim) 6%, transparent)",
                        color: active ? "var(--amber)" : "var(--ink-dim)",
                      }}
                    >
                      <span className="text-[11px]" style={{ fontWeight: active ? 500 : 400 }}>{m.label}</span>
                    </button>
                  );
                })}
              </div>
            ))}
          </div>
        </div>

        {/* Per-mode body — one short paragraph, no jargon */}
        <div className="flex-1 overflow-y-auto px-4 py-3">
          {mode === "play"             && <BodyPlay />}
          {mode === "edit-assets"      && <BodyPlace />}
          {mode === "edit-buildings"   && <BodyBuild />}
          {mode === "edit-terrain"     && <BodySculpt />}
          {mode === "edit-animations"  && <BodyAnimate />}
          {mode === "edit-tuning"      && <BodyTune />}
          {mode === "edit-triggers"    && <BodyTriggers />}
          {mode === "edit-materials"   && <BodyPaint />}
          {mode === "edit-audio"       && <BodySound />}
          {mode === "edit-vfx"         && <BodyEffects />}
          {mode === "edit-ai"          && <BodyBots />}
        </div>

        {/* Footer — scene summary + clear */}
        <div className="flex items-center justify-between px-4 py-2.5 border-t border-hairline">
          <span className="text-[11px] text-foreground/40">{sceneSummary}</span>
          <button
            onClick={() => {
              shellStore.clearProps();
              shellStore.clearPieces();
              shellStore.clearTriggers();
              shellStore.clearBots();
              shellStore.info("Scene cleared", "amber");
            }}
            className="text-[11px] rounded-sm px-2 py-1 text-foreground/50 hover:text-foreground hover:bg-foreground/5 console-transition"
          >
            Clear
          </button>
        </div>
      </div>
    </aside>
  );
}

/* ---------- Body copy: one short paragraph each, plain words ---------- */

function Body({ children }: { children: React.ReactNode }) {
  return <p className="text-[12.5px] leading-relaxed text-foreground/75">{children}</p>;
}

function Tip({ children }: { children: React.ReactNode }) {
  return <p className="text-[11px] leading-relaxed text-foreground/45 mt-2">{children}</p>;
}

function Key({ children }: { children: React.ReactNode }) {
  return (
    <span
      className="mono text-[11px] px-1 py-0.5 rounded-sm"
      style={{ color: "var(--amber)", backgroundColor: "color-mix(in oklch, var(--amber) 10%, transparent)" }}
    >
      {children}
    </span>
  );
}

function BodyPlay() {
  return (
    <div>
      <Body>You're in the game. Click to look around, <Key>W A S D</Key> to move.</Body>
      <Tip>Open this panel any time with <Key>Shift Enter</Key> to switch modes.</Tip>
    </div>
  );
}

function BodyPlace() {
  return (
    <div>
      <Body>Pick something from the list on the left, then click the ground to drop it.</Body>
      <Tip>Right-drag to look around. Wheel to zoom.</Tip>
    </div>
  );
}

function BodyBuild() {
  return (
    <div>
      <Body>Pick a wall or floor on the left, then click to place. Press <Key>R</Key> to rotate before clicking.</Body>
      <Tip>Pieces snap together on a 4-meter grid.</Tip>
    </div>
  );
}

function BodySculpt() {
  return (
    <div>
      <Body>Pick a brush on the left, then drag the ground to push it up, down, or smooth. <Key>Shift</Key> inverts.</Body>
      <Tip><Key>[</Key> and <Key>]</Key> resize the brush. <Key>Ctrl Z</Key> to undo.</Tip>
    </div>
  );
}

function BodyAnimate() {
  return (
    <div>
      <Body>Pick a clip on the left and scrub the timeline to preview it.</Body>
      <Tip>The full animation editor lives here in the real game.</Tip>
    </div>
  );
}

function BodyTune() {
  return (
    <div>
      <Body>Drag any slider on the left to tune the game — damage, gravity, match length, and more.</Body>
      <Tip>Changes apply live. Switch back to Play to feel the difference.</Tip>
    </div>
  );
}

function BodyTriggers() {
  return (
    <div>
      <Body>Pick what should happen, then click the ground to mark a spot. Walk into it in Play to fire it.</Body>
      <Tip>Use the slider to make the spot bigger or smaller.</Tip>
    </div>
  );
}

function BodyPaint() {
  return (
    <div>
      <Body>Pick a color on the left, then click any wall to recolor it.</Body>
      <Tip>Six colors to start. The real game pulls from your full color library.</Tip>
    </div>
  );
}

function BodySound() {
  return (
    <div>
      <Body>Pick a sound on the left and hit play to hear it. Drag the sliders to make it louder, deeper, or further-reaching.</Body>
      <Tip>Sounds preview through your speakers — no game audio needed.</Tip>
    </div>
  );
}

function BodyEffects() {
  return (
    <div>
      <Body>Pick an effect on the left, then click the ground to set one off. It fades on its own.</Body>
      <Tip>Try Test Fire to drop one in front of you.</Tip>
    </div>
  );
}

function BodyBots() {
  return (
    <div>
      <Body>Pick what the bot should do, then click the ground to drop it. It'll start moving right away.</Body>
      <Tip>Patrol walks a route. Guard stays close. Capture flag heads for the flag.</Tip>
    </div>
  );
}

/* ---------- helpers ---------- */

function summarize({ props, walls, triggers, bots }: { props: number; walls: number; triggers: number; bots: number }) {
  const parts: string[] = [];
  if (props)    parts.push(`${props} prop${props === 1 ? "" : "s"}`);
  if (walls)    parts.push(`${walls} wall${walls === 1 ? "" : "s"}`);
  if (triggers) parts.push(`${triggers} trigger${triggers === 1 ? "" : "s"}`);
  if (bots)     parts.push(`${bots} bot${bots === 1 ? "" : "s"}`);
  if (parts.length === 0) return "Empty scene";
  if (parts.length === 1) return parts[0];
  if (parts.length === 2) return parts.join(" and ");
  return parts.slice(0, -1).join(", ") + ", and " + parts[parts.length - 1];
}
```

---

## 6. `Slider` primitive — extracted from `AudioPalette.tsx`

The shell's slider treatment, used in every palette that has a numeric control (Tune, Sound, Triggers, etc.). Hairline track, amber-filled progress segment, invisible native `input[type=range]` for accessibility, thin glowing amber thumb line. Label and value sit above the track on a single baseline; value is right-aligned in mono with optional unit suffix.

The shadcn `Slider` from `client/src/components/ui/slider.tsx` exists in the prototype but is **not** the locked visual reference — it's a generic Radix wrapper. The visual you must port is this in-palette pattern.

```tsx
/* --- internal slider primitive ----------------------------------------- */
function Slider({
  label, value, min, max, step, unit, fmt, onChange,
}: {
  label: string;
  value: number;
  min: number; max: number; step: number;
  unit: string;
  fmt: (v: number) => string;
  onChange: (v: number) => void;
}) {
  const t = (value - min) / (max - min);
  return (
    <div>
      <div className="flex items-baseline justify-between mb-1">
        <span className="text-[10.5px] text-foreground/70">{label}</span>
        <span className="mono text-[11px]" style={{ color: "var(--amber)" }}>
          {fmt(value)}{unit && <span className="text-foreground/40 ml-0.5">{unit}</span>}
        </span>
      </div>
      <div className="relative h-4">
        <div className="absolute inset-y-[7px] left-0 right-0 bg-hairline" />
        <div
          className="absolute top-[6px] h-[3px] console-transition"
          style={{
            left: 0,
            width: `${t * 100}%`,
            backgroundColor: "color-mix(in oklch, var(--amber) 55%, transparent)",
          }}
        />
        <input
          type="range"
          min={min}
          max={max}
          step={step}
          value={value}
          onChange={(e) => onChange(parseFloat(e.target.value))}
          className="absolute inset-0 w-full opacity-0 cursor-pointer"
          aria-label={label}
        />
        <div
          className="absolute top-[1px] h-[14px] w-[2px] console-transition"
          style={{
            left: `calc(${t * 100}% - 1px)`,
            backgroundColor: "var(--amber)",
            boxShadow: "0 0 6px var(--amber)",
          }}
        />
      </div>
    </div>
  );
}
```

Usage example, from `TuningPalette.tsx`:

```tsx
<Slider
  label="Weapon damage"
  value={tuning.weapon_dmg}
  min={1} max={50} step={1}
  unit=""
  fmt={(v) => v.toFixed(0)}
  onChange={(v) => shellStore.setTuning("weapon_dmg", v)}
/>

<Slider
  label="Gravity"
  value={tuning.gravity}
  min={5} max={30} step={0.5}
  unit="m/s²"
  fmt={(v) => v.toFixed(1)}
  onChange={(v) => shellStore.setTuning("gravity", v)}
/>
```

Note the unit suffix and the `fmt` callback. **Sliders always show their unit** ("m", "m/s²", "×", "s") and use `fmt` to control decimal precision. This is the rule from voice-and-labels guidance in Section 10.5.

---

*End of bundle. If a sixth surface needs to be added (e.g. the LogConsole, the CoordReadout, or a specific palette), append it here rather than re-bundling.*
