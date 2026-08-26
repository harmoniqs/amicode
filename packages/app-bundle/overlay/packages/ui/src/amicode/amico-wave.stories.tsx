// @ts-nocheck
// AmicoWave: the harmonic working indicator. Geometry/timing live in wave-geometry.ts and are
// unit-tested there; this file is the only place the SVG + CSS actually render in isolation, so
// it is also the only place a CSS regression (wrong ink, broken quadrature, id collisions across
// simultaneous mounts) would be visible before it ships. The glyph mounts inside the thinking
// block (thinking-line.tsx) in the app — these stories remain the focused way to see it.
//
// ---- why Default/Schemes exist -------------------------------------------------------------
// A review caught a critical color bug that no unit test could have caught: the component
// used to pick its dark-scheme ink via `:root:not([data-theme="light"])`, a selector copied
// from a block in v2/styles/theme.css that lives INSIDE a /* */ comment — dead CSS — so it
// matched in every state and the glyph rendered brand lemon (~1.1:1 contrast) on light
// backgrounds. It's fixed to `color: var(--v2-icon-icon-accent)`, which the active theme
// (oc-2) maps to grey-800 on light and #FFF676 on dark. Default and Schemes below exist so
// that mapping can never silently regress again.
//
// ---- the wrinkle: how these stories actually re-resolve the tokens ------------------------
// The obvious approach — set `data-color-scheme="light"`/`"dark"` on a wrapper element, per
// theme/context.tsx (`dataset.colorScheme`) and v2/styles/theme.css's
// `[data-color-scheme="light"]` / `[data-color-scheme="dark"]` blocks — turns out to be a
// no-op INSIDE STORYBOOK. Storybook's preview only imports `@opencode-ai/ui/styles/tailwind`,
// whose theme file is the v1 `styles/theme.css`; the v2 file that defines those
// `[data-color-scheme]` blocks is only ever pulled in by the real app's
// `v2/styles/tailwind.css` chain (packages/app/src/index.css), which Storybook never loads.
// Verified empirically with Playwright against a running Storybook: a nested
// `data-color-scheme="light"` (or "dark") div's `--v2-*` custom properties were untouched by
// the attribute and simply inherited whatever the global theme toolbar had already put on
// <html> — both a "light" and a "dark" test div resolved to the SAME `--v2-icon-icon-accent`.
// So a story built the literal way the review described would silently show the SAME color
// twice, which is exactly the failure mode it was meant to catch.
//
// Instead, each scheme pane below calls the SAME resolver the app uses at runtime —
// `resolveThemeVariantV2` over the real oc-2.json theme (theme/v2/resolve.ts, the function
// theme/context.tsx's applyThemeCss calls) — and applies the FULL resulting token set
// (188 keys: primitive ramps + semantic aliases, self-contained) as inline custom properties
// on that pane's own wrapper. That correctly re-resolves `--v2-icon-icon-accent` (and every
// other v2 token used inside) independent of whatever the global Storybook theme toggle is
// doing, because inline-set custom properties on an element always win for that subtree. This
// is arguably MORE faithful than the dead attribute would have been: it reads the live oc-2
// mapping from its source file, so it tracks theme changes instead of a hand-copied hex.
import { createSignal, For, onMount } from "solid-js"
import { AmicoWave } from "./amico-wave"
import { MODE_WAVELENGTHS, WAVE_BOX } from "./wave-geometry"
import oc2ThemeJson from "../theme/themes/oc-2.json"
import { resolveThemeVariantV2 } from "../theme/v2/resolve"
import type { DesktopTheme } from "../theme/types"

const oc2Theme = oc2ThemeJson as DesktopTheme

/** The real oc-2 --v2-* token set for one color scheme, self-contained (primitive ramps +
 *  semantic aliases both included), so it can be applied to any wrapper and resolve correctly
 *  with zero dependency on ambient state — in particular, independent of the Storybook global
 *  theme toolbar. This is the exact function theme/context.tsx calls to paint <html>; here we
 *  scope its output to a <div> instead. */
function schemeVars(scheme: "light" | "dark"): Record<string, string> {
  const isDark = scheme === "dark"
  const tokens = resolveThemeVariantV2(isDark ? oc2Theme.dark : oc2Theme.light, isDark)
  const vars: Record<string, string> = {}
  for (const [key, value] of Object.entries(tokens)) vars[`--${key}`] = value
  return vars
}

