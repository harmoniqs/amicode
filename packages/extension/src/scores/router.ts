import { Score } from "./loader";

// The onset router — a meta question-tree over the visible repertoire (spec §5).
// Pure: the caller filters by entitlement first. The returning-user branch is
// STATE-AWARE BY INSTRUCTION: the live stack state (amicode_context plugin)
// carries the active problem, the campaign-ledger pointer, and the fleet line,
// and the model composes the actual option list from it — this text pins the
// shape and the question-tool mandate, not the per-user content.

export function buildRouterSection(visible: Score[]): string {
  const lines: string[] = [
    "## Onset router",
    "",
    'When a session opens with an explicit onboarding request ("Let\'s begin',
    'onboarding", "begin onboarding", "start onboarding", or similar), **skip this',
    "router entirely** and go straight into the overture — the user has already chosen.",
    "",
    "Otherwise, when a session opens without a specific request (a greeting, \"who are",
    "you?\", \"what is this?\"), do NOT default to any interview — build the moment",
    "from the live state. After your one-line Amico intro (name from the profile when",
    "one is recorded), ask exactly ONE question — \"What do you want to do today?\" —",
    "via the native `question` tool, composing the options from what the live state",
    "actually shows:",
    "",
    "- **Resume the active problem** — ONLY when the stack state shows one; name it and where it stands (system ✓ / formulation ✓ / mid-solve).",
    "- **Resume your research campaign** — ONLY when a session ledger exists under the personal vault's `sessions/`; the autoresearch director re-reads the latest ledger and continues the loop.",
    "- **Design a new pulse** — invoke the `design-a-pulse` skill for the guided interview (platform → model → formulation → solve).",
    "- **Fleet & studio ops** — ONLY when fleet state is present; status digest, sync rituals, healthcheck.",
    "- **Bring your own problem** — papers, notes, or a graph file; extract candidate entities, confirm each one before recording, then join the best-matching workflow.",
    "- **Just explore** — free-form; no rail.",
    "",
  ];
  if (visible.length > 0) {
    const cards = visible.filter((s) => s.manifest.id !== "pulse-designer" && s.manifest.id !== "overture");
    if (cards.length > 0) {
      lines.push(
        "First run (no profile recorded): replace the two resume options and the",
        "fleet option with the application entry cards:",
        "",
      );
      for (const s of cards) {
        const m = s.manifest;
        const badge = m.device ? (m.device.qpu_runnable ? "QPU-runnable" : "emulator-only") : "";
        const bits = [m.outcome, m.duration_estimate, badge].filter(Boolean).join(" · ");
        lines.push(`- \`${m.id}\` — **${m.name}**: ${bits}`);
      }
      lines.push("");
    }
  }
  lines.push(
    "Never a dead end: if nothing usable is found for an option, say so and offer",
    "the others. If candidates match multiple paths equally, ask — never route by",
    "silent heuristic. A user who opens with a specific ask (\"X gate, 10 ns,",
    "defaults\") skips the question entirely and gets straight to it.",
  );
  return lines.join("\n");
}
