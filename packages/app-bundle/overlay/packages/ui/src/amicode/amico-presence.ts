// AMICODE: the Amico "presence" state machine — the shared brain the entity rail
// and the message flow both read so they can't drift out of sync (spec
// spec-20260712-014749-amico-third-actor). Amico is a third actor: it pops IN
// when a turn enters its domain, works, and pops OUT — leaving the transcript
// clean and its artifacts settled in the rail.
//
// Pure + DOM-free so it's unit-testable. Two pieces:
//   classifyPresence() — the STABLE state from a snapshot of turn signals.
//   transitionFor()    — the transient pop-in / pop-out treatment to play when
//                        the stable state changes (STEPPING_IN / SETTLING).
// The component holds the previous stable state, computes the next via
// classify(), plays any transient via transitionFor(), then rests at next.

export type PresenceState = "dormant" | "stepping_in" | "on" | "settling" | "idle"

/** The transient (animated) states, distinct from the three stable ones. */
export type PresenceTransition = "stepping_in" | "settling"

/** The three stable states a snapshot can resolve to (transients are played
 *  between them by the component, driven by transitionFor). */
export type StablePresence = "dormant" | "on" | "idle"

export interface PresenceSignals {
  /** Has this session EVER engaged Amico? (any amicode_* part seen — mirrors the
   *  rail's session-sticky `amicodeParts().any > 0`.) Distinguishes DORMANT
   *  (rail absent) from IDLE (rail persists with settled entities). */
  everEngaged: boolean
  /** Does the CURRENT turn carry an amicode_* part? The only in-domain signal
   *  observable in the UI today (spec §Domain trigger). */
  inDomainTurn: boolean
  /** Is the current turn still streaming/working? */
  working: boolean
}

/**
 * Stable presence from a snapshot of signals.
 * - in-domain & working            -> "on"    (rail live, thinking line in flow)
 * - engaged this session, else off -> "idle"  (rail persists, quiet)
 * - never engaged                  -> "dormant"(rail absent; just user + chat)
 *
 * A resolved in-domain turn (inDomainTurn && !working) is engaged-but-not-working
 * => "idle"; the ON->IDLE change is what makes transitionFor emit "settling".
 */
export function classifyPresence(signals: PresenceSignals): StablePresence {
  if (signals.inDomainTurn && signals.working) return "on"
  return signals.everEngaged ? "idle" : "dormant"
}

/**
 * The transient to play when the stable state changes:
 * - (dormant|idle) -> on   => "stepping_in"  (Amico pops in: rail wakes, presence leans in)
 * - on -> (idle|dormant)   => "settling"     (Amico pops out: liveness recedes, artifacts settle)
 * - anything else          => null           (no pop; e.g. dormant<->idle is silent)
 */
export function transitionFor(prev: StablePresence, next: StablePresence): PresenceTransition | null {
  if (prev !== "on" && next === "on") return "stepping_in"
  if (prev === "on" && next !== "on") return "settling"
  return null
}

/** True while the rail should be shown at all (i.e. the session has engaged, or
 *  is engaging now). DORMANT is the only state with no rail. */
export function railVisible(state: PresenceState): boolean {
  return state !== "dormant"
}

/** True while Amico's live working presence (the thinking line) belongs in the
 *  flow — only in the ON (and its lead-in STEPPING_IN) states. */
export function showsWorkingPresence(state: PresenceState): boolean {
  return state === "on" || state === "stepping_in"
}