// Scale + freeze helpers used by Schemes/Modes/Magnified/ReducedMotion below. AmicoWave sets
// width/height as SVG presentation attributes (30x12); a plain CSS class rule already beats
// those with no !important needed, per the CSS spec's presentation-attribute priority rule.
const StoryCss = () => (
  <style>{`
    .amc-wave-x4 { width: 120px; height: 48px; }
    .amc-wave-x6 { width: 180px; height: 72px; }
    /* Modes: freeze all motion, then show only the one .amc-wave-mode <g> matching data-pin. */
    .amc-wave-modepin .amc-wave,
    .amc-wave-modepin .amc-wave * { animation: none !important; }
    .amc-wave-modepin[data-pin="1"] .amc-wave-mode:not(:nth-child(1)),
    .amc-wave-modepin[data-pin="2"] .amc-wave-mode:not(:nth-child(2)),
    .amc-wave-modepin[data-pin="3"] .amc-wave-mode:not(:nth-child(3)) { display: none; }
    /* ReducedMotion: mockup of the CSS's own @media (prefers-reduced-motion: reduce) block —
       static mode-1 curve, companion hidden, no animation. */
    .amc-wave-reducedmock .amc-wave,
    .amc-wave-reducedmock .amc-wave * { animation: none !important; }
    .amc-wave-reducedmock .amc-wave-mode:not(:nth-child(1)) { display: none; }
    .amc-wave-reducedmock .amc-wave-ln[data-role="companion"] { opacity: 0 !important; }
  `}</style>
)

function SchemePane(props: { scheme: "light" | "dark"; children: unknown }) {
  return (
    <div
      style={{
        ...schemeVars(props.scheme),
        background: "var(--v2-background-bg-base)",
        color: "var(--v2-text-text-base)",
        padding: "20px",
        "border-radius": "var(--radius-md)",
        border: "1px solid var(--v2-border-border-base)",
      }}
    >
      <div
        style={{
          "font-size": "10px",
          "letter-spacing": "0.08em",
          "text-transform": "uppercase",
          color: "var(--v2-text-text-faint)",
          "margin-bottom": "10px",
        }}
      >
        {props.scheme} scheme
      </div>
      {props.children}
    </div>
  )
}

// Mimics the real mount site (thinking-line.tsx): glyph and bold gerund on the
// top row; the muted meta below, starting under the glyph — reusing the actual
// .amc-thinking* classes from amicode.css. DOM order is word-first so the
// block's first baseline is the verb's (see thinking-line.tsx).
const ThinkingRow = () => (
  <span class="amc-thinking">
    <span class="amc-thinking-word">Percolating…</span>
    <AmicoWave />
    <span class="amc-thinking-meta">5m 13s · ↑ 2.4k tokens</span>
  </span>
)

export default {
  title: "Amicode/AmicoWave",
  id: "amicode-amico-wave",
  tags: ["autodocs"],
  parameters: {
    docs: {
      description: {
        component: `### AmicoWave

The harmonic working indicator: a 30×12px standing wave in quadrature (a lead curve and a
fainter companion, a quarter period out of phase, so one is at full swing exactly when the
other crosses zero — what keeps the glyph from reading as a blink at 12px). It climbs through
three modes (1/2/3 full wavelengths across the box) on a slower cadence. All geometry and
timing come from wave-geometry.ts via CSS custom properties set inline by the component —
never restated here.

Not yet mounted anywhere in the app directly — it renders inside the thinking block
(thinking-line.tsx, mounted by the app timeline and the session-ui lane) — so these stories
remain the focused way to see the glyph itself.

**Hard invariant, guarded by ManyInstances below:** no SVG \`<defs>\`, no \`id\` attributes.
SVG ids are document-global, and several indicators mount at once in real use (one thinking
line plus one tool header per in-flight tool call) — an id would collide across instances.`,
      },
    },
  },
}

// ---------------------------------------------------------------------------------------------
// Default — the glyph at natural size beside its real-use text, in both schemes side by side
// so an ink regression (wrong token, or a hardcoded color that ignores scheme entirely) is
// visible without needing the Schemes story's numeric readout.
export const Default = () => (
  <div style={{ display: "flex", "flex-direction": "column", gap: "16px", "max-width": "360px" }}>
    <SchemePane scheme="dark">
      <ThinkingRow />
    </SchemePane>
    <SchemePane scheme="light">
      <ThinkingRow />
    </SchemePane>
  </div>
)

// ---------------------------------------------------------------------------------------------
// Schemes — the contrast check. getComputedStyle(el).color reads what the browser ACTUALLY
// resolved for that scheme's pane, not what the token mapping merely intends. This is the
// story that would have caught the original bug: the buggy selector lived in a dead comment,
// so the glyph's color never actually changed with scheme — it would have printed the SAME
// resolved color under both panes here.
function ContrastSwatch(props: { scheme: "light" | "dark" }) {
  const [resolved, setResolved] = createSignal("…")
  let wrap: HTMLDivElement | undefined
  onMount(() => {
    const svg = wrap?.querySelector('[data-component="amico-wave"]')
    if (svg) setResolved(getComputedStyle(svg).color)
  })
  return (
    <div
      style={{
        ...schemeVars(props.scheme),
        background: "var(--v2-background-bg-base)",
        color: "var(--v2-text-text-base)",
        display: "flex",
        "flex-direction": "column",
        "align-items": "center",
        gap: "14px",
        padding: "28px",
        "border-radius": "var(--radius-md)",
        border: "1px solid var(--v2-border-border-base)",
        "min-width": "170px",
      }}
    >
      <div
        style={{
          "font-size": "10px",
          "letter-spacing": "0.08em",
          "text-transform": "uppercase",
          color: "var(--v2-text-text-faint)",
        }}
      >
        {props.scheme}
      </div>
      <div ref={wrap}>
        <AmicoWave class="amc-wave-x4" />
      </div>
      <code style={{ "font-size": "11px", color: "var(--v2-text-text-muted)", "text-align": "center" }}>
        getComputedStyle → {resolved()}
      </code>
    </div>
  )
}

