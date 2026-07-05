/** The personalized splice (spec-20260705-002847 §6): two lean sections built
 *  from the vault's user-memory files. Both are ≤~3 KB by construction (profile
 *  capped at ~30 lines by convention, knowledge lines capped at 50 by the
 *  reader); the agent reads full cards on demand from the granted vault path. */

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
