import * as path from "node:path";
import { Score } from "./loader";

// Compile a score into the injected-prompt section — "data-defined, prompt-executed"
// (spec §6). The heading is kept EXACTLY "## Pulse-designer interview" for score #0
// compatibility: the pulse-designer agent prompt in buildOpencodeConfigContent refers
// to that section by name. Pure and deterministic: same score → same string.

export function compileScore(score: Score): string {
  const m = score.manifest;
  const lines: string[] = [
    `## Pulse-designer interview`,
    "",
    `> Compiled from score \`${m.id}\` v${m.version} — \`SCORE.md\` is the source of truth; do not edit this section by hand.`,
    "",
    "**Interview contract:** ONE question at a time — never batch. Ask, wait, record,",
    "advance. Questions with an options list go through `amicode_ask` (options in the",
    "given order, default first and marked \"(recommended)\"); free-form questions stay",
    "plain text. A stage marked *(optional)* may be skipped. A stage with a gate must",
    "not be entered until the gate's checks pass.",
    "",
    "### Stages (in order)",
    "",
  ];
  m.stages.forEach((s, i) => {
    const flags = [s.optional ? "(optional)" : "", s.gate ? `🔒 gate: ${s.gate} — checks must pass before entering` : ""]
      .filter(Boolean)
      .join(" ");
    lines.push(`${i + 1}. **${s.id}**${flags ? " " + flags : ""}`);
    if (s.emits?.length) lines.push(`   - emits: ${s.emits.join(", ")} — record via the matching \`amicode_*\` tool`);
    if (s.executor) lines.push(`   - executor: \`${s.executor}\``);
    if (s.template) lines.push(`   - vetted template (absolute): \`${path.join(score.dir, s.template)}\``);
    for (const q of s.questions ?? []) {
      const choices = q.choices
        ? ` — options: ${q.choices.map((c) => (c === q.default ? `${c} (recommended)` : c)).join(" | ")}`
        : q.default
          ? ` — default: ${q.default}`
          : "";
      lines.push(`   - Q \`${q.id}\`: "${q.prompt}"${choices}`);
      if (q.skip_if) lines.push(`     - skip if: ${q.skip_if}`);
      if (q.memory_hooks?.length) lines.push(`     - [Why?] hooks: ${q.memory_hooks.join(", ")} (read \`scores/memory/<hook>.md\` on request)`);
    }
  });
  lines.push("", "---", "", score.body.trim(), "");
  return lines.join("\n");
}

// Replace the "## Pulse-designer interview" section (through the next h2) with the
// compiled content, prefixed by the router section. If the heading is missing the
// compiled content is appended — the injection must never lose content.
export function spliceIntoAgentsMd(agentsMd: string, routerSection: string, compiledScore: string): string {
  const block = `${routerSection}\n\n${compiledScore}`;
  const start = agentsMd.indexOf("## Pulse-designer interview");
  if (start === -1) return `${agentsMd}\n\n${block}`;
  const rest = agentsMd.slice(start + 1);
  const nextH2 = rest.search(/\n## /);
  const end = nextH2 === -1 ? agentsMd.length : start + 1 + nextH2 + 1;
  return agentsMd.slice(0, start) + block + "\n" + agentsMd.slice(end);
}
