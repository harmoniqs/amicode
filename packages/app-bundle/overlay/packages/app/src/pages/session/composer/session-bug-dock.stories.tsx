import { For } from "solid-js"
import { oc2Theme, resolveThemeVariantV2 } from "@opencode-ai/ui/theme"
import { BugDockView } from "@/pages/session/composer/session-bug-dock"
// The app entry loads design-polish.css globally; stories must pull it
// themselves (it owns the tokens the dock surface consumes).
import "@/design-polish.css"

// amicode/opencode#117: the bug-report dock — the composer dock family's
// bug-session surface. The interaction contract (expand/collapse animation,
// header affordances, the terminal end-state) is visual and lives here — the
// app has no component-render unit-test surface (Solid needs its compile-time
// transform), per the issue's Testing Decisions. Open/close/collapse/file
// behavior and the sentinel watcher are unit-tested in
// bug-dock-controller.test.ts.

/** The real oc-2 --v2-* token set for one color scheme, applied as inline
 *  custom properties — the SAME resolver the app runs at boot (the #116
 *  precedent; a naive data-color-scheme wrapper is a no-op in Storybook). */
function schemeVars(scheme: "light" | "dark"): Record<string, string> {
  const isDark = scheme === "dark"
  const tokens = resolveThemeVariantV2(isDark ? oc2Theme.dark : oc2Theme.light, isDark)
  const vars: Record<string, string> = {}
  for (const [key, value] of Object.entries(tokens)) vars[`--${key}`] = value
  return vars
}

const noop = () => {}


const STATES: { label: string; props: Parameters<typeof BugDockView>[0] }[] = [
  {
    label: "expanded — chat (idle)",
    props: {
      phase: "chat", collapsed: false, busy: false,
      agentText: "I reproduced it locally — the dock never opened on click. Drafting the report now…",
      answerText: "", answering: false,
      onAnswerChange: noop, onAnswerSubmit: noop, onToggle: noop, onClose: noop, onOpenLink: noop,
    },
  },
  {
    label: "expanded — chat (busy)",
    props: {
      phase: "chat", collapsed: false, busy: true,
      agentText: "Investigating the call stack…",
      answerText: "", answering: false,
      onAnswerChange: noop, onAnswerSubmit: noop, onToggle: noop, onClose: noop, onOpenLink: noop,
    },
  },
  {
    label: "collapsed",
    props: {
      phase: "chat", collapsed: true, busy: false,
      agentText: "What happened, and what did you expect?",
      answerText: "", answering: false,
      onAnswerChange: noop, onAnswerSubmit: noop, onToggle: noop, onClose: noop, onOpenLink: noop,
    },
  },
  {
    label: "filed — with link",
    props: {
      phase: "filed", collapsed: false, busy: false,
      filedUrl: "https://github.com/harmoniqs/amicode/issues/123",
      answerText: "", answering: false,
      onAnswerChange: noop, onAnswerSubmit: noop, onToggle: noop, onClose: noop, onOpenLink: noop,
    },
  },
  {
    label: "filed via browser",
    props: {
      phase: "filed", collapsed: false, busy: false,
      filedUrl: "filed-via-browser",
      answerText: "", answering: false,
      onAnswerChange: noop, onAnswerSubmit: noop, onToggle: noop, onClose: noop, onOpenLink: noop,
    },
  },
]


function StateMatrix() {
  return (
    <div style={{ display: "grid", gap: "16px", width: "560px", "max-width": "100%" }}>
      <For each={STATES}>
        {(item) => (
          <div style={{ display: "grid", gap: "6px" }}>
            <BugDockView {...item.props} />
            <span style={{ "font-size": "11px", color: "var(--v2-text-text-faint)" }}>{item.label}</span>
          </div>
        )}
      </For>
    </div>
  )
}

export default {
  title: "App/SessionBugDock",
  id: "app-session-bug-dock",
  component: BugDockView,
  parameters: {
    docs: {
      description: {
        component: `### Overview
The bug-report dock (amicode/opencode#117) — a member of the composer's dock family (todo / question / permission / revert), hosting the bug session in an iframe above the composer.

- Opens on the bridge \`open-bug-report {sessionID}\` down-message; renders only when the \`amicode_bug_report=1\` boot param is set (the #116 gate).
- Header: bug glyph in the semantic danger token (the #116 owner-sanctioned chrome exception), title, collapse chevron, close control — both icon buttons carry aria-labels + tooltips.
- **Chevron collapses and keeps the session alive** (spring-animated max-height, the family idiom; the iframe stays mounted). **Close posts \`bug-report-closed {sessionID}\`** and ends an unfiled session.
- The sentinel watcher matches \`^AMICODE_BUG_FILED\\s+(\\S+)\` in the hosted session's streamed text parts, posts \`bug-filed {sessionID, url}\` once, and switches the body to the terminal end-state (issue link) until the extension closes the dock.

### States
expanded (chat iframe) · collapsed · filed (issue link) · filed-via-browser (no link) — both color schemes below.`,
      },
    },
  },
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
              "border-radius": "var(--radius-lg)",
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
