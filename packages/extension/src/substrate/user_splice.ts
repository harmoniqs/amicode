/** The personalized splice (spec-20260705-002847 §6): two lean sections built
 *  from the vault's user-memory files. Both are ≤~3 KB by construction (profile
 *  capped at ~30 lines by convention, knowledge lines capped at 50 by the
 *  reader); the agent reads full cards on demand from the granted vault path.
 *
 *  The mount-stack + memory-index sections (spec-20260707-002846 C3/C4 read
 *  side) live here too — same "build a lean section, splice on demand" shape. */
import type { MountStack } from "./mount_store";

export function buildAboutUserSection(profileMd: string): string {
  if (!profileMd) return "";
  return [
    "## About this user",
    "",
    profileMd.trim(),
    "",
    "Greet and recommend with this context. Anchor the hardware stage on the",
    "user's environment card (read it from the vault path above when you reach",
    "that stage). Never re-ask what the profile already answers.",
  ].join("\n");
}

export function buildReferenceDemosSection(demoLines: string[]): string {
  if (demoLines.length === 0) return "";
  return [
    "## Reference demos",
    "",
    ...demoLines,
    "",
    "Curated demos we've built — use them as PRECEDENT (medium confidence) when",
    "the user's target matches one and there's no own-precedent card. Read the",
    "demo card on demand for its params, and cite it in your recommendation.",
  ].join("\n");
}

/** The Armonia mount stack, top→bottom in read precedence, plus a condensed
 *  static block mirroring the amico-vault skill's "Mounts & resolution" (so the
 *  agent knows how reads union and how writes route without loading the skill).
 *  Empty stack → "" (no mounts discovered ⇒ nothing to say). Parity oracle: the
 *  session-start hook's rendered "Mount stack" block. */
export function buildMountStackSection(stack: MountStack): string {
  if (stack.mounts.length === 0) return "";
  const mountLines = stack.mounts.map(
    (m) => `- ${m.name} · kind=${m.kind} · ${m.writable ? "rw" : "ro"} · ${m.path}`,
  );
  const warnLines = stack.warnings.map((w) => `- ⚠ ${w}`);
  return [
    "## Mount stack (Armonia — read precedence top→bottom)",
    "",
    ...mountLines,
    ...warnLines,
    "",
    "Resolution & write-routing (condensed from the amico-vault skill):",
    "- Reads union across all mounts; on the same relative path the first hit",
    "  top→bottom wins (higher-precedence mount shadows lower).",
    "- Writes route by intent to the first WRITABLE mount of that kind:",
    "  personal→personal, engagement→engagement, project→project,",
    "  restricted/team/public→their own kind.",
    "- If the target mount is absent or read-only, write to the personal mount",
    "  and stamp `route_intent: <kind>` in the note frontmatter — never silently",
    "  drop a write, never write a ro mount.",
    "- Ambiguous intent: ask once, else default to personal.",
  ].join("\n");
}

/** The typed-memory index (spec-20260707-002846 C4 read side): the one-line
 *  pointers from `amicode/memory/MEMORY.md`. Only the index is spliced; the full
 *  typed cards load on demand from the granted vault path. No lines → "". */
export function buildMemoryIndexSection(memoryIndexLines: string[]): string {
  if (memoryIndexLines.length === 0) return "";
  return [
    "## Memory index",
    "",
    ...memoryIndexLines,
    "",
    "These are one-line pointers. The full typed-memory cards (user / feedback /",
    "project / reference) load on demand from the granted vault path under",
    "`amicode/memory/` — read a card only when its hook is relevant to the turn.",
  ].join("\n");
}

export function buildRecentProblemsSection(knowledgeLines: string[]): string {
  if (knowledgeLines.length === 0) return "";
  return [
    "## Your recent problems",
    "",
    ...knowledgeLines,
    "",
    "Before recommending parameters, check whether the user's target matches one",
    "of these cards (read the card file on demand for details). If a pulse exists",
    "in the bank, offer a warm start from its `pulse.jld2` path. If a prior",
    "attempt failed, surface its lesson before re-authoring.",
  ].join("\n");
}
