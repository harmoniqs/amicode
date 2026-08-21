import { For, Show } from "solid-js"
import { AmicodeTagline } from "./tagline"

// AMICODE: start-screen getting-started block — tagline, how-it-works row,
// and starter chips that submit their prompt as the first message of a new
// session. Presentation only; the submit wiring (composer draft + submit) is
// app-side and arrives via onStart (same pattern as the entity rail's onAsk).
// Copy is en-only by design, consistent with the default-locale-en patch.

// TODO(repertoire-chips): these become data — one chip per installed+entitled
// score (name/outcome/duration from SCORE.md frontmatter) once the server
// exposes the compiled repertoire; static, feature-diverse set until then.
// The set spans the lifetime: onboard (first run routes any chip into the
// overture) → design with memory/recommendations → warm-start from the pulse
// bank → go fast with Veloce.
// NOTE (Kate, chat-redesign): keep the FULL feature-diverse set — these are
// designed to become suggestion data (per profile/activity/entitled score, see
// the repertoire-chips TODO above); don't condense the static stand-in.
// Labels are the full recommendation text — NOT hand-shortened. These become
// server-generated suggestions (see the repertoire-chips TODO): the label will
// BE the recommendation, so we honor it verbatim and let the row wrap.
export const AMICODE_STARTERS: readonly { label: string; prompt: string }[] = [
  {
    label: "Walk me through my first experiment",
    prompt: "walk me through setting up my first experiment",
  },
  {
    label: "Help me with a coding task",
    prompt: "I have a coding task — let's get started",
  },
  // NOTE(spec B): the static "Resume my pulse design" chip was replaced by the
  // conditional resumeName-driven chip below — Resume renders only when a
  // problem workspace actually exists (no empty chrome).
  {
    label: "Warm-start from a previous result",
    prompt: "warm-start a new experiment from my previous results",
  },
  {
    label: "Go fast with Veloce",
    prompt: "turn on Veloce — auto-accept your high-confidence recommendations, and still confirm before any solve",
  },
  {
    label: "What can Amico do?",
    prompt: "what can Amico do?",
  },
]

// The three-beat arc of a research session, from setup to results.
const STEPS = ["① Define your system and problem", "② Optimize and iterate", "③ Analyze and refine"]

/** amicode chat-redesign (Kate): chips-only row for the composer-as-hero start
 *  screen — no tagline, no byline, no steps. Quiet neutral pills (Kimi-style):
 *  a filled body (bg-layer-02) + a hairline (border-strong) so they read on the
 *  near-white start page; muted ink that lifts on hover. A transparent fill with
 *  a 10%-alpha border was ~1.25:1 vs the page — effectively invisible in light. */
export type StarterChip = { label: string; prompt: string; dataSlot?: string }

export function AmicodeStarterChips(props: {
  onStart: (prompt: string) => void
  // Dynamic chip set, ranked by the caller from the problem history
  // (Resume → Warm-start → Retry → static pad). Falls back to AMICODE_STARTERS
  // + the legacy resumeName/onResume pair when `chips` is not given.
  chips?: StarterChip[]
  resumeName?: string
  onResume?: () => void
}) {
  // The chips' OWN wrapping row (Kate: separate container from the folder
  // picker) — centered, quiet pills. Class-based styling so hover works.
  const pill =
    "rounded-full border border-[var(--v2-border-border-strong)] bg-[var(--v2-background-bg-layer-02)] px-3 py-1 text-[12px] leading-4 whitespace-nowrap text-[var(--v2-text-text-muted)] cursor-pointer transition-colors duration-150 hover:text-[var(--v2-text-text-base)] hover:bg-[var(--v2-background-bg-layer-03)]"
  return (
    <div
      data-component="amicode-starter-chips"
      class="flex min-w-0 max-w-full flex-wrap items-center justify-center gap-2"
    >
      <Show
        when={props.chips}
        fallback={
          <>
            <For each={AMICODE_STARTERS}>
              {(starter) => (
                <button
                  type="button"
                  data-slot="amicode-gs-starter"
                  class={pill}
                  onClick={() => props.onStart(starter.prompt)}
                >
                  {starter.label}
                </button>
              )}
            </For>
            <Show when={props.resumeName && props.onResume}>
              <button type="button" data-slot="amicode-gs-resume" class={pill} onClick={() => props.onResume?.()}>
                Resume {props.resumeName}
              </button>
            </Show>
          </>
        }
      >
        {(chips) => (
          <For each={chips()}>
            {(chip) => (
              <button
                type="button"
                data-slot={chip.dataSlot ?? "amicode-gs-starter"}
                class={pill}
                onClick={() => props.onStart(chip.prompt)}
              >
                {chip.label}
              </button>
            )}
          </For>
        )}
      </Show>
    </div>
  )
}

