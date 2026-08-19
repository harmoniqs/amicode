// Handoff routing — Stage 8 intent-based routing (#438)
//
// Pure routing logic for the onboarding handoff: given the user's intent
// selections from Stage 2, determines the correct next experience.

// ─── Types ───────────────────────────────────────────────────────────────────

export type IntentSlug = "research" | "general_coding" | "exploring";

export type HandoffAction =
  | "pulse-designer"     // Research selected → guided pulse-designer interview
  | "normal-session"     // General coding only → open session, highlight memory + vault
  | "tour-session"       // Exploring only → open session with brief tour offer
  | "pulse-designer-plus"; // Research + General coding → pulse-designer with broader studio mention

// ─── Routing table (pure, testable) ──────────────────────────────────────────

/** Given the user's intent selections, determine the handoff action.
 *  Research takes priority when combined with other selections. */
export function resolveHandoffAction(intents: IntentSlug[]): HandoffAction {
  const hasResearch = intents.includes("research");
  const hasGeneral = intents.includes("general_coding");
  const hasExploring = intents.includes("exploring");

  // Research always routes to pulse-designer (possibly with broader mention)
  if (hasResearch && hasGeneral) return "pulse-designer-plus";
  if (hasResearch && hasExploring) return "pulse-designer";
  if (hasResearch) return "pulse-designer";

  // General coding only
  if (hasGeneral && hasExploring) return "normal-session";
  if (hasGeneral) return "normal-session";

  // Exploring only
  if (hasExploring) return "tour-session";

  // Fallback (empty or unknown) — safe default
  return "normal-session";
}

// ─── Pre-fill resolution ─────────────────────────────────────────────────────

export interface SeedState {
  environment?: { slug?: string; archetype?: string };
  device?: { name?: string; platform?: string };
}

export interface PreFillResult {
  /** If non-null, show confirmation prompt with this value. If null, ask fresh. */
  environmentSeed: string | null;
  /** If non-null, show confirmation prompt. If null, ask fresh or skip. */
  deviceSeed: string | null;
}

/** Given the current onboarding state (from readOnboardingState), determine
 *  what pre-fill values to offer for Stages 5-6. */
export function resolvePreFills(state: SeedState): PreFillResult {
  let environmentSeed: string | null = null;
  let deviceSeed: string | null = null;

  if (state.environment?.archetype || state.environment?.slug) {
    environmentSeed = state.environment.archetype ?? state.environment.slug ?? null;
  }

  if (state.device?.name) {
    deviceSeed = state.device.name;
    if (state.device.platform) {
      deviceSeed += ` (${state.device.platform})`;
    }
  }

  return { environmentSeed, deviceSeed };
}

// ─── Intent reading from events stream ───────────────────────────────────────

/** Read the intent selections from the onboarding state's profile entity.
 *  Returns the intent array or an empty array if not yet recorded. */
export function readIntentFromState(
  profileState: Record<string, unknown> | undefined,
): IntentSlug[] {
  if (!profileState) return [];
  const intent = profileState.intent;
  if (!Array.isArray(intent)) return [];
  return intent.filter((i): i is IntentSlug =>
    typeof i === "string" && ["research", "general_coding", "exploring"].includes(i),
  );
}
