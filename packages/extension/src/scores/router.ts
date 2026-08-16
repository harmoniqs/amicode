import { Score } from "./loader";

// The onset router — a meta question-tree over the visible repertoire (spec §5).
// Pure: the caller filters by entitlement first. Score #0 (pulse-designer) renders
// as the fixed "Start from a system" option, never as an application entry card.
const SYSTEM_FIRST_SCORE = "pulse-designer";

export function buildRouterSection(visible: Score[]): string {
  const cards = visible.filter((s) => s.manifest.id !== SYSTEM_FIRST_SCORE);
  const lines: string[] = [
    "## Onset router",
    "",
    "When a session opens without a specific request, after your one-line Amico",
    'intro ask exactly one question — "What do you want to do today?" — via the',
    "native `question` tool, with these options:",
    "",
  ];
  if (cards.length > 0) {
    lines.push("**Start from an application** — offer these entry cards:", "");
    for (const s of cards) {
      const m = s.manifest;
      const badge = m.device ? (m.device.qpu_runnable ? "QPU-runnable" : "emulator-only") : "";
      const bits = [m.outcome, m.duration_estimate, badge].filter(Boolean).join(" · ");
      lines.push(`- \`${m.id}\` — **${m.name}**: ${bits}`);
    }
    lines.push("");
  }
  lines.push(
    `**Start from a system** — run the pack's \`${SYSTEM_FIRST_SCORE}\` onboarding interview (the platform-first interview below); it is one path among these, not the spine.`,
    "",
    "**Bring your own problem** — the user has papers, notes, or a graph file;",
    "extract candidate entities, confirm each one before recording, then join the",
    "best-matching score mid-path. If nothing usable is found, say so and offer",
    "the other options — never a dead end. If candidates match multiple scores",
    "equally, ask; never route by silent heuristic.",
    "",
    "**Resume where you left off** — read the session's interview state and",
    "continue from its stage cursor.",
    "",
    "**Just explore** — free-form; no interview rail.",
  );
  return lines.join("\n");
}
