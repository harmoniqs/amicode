// AMICODE: pure stage-label helper for amicode_* tool parts. Kept JSX-free so
// it is directly testable under `bun test`. The v0 rail-routing + prose-regex
// chip parsing (railStage / chipTextFromSummary) were DELETED in spec B — the
// rail is now endpoint-bound (./problem.ts) and receipts parse the
// AMICODE_DIFF sentinel (./receipt.ts). amicodeStage remains as the card's
// fallback label for parts with no parseable sentinel.

const STAGES: Record<string, string> = {
  amicode_pick_system: "System",
  amicode_set_model: "Model",
  amicode_formulate: "Formulation",
  amicode_solve: "Run",
}

export function amicodeStage(tool: string) {
  const known = STAGES[tool]
  if (known) return known
  const raw = tool.replace(/^amicode_/, "").replaceAll("_", " ")
  return raw ? raw.charAt(0).toUpperCase() + raw.slice(1) : tool
}
