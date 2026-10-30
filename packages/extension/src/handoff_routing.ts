// Handoff routing — post-onboarding handoff (#438, simplified by #1164)
//
// Pure routing logic for the onboarding handoff. The guided tutorial now lives
// inside onboarding, so every user exits the same way: a fresh working session.
// The recorded intent still lives in the profile (see readIntentFromState) and
// still informs recommendations elsewhere; it no longer branches the routing.

// ─── Types ───────────────────────────────────────────────────────────────────

export type IntentSlug = "research" | "general_coding" | "exploring";

/** The single post-onboarding exit: open a plain new session. */
export type HandoffAction = "normal-session";

// ─── Routing (pure, testable) ────────────────────────────────────────────────

/** Post-onboarding handoff. Always a normal new session, regardless of intent.
 *  `intents` is accepted so callers need not change; it is intentionally unused. */
export function resolveHandoffAction(_intents: IntentSlug[] = []): HandoffAction {
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
