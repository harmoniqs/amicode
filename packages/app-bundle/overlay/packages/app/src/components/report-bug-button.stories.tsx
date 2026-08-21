import { For } from "solid-js"
import { Icon as IconV2 } from "@opencode-ai/ui/v2/icon"
import { IconButtonV2 } from "@opencode-ai/ui/v2/icon-button-v2"
import { PromptInputV2SubmitButton } from "@opencode-ai/session-ui/v2/prompt-input"
import { oc2Theme, resolveThemeVariantV2 } from "@opencode-ai/ui/theme"
import { ReportBugButton } from "@/components/report-bug-button"
// The app entry loads design-polish.css globally (it owns --radius-md, which
// the button's css consumes); stories must pull it themselves.
import "@/design-polish.css"

// amicode/opencode#116: the report-a-bug button for the v2 composer. The
// interaction-state contract (default / hover / active / focus-visible /
// disabled) is visual and lives here — the app has no component-render unit
// test surface (Solid needs its compile-time transform), per the issue's
// Testing Decisions. Gate rendering and click behavior are unit-tested in
// packages/app/src/utils/amicode-bug-report.test.ts and
// packages/app/src/pages/session/composer/report-bug.test.ts.

/** The real oc-2 --v2-* token set for one color scheme, applied as inline
 *  custom properties — the SAME resolver the app runs at boot, so each pane
 *  re-resolves the danger token (red-800 light / red-500 dark) regardless of
 *  the Storybook theme toolbar. (The naive data-color-scheme wrapper is a
 *  no-op inside Storybook — see amico-wave.stories.tsx for the archaeology.) */
function schemeVars(scheme: "light" | "dark"): Record<string, string> {
  const isDark = scheme === "dark"
  const tokens = resolveThemeVariantV2(isDark ? oc2Theme.dark : oc2Theme.light, isDark)
  const vars: Record<string, string> = {}
  for (const [key, value] of Object.entries(tokens)) vars[`--${key}`] = value
  return vars
}

const STATES: { label: string; props: { state?: "hover" | "pressed" | "focus"; disabled?: boolean } }[] = [
  { label: "default", props: {} },
  { label: "hover", props: { state: "hover" } },
  { label: "active", props: { state: "pressed" } },
  { label: "focus-visible", props: { state: "focus" } },
  { label: "disabled", props: { disabled: true } },
]

function StateMatrix() {
  return (
    <div style={{ display: "flex", gap: "16px", "align-items": "center", "flex-wrap": "wrap" }}>
      <For each={STATES}>
        {(item) => (
          <div style={{ display: "grid", gap: "6px", "justify-items": "center" }}>
            <ReportBugButton {...item.props} />
            <span style={{ "font-size": "11px", color: "var(--v2-text-text-faint)" }}>{item.label}</span>
          </div>
        )}
      </For>
    </div>
  )
}

/** The session-ui composer's bottom row, faithfully mirrored from
 *  packages/session-ui/src/v2/components/prompt-input/index.tsx: same row
 *  classes, same trailingControl slot wrapper (mr-1 = the 4px grid), and the
 *  REAL send button — the bug glyph must read as its immediate left neighbor. */
function ComposerRowMock() {
  return (
    <div class="w-full max-w-[640px] rounded-xl border border-v2-border-border-base bg-v2-background-bg-base shadow-[var(--v2-elevation-raised)]">
      <div class="flex h-11 items-center px-2">
        <div class="flex min-w-0 flex-1 items-center gap-1">
          <IconButtonV2
            type="button"
            variant="ghost-muted"
            size="large"
            icon={<IconV2 name="plus" />}
            aria-label="Add images and files"
          />
        </div>
        {/* the session-ui trailingControl slot renders exactly this wrapper */}
        <div class="mr-1 flex items-center">
          <ReportBugButton />
        </div>
        <PromptInputV2SubmitButton
          mode="normal"
          stopping={false}
          disabled={false}
          sendLabel="Send"
          stopLabel="Stop"
          onSubmit={() => {}}
          onStop={() => {}}
        />
      </div>
    </div>
  )
}

export default {
  title: "App/ReportBugButton",
  id: "app-report-bug-button",
  component: ReportBugButton,
  parameters: {
    docs: {
      description: {
        component: `### Overview
Report-a-bug button for the v2 composer's bottom control row (amicode/opencode#116).

- Renders only when the extension passes the \`amicode_bug_report=1\` boot param — the gate lives in \`PromptInputV2Composer\`, which passes \`undefined\` to the composer's \`trailingControl\` slot when off, so the row's layout never shifts.
- Click posts \`amicode.reportBug\` over the app↔extension bridge — or reveals/re-expands the open bug dock (slice #117) via the \`bugDock\` seam, posting nothing.
- Color is the semantic danger token (\`--v2-state-fg-danger\`: red-800 light / red-500 dark) — muted at rest, full on hover. Yellow stays the only accent.

### States
default · hover · active · focus-visible (2px \`--v2-border-border-focus\` ring) · disabled — forced via the \`state\` prop / the real \`disabled\` attribute below.`,
      },
    },
  },
}

export const InComposerRow = {
  render: () => (
    <div style={{ display: "grid", gap: "12px" }}>
      <span style={{ "font-size": "12px", color: "var(--v2-text-text-muted)" }}>
        Right-anchored, immediately left of the send button — 28×28, 16px glyph, 4px from send.
      </span>
      <ComposerRowMock />
    </div>
  ),
}

export const States = {
  render: () => <StateMatrix />,
}

export const Schemes = {
  render: () => (
    <div style={{ display: "flex", gap: "16px", "align-items": "flex-start" }}>
      <For each={["light", "dark"] as const}>
        {(scheme) => (
          <div
            style={{
              ...schemeVars(scheme),
              display: "grid",
              gap: "12px",
              padding: "16px",
              "border-radius": "12px",
              background: "var(--v2-background-bg-base)",
              border: "1px solid var(--v2-border-border-base)",
            }}
          >
            <span style={{ "font-size": "12px", color: "var(--v2-text-text-muted)", "text-transform": "capitalize" }}>
              {scheme}
            </span>
            <StateMatrix />
          </div>
        )}
      </For>
    </div>
  ),
}