export const Schemes = () => (
  <>
    <StoryCss />
    <div style={{ display: "flex", gap: "20px" }}>
      <ContrastSwatch scheme="light" />
      <ContrastSwatch scheme="dark" />
    </div>
  </>
)

// ---------------------------------------------------------------------------------------------
// Modes — each of the three standing modes, frozen and isolated, at 4x, so the shape reads.
// Wavelength is indexed by full wavelengths across the 30px box (1, 2, 3) — deliberately NOT
// the physical harmonic number; see wave-geometry.ts's MODE_WAVELENGTHS comment for why.
function FrozenMode(props: { pin: number; wavelength: number; waves: number }) {
  return (
    <div style={{ display: "flex", "flex-direction": "column", "align-items": "center", gap: "10px" }}>
      <div class="amc-wave-modepin" data-pin={String(props.pin)}>
        <AmicoWave class="amc-wave-x4" />
      </div>
      <div style={{ "font-size": "11px", color: "var(--v2-text-text-muted)", "text-align": "center", "max-width": "140px" }}>
        mode {props.pin} — λ={props.wavelength}px, {props.waves} full wavelength{props.waves === 1 ? "" : "s"} across
        the box
      </div>
    </div>
  )
}

export const Modes = () => (
  <>
    <StoryCss />
    <div style={{ display: "flex", gap: "28px", "flex-wrap": "wrap" }}>
      <For each={MODE_WAVELENGTHS}>
        {(wavelength, i) => <FrozenMode pin={i() + 1} wavelength={wavelength} waves={WAVE_BOX.w / wavelength} />}
      </For>
    </div>
  </>
)

// ---------------------------------------------------------------------------------------------
// Magnified — one live glyph at 6x so the quadrature is visible at a glance: the faint
// companion is at full swing exactly when the bold lead crosses the axis.
export const Magnified = () => (
  <>
    <StoryCss />
    <div style={{ display: "flex", "flex-direction": "column", gap: "12px", "align-items": "flex-start" }}>
      <AmicoWave class="amc-wave-x6" />
      <p style={{ "font-size": "12px", color: "var(--v2-text-text-muted)", "max-width": "420px", margin: 0 }}>
        The companion (faint, 0.4 opacity) is a quarter period behind the lead — it peaks
        exactly when the lead crosses zero, which is what stops the glyph reading as a blink at
        the real 12px size.
      </p>
    </div>
  </>
)

// ---------------------------------------------------------------------------------------------
// ManyInstances — the regression guard for the no-<defs>/no-id rule. SVG ids are
// document-global: if one is ever introduced (for a mask, a gradient, anything), every
// instance after the first resolves to the FIRST element's definition and visibly breaks —
// invisibly on inspection of a single instance, but obvious the moment two or more are mounted
// at once, which is the normal case in the real app (one thinking line plus one tool header
// per in-flight tool call).
export const ManyInstances = () => (
  <div style={{ display: "flex", "flex-direction": "column", gap: "12px" }}>
    <p style={{ "font-size": "12px", color: "var(--v2-text-text-muted)", "max-width": "560px", margin: 0 }}>
      12 live instances, mounted simultaneously. AmicoWave has no SVG &lt;defs&gt; and no id
      attribute anywhere — this is the guard for that: if either is ever added, ids collide
      across instances and every glyph after the first will visibly break here (even though a
      single isolated instance would still look correct).
    </p>
    <div style={{ display: "flex", "flex-wrap": "wrap", gap: "16px" }}>
      <For each={Array.from({ length: 12 })}>{() => <AmicoWave />}</For>
    </div>
  </div>
)

// ---------------------------------------------------------------------------------------------
// ReducedMotion — a mockup of the CSS's own @media (prefers-reduced-motion: reduce) fallback
// (amicode.css): one static mode-1 curve, companion hidden, no animation. This is authored
// locally to DEMONSTRATE the intended fallback, not to test it live — Storybook cannot force
// the OS/browser reduced-motion setting. To see the real fallback, enable "reduce motion" at
// the OS level (or the equivalent DevTools rendering emulation) and reload; every AmicoWave in
// every story on this page will then freeze the same way.
export const ReducedMotion = () => (
  <>
    <StoryCss />
    <div style={{ display: "flex", "flex-direction": "column", gap: "12px", "align-items": "flex-start" }}>
      <div class="amc-wave-reducedmock">
        <AmicoWave />
      </div>
      <p style={{ "font-size": "12px", color: "var(--v2-text-text-muted)", "max-width": "480px", margin: 0 }}>
        Mockup only — driven by the OS/browser <code>prefers-reduced-motion</code> setting in
        the real component, which Storybook cannot toggle. The elapsed counter in the thinking
        line keeps ticking under reduced motion; only this glyph's own animation stops.
      </p>
    </div>
  </>
)
