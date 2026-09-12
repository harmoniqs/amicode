// @ts-nocheck
// Visual check for the receipt-run collapse (../receipt-runs.ts): a run of
// consecutive amicode_* receipts sharing (problem, entity, action) renders as
// ONE card with a count instead of N identical-looking ones. Real user report:
// "these repeated amico cards add a lot of clutter can we avoid this?" — see
// message-part.tsx's collapseAmicodeGroups for the wiring; this story exercises
// AmicodeToolCard directly (the count prop it now accepts) rather than the full
// message list, so the collapsed card's rendering is reviewable in isolation.
import { AmicodeToolCard } from "./card"

export default {
  title: "Amicode/ToolCard",
  id: "amicode-tool-card",
  tags: ["autodocs"],
  parameters: {
    docs: {
      description: {
        component: `### Collapsed receipt runs

Four \`amicode_*\` calls that update the same entity via the same action used to
render four visually-identical cards. A run of consecutive receipts sharing
(problem, entity, action) now collapses into one card carrying a \`×N\` count,
opening the latest (highest-seq) member. A run of one renders exactly as
before — no count shown. A differing action, entity, or problem never
collapses, so a state change is never hidden.`,
      },
    },
  },
}

const sentinel = (over: Record<string, unknown>) =>
  `AMICODE_DIFF ${JSON.stringify({ problem: "x-gate", entity: "recommend", action: "proposed", seq: 1, diff: {}, ...over })}`

const Row = (props: { label: string; children: any }) => (
  <div style={{ display: "flex", "flex-direction": "column", gap: "6px", "margin-bottom": "20px" }}>
    <span style={{ "font-size": "11px", color: "var(--v2-text-text-faint)", "letter-spacing": "0.04em" }}>
      {props.label}
    </span>
    <div style={{ display: "flex", "align-items": "flex-start", gap: "12px", "flex-wrap": "wrap" }}>
      {props.children}
    </div>
  </div>
)

// A run of 4 identical (problem, entity, action) receipts — what the bug
// report showed as four stacked cards — now collapses to one, count 4,
// opening seq 4 (the latest).
export const CollapsedRunOfFour = () => (
  <Row label="Before: 4 identical amicode_recommend cards → After: 1 card, ×4">
    <AmicodeToolCard
      tool="amicode_recommend"
      status="completed"
      count={4}
      output={sentinel({ seq: 4, diff: { pulse_shape: { from: null, to: "gaussian" } } })}
    />
  </Row>
)

// A run of one renders exactly as it always has — no count, no markup change.
export const SingleReceipt = () => (
  <Row label="A run of 1 — unchanged, no count badge">
    <AmicodeToolCard
      tool="amicode_recommend"
      status="completed"
      output={sentinel({ seq: 1, diff: { pulse_shape: { from: null, to: "gaussian" } } })}
    />
  </Row>
)

// Two adjacent runs whose action differs never merge with each other — each
// renders as its own card (here, each itself a collapsed run of 2).
export const AdjacentRunsDifferentActions = () => (
  <Row label="Adjacent runs, differing action — never merged into each other">
    <AmicodeToolCard
      tool="amicode_recommend"
      status="completed"
      count={2}
      output={sentinel({ action: "proposed", seq: 2, diff: { pulse_shape: { from: null, to: "gaussian" } } })}
    />
    <AmicodeToolCard
      tool="amicode_recommend"
      status="completed"
      count={3}
      output={sentinel({ action: "gated", seq: 5, diff: { gate_score: { from: 0.6, to: 0.91 } } })}
    />
  </Row>
)

// Side-by-side comparison, matching the report's stacked-card shape but with
// the fix applied: the repeated "Recommend" run collapses; the differently-
// actioned "Formulation" card beside it (a run of 1) is untouched.
export const StackedTranscriptExample = () => (
  <div style={{ display: "flex", "flex-direction": "column", gap: "8px", "align-items": "flex-start" }}>
    <AmicodeToolCard
      tool="amicode_recommend"
      status="completed"
      count={4}
      output={sentinel({ seq: 4, diff: { pulse_shape: { from: null, to: "gaussian" } } })}
    />
    <AmicodeToolCard
      tool="amicode_formulate"
      status="completed"
      output={`AMICODE_DIFF ${JSON.stringify({ problem: "x-gate", entity: "formulation", action: "gate", seq: 5, diff: {} })}`}
    />
  </div>
)
