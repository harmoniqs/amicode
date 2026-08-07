import * as path from "node:path";
import { Score } from "./loader";
import { ScoreManifest, Stage } from "./schema";

// Compile a score into the injected-prompt section — "data-defined, prompt-executed"
// (spec §6). The heading is kept EXACTLY "## Pulse-designer interview" for score #0
// compatibility: the pulse-designer agent prompt in buildOpencodeConfigContent refers
// to that section by name. Pure and deterministic: same score → same string.

const INTERVIEW_CONTRACT = [
  "**Interview contract:** ONE question at a time — never batch. Ask, wait, record,",
  "advance. Every question is a card, asked through the native `question` tool —",
  "never prose. Choice questions list their options in the given order, default",
  'first and marked "(recommended)"; free-form questions take text: call `question`',
  'with `kind: "text"` for a bare text input with no option list. A stage marked',
  "*(optional)* may be skipped. A stage with a gate must not be entered until the",
  "gate's checks pass.",
];

/** Render one score's stages as numbered markdown, resolving template paths
 *  against THAT score's dir. `start` offsets the numbering for chained scores. */
function renderStages(stages: Stage[], dir: string, start: number): string[] {
  const lines: string[] = [];
  stages.forEach((s, i) => {
    const flags = [
      s.optional ? "(optional)" : "",
      s.gate ? `🔒 gate: ${s.gate} — checks must pass before entering` : "",
    ]
      .filter(Boolean)
      .join(" ");
    lines.push(`${start + i + 1}. **${s.id}**${flags ? " " + flags : ""}`);
    if (s.emits?.length) lines.push(`   - emits: ${s.emits.join(", ")} — record via the matching \`amicode_*\` tool`);
    if (s.executor) lines.push(`   - executor: \`${s.executor}\``);
    if (s.template) lines.push(`   - vetted template (absolute): \`${path.join(dir, s.template)}\``);
    for (const q of s.questions ?? []) {
      const choices = q.choices
        ? ` — options: ${q.choices.map((c) => (c === q.default ? `${c} (recommended)` : c)).join(" | ")}`
        : q.default
          ? ` — default: ${q.default}`
          : "";
      lines.push(`   - Q \`${q.id}\`: "${q.prompt}"${choices}`);
      if (q.skip_if) lines.push(`     - skip if: ${q.skip_if}`);
      if (q.memory_hooks?.length)
        lines.push(`     - [Why?] hooks: ${q.memory_hooks.join(", ")} (read \`scores/memory/<hook>.md\` on request)`);
    }
  });
  return lines;
}

export function compileScore(score: Score): string {
  const m = score.manifest;
  const lines: string[] = [
    `## Pulse-designer interview`,
    "",
    `> Compiled from score \`${m.id}\` v${m.version} — \`SCORE.md\` is the source of truth; do not edit this section by hand.`,
    "",
    ...INTERVIEW_CONTRACT,
    "",
    "### Stages (in order)",
    "",
    ...renderStages(m.stages, score.dir, 0),
  ];
  lines.push("", "---", "", score.body.trim(), "");
  return lines.join("\n");
}

/** Chain an onboarding score into a tail score (spec-20260705-002847 §3 stage 6):
 *  ONE compiled section, so the boot-time score0 mechanism and the stage guard
 *  work unmodified. Overture stages (no `emits`) are guard-transparent; the tail
 *  (pulse-designer) stages follow, numbered continuously, with template paths
 *  resolved against the tail's own dir. Both bodies are included, the tail body
 *  after an explicit handoff marker. */
export function compileChainedScore(head: Score, tail: Score): string {
  const lines: string[] = [
    `## Pulse-designer interview`,
    "",
    `> Compiled from score \`${head.manifest.id}\` v${head.manifest.version} chained into ` +
      `\`${tail.manifest.id}\` v${tail.manifest.version} — first onboard the user (session zero), ` +
      `then continue straight into pulse design in the SAME session. Sources of truth are the two ` +
      `\`SCORE.md\` files; do not edit this section by hand.`,
    "",
    ...INTERVIEW_CONTRACT,
    "",
    "### Stages (in order)",
    "",
    ...renderStages(head.manifest.stages, head.dir, 0),
    ...renderStages(tail.manifest.stages, tail.dir, head.manifest.stages.length),
    "",
    "---",
    "",
    head.body.trim(),
    "",
    "---",
    "",
    "## After onboarding — continue into pulse design",
    "",
    "Once you have recorded `onboarding_completed` at the handoff stage, do NOT stop:",
    "flow directly into the pulse-design interview below, in this same session, using the",
    "user's just-recorded profile and environment to skip questions they've already",
    "answered.",
    "",
    tail.body.trim(),
    "",
  ];
  return lines.join("\n");
}

/** The merged manifest for the score_manifest.json transport (the guard reads
 *  `.manifest.stages`). Identity is the head score (id `overture`); stages are
 *  head ++ tail so the guard knows the full flow. */
export function chainManifest(head: Score, tail: Score): ScoreManifest {
  return { ...head.manifest, stages: [...head.manifest.stages, ...tail.manifest.stages] };
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