export function AmicodeGettingStarted(props: {
  onStart: (prompt: string) => void
  // spec B: Resume verb — set only when a problem workspace exists (no empty chrome)
  resumeName?: string
  onResume?: () => void
  // amicode: the compact new-session layout hides the how-it-works steps (tagline
  // + chips only). Defaults on so the classic NewSessionView is unchanged.
  showSteps?: boolean
}) {
  return (
    <div
      data-component="amicode-getting-started"
      style={{
        display: "flex",
        "flex-direction": "column",
        "align-items": "center",
        gap: "12px",
        "min-width": "0",
        "max-width": "100%",
      }}
    >
      <div
        data-slot="amicode-gs-tagline"
        style={{ "font-size": "14px", "line-height": "20px", color: "var(--v2-text-text-base)" }}
      >
        <AmicodeTagline />
      </div>
      <div
        data-slot="amicode-gs-byline"
        style={{ "font-size": "11px", "line-height": "14px", color: "var(--v2-text-text-faint)", "margin-top": "-8px" }}
      >
        By Harmoniqs
      </div>
      <Show when={props.showSteps ?? true}>
        <div
          data-slot="amicode-gs-steps"
          style={{
            display: "flex",
            "flex-wrap": "wrap",
            "justify-content": "center",
            "column-gap": "16px",
            "row-gap": "4px",
            "font-size": "12px",
            "line-height": "16px",
            color: "var(--v2-text-text-faint)",
          }}
        >
          <For each={STEPS}>{(step) => <span style={{ "white-space": "nowrap" }}>{step}</span>}</For>
        </div>
      </Show>
      <div
        data-slot="amicode-gs-starters"
        style={{
          display: "flex",
          "flex-wrap": "wrap",
          "justify-content": "center",
          gap: "6px",
        }}
      >
        <For each={AMICODE_STARTERS}>
          {(starter) => (
            <button
              type="button"
              data-slot="amicode-gs-starter"
              data-component="amc-secondary-btn"
              onClick={() => props.onStart(starter.prompt)}
              style={{
                border: "1px solid var(--accent-edge)",
                "border-radius": "var(--radius-md)",
                background: "var(--v2-background-bg-layer-02)",
                color: "var(--v2-text-text-base)",
                padding: "4px 12px",
                "font-size": "12px",
                "line-height": "16px",
                cursor: "pointer",
              }}
            >
              {starter.label}
            </button>
          )}
        </For>
        {props.resumeName && props.onResume && (
          <button
            type="button"
            data-slot="amicode-gs-resume"
            onClick={() => props.onResume?.()}
            style={{
              border: "1px solid var(--v2-icon-icon-accent)",
              "border-radius": "var(--radius-md)",
              background: "var(--v2-background-bg-layer-02)",
              color: "var(--v2-text-text-base)",
              padding: "4px 12px",
              "font-size": "12px",
              "line-height": "16px",
              cursor: "pointer",
            }}
          >
            Resume “{props.resumeName}”
          </button>
        )}
      </div>
    </div>
  )
}
