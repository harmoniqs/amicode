// AMICODE: approval-card logic (spec-20260727-164748 §9.5). Pure — no transport,
// no rendering — mirroring ./ask.ts beside ./ask-card.tsx and ./ask-bridge.ts.
//
// A capability warrant is what lets a gated launch through amico-run's --spec gate.
// The card is where a human mints one. Two properties are inherited from the ask
// card deliberately, and one is deliberately NOT:
//
//   INHERITED — the read-only interlock. ask-bridge renders buttons disabled when
//   no bridge is registered ("questions never submit from read-only surfaces"), so
//   an approval is non-actionable on a share page or headless host by construction
//   rather than by a check someone has to remember.
//
//   INHERITED — state derived from the durable log, never stored in the UI. The ask
//   card computes answered-ness from message order (hasUserReplyAfter) instead of
//   holding a flag, which makes it replay-correct. Here the durable log is the
//   ledger: the card's state is a function of the approval records that exist.
//
//   NOT INHERITED — the transport. The ask card submits the chosen option as the
//   user's next CHAT MESSAGE. An approval delivered that way would be interpreted
//   by the agent, which would then write the ledger row, making the provenance read
//   "the agent says the user approved". Approvals go straight to the ledger via
//   ./approval-bridge.ts (→ `amico ledger approve`).

/** Reads an approval request from the tool part's INPUT args, mirroring
 *  parseAskInput — the ask card's pattern, not a sentinel, because the request is
 *  the agent's ASK rather than a record of something that happened.
 *
 *  Tolerant in the same way: anything unusable → undefined, and the caller falls
 *  back to the collapsed chip. But NOT tolerant about bounds: an unparseable bound
 *  is DROPPED rather than guessed, because a bound the card displays and the gate
 *  does not enforce (or vice versa) is worse than an absent one. */
export function parseApprovalInput(input: unknown): ApprovalRequest | undefined {
  if (typeof input !== "object" || input === null) return undefined
  const raw = input as Record<string, unknown>
  const planHash = raw.plan_hash
  if (typeof planHash !== "string" || planHash.trim().length === 0) return undefined

  const bounds: WarrantBounds = {}
  const b = typeof raw.bounds === "object" && raw.bounds !== null ? (raw.bounds as Record<string, unknown>) : {}

  if (typeof b.max_solves === "number" && Number.isInteger(b.max_solves) && b.max_solves >= 1)
    bounds.max_solves = b.max_solves
  if (typeof b.tier === "string" && b.tier.trim().length > 0) bounds.tier = b.tier.trim()
  if (b.max_size_class === "SMALL" || b.max_size_class === "MEDIUM") bounds.max_size_class = b.max_size_class
  if (b.device === "none" || b.device === "ro" || b.device === "rw") bounds.device = b.device

  const rationale = typeof raw.rationale === "string" && raw.rationale.trim().length > 0 ? raw.rationale.trim() : undefined
  return { plan_hash: planHash.trim(), bounds, ...(rationale ? { rationale } : {}) }
}

/** What a warrant may authorise — the fleet spec §2.1 vocabulary for `device`. */
export interface WarrantBounds {
  max_solves?: number;
  tier?: string;
  max_size_class?: "SMALL" | "MEDIUM";
  device?: "none" | "ro" | "rw";
}

/** The agent's ask: "approve this plan, with these bounds, for this reason." */
export interface ApprovalRequest {
  plan_hash: string;
  bounds: WarrantBounds;
  rationale?: string;
}

/** An `approval` ledger row, as surfaced to the UI. */
export interface Warrant {
  plan_hash: string;
  bounds: WarrantBounds;
  expires_at: string;
  issued_by: string;
  /** `solve` rows recorded under this plan. OPTIONAL: absent on any surface that
   *  does not supply it, and the rail chip then omits the count rather than
   *  rendering a wrong "0 of 8". */
  solves_used?: number;
}

export type ApprovalState =
  /** No transport registered — share page, headless embed. Never actionable. */
  | { kind: "unavailable" }
  /** No live warrant for this plan. The one actionable state. */
  | { kind: "pending" }
  /** A live warrant exists. Locked; `warrant` carries what was ACTUALLY granted,
   *  which may be narrower than what was requested. */
  | { kind: "granted"; warrant: Warrant }
  /** A warrant existed and lapsed. Actionable again — re-approving is a new bet. */
  | { kind: "expired"; warrant: Warrant };

function expiryMs(w: Warrant): number {
  const t = Date.parse(w.expires_at);
  // An unparseable expiry is treated as ALREADY EXPIRED: a warrant whose lifetime
  // cannot be established must not read as live. Same fail-closed direction the
  // gate applies to an unresolved estimate (spec §4.4).
  return Number.isNaN(t) ? -Infinity : t;
}

/** The newest live warrant for `planHash`, else the newest lapsed one, else none. */
export function warrantFor(planHash: string, warrants: readonly Warrant[], now: number): Warrant | undefined {
  let live: Warrant | undefined;
  let lapsed: Warrant | undefined;
  for (const w of warrants) {
    if (w.plan_hash !== planHash) continue;
    const exp = expiryMs(w);
    if (exp > now) {
      if (!live || exp > expiryMs(live)) live = w;
    } else if (!lapsed || exp > expiryMs(lapsed)) lapsed = w;
  }
  return live ?? lapsed;
}

/** Derive the card's state. Deliberately does NOT check whether the warrant's
 *  bounds COVER the request — that verdict belongs to the gate (spec §5.1 rule 2),
 *  and a card that second-guessed it would either contradict the gate or imply an
 *  authority it does not have. The card reports what was granted; the gate decides
 *  what that permits. */
export function approvalState(
  request: ApprovalRequest,
  warrants: readonly Warrant[],
  now: number,
  hasBridge: boolean,
): ApprovalState {
  if (!hasBridge) return { kind: "unavailable" };
  const w = warrantFor(request.plan_hash, warrants, now);
  if (!w) return { kind: "pending" };
  return expiryMs(w) > now ? { kind: "granted", warrant: w } : { kind: "expired", warrant: w };
}

/** True when the approve control may be pressed. */
export function isActionable(state: ApprovalState): boolean {
  return state.kind === "pending" || state.kind === "expired";
}

/** One-line summary of bounds for the card and the rail. Renders only DECLARED
 *  bounds — an absent bound is not "unlimited" (the gate refuses a launch needing a
 *  bound the warrant omits), so inventing a word for absence would mislead. */
export function boundsText(bounds: WarrantBounds): string {
  const parts: string[] = [];
  if (bounds.max_solves !== undefined) parts.push(`${bounds.max_solves} solve${bounds.max_solves === 1 ? "" : "s"}`);
  if (bounds.tier !== undefined) parts.push(`tier ${bounds.tier}`);
  if (bounds.max_size_class !== undefined) parts.push(`up to ${bounds.max_size_class}`);
  if (bounds.device !== undefined) parts.push(`device ${bounds.device}`);
  return parts.length ? parts.join(" · ") : "no bounds declared";
}

/** Rail chip for the ACTIVE warrant (spec §9.6, G-6): remaining budget at a glance,
 *  so a researcher mid-campaign does not have to open anything to see how much
 *  authorization is left.
 *
 *  Returns undefined when there is nothing true to say — no live warrant, or a live
 *  one that declares no bounds. A chip reading "warranted" with no bounds behind it
 *  would imply an authorization the gate does not actually grant (§5.1 rule 2
 *  refuses a launch needing a bound the warrant omits), so silence is correct.
 *
 *  Deliberately shows CONSUMPTION, not permission: "3 of 8 solves" is a fact from
 *  the ledger. It never says whether the next launch will pass — that is the gate's
 *  verdict, and the same reason the card carries no coverage claim. */
export function railWarrantChip(warrants: readonly Warrant[], now: number): string | undefined {
  // The live warrant expiring latest — the one a launch would actually be checked
  // against, matching liveWarrant() in amico-run's warrant.ts.
  let best: Warrant | undefined
  for (const w of warrants) {
    if (expiryMs(w) <= now) continue
    if (!best || expiryMs(w) > expiryMs(best)) best = w
  }
  if (!best) return undefined

  const parts: string[] = []
  if (best.bounds.max_solves !== undefined) {
    const used = best.solves_used
    parts.push(used === undefined ? `${best.bounds.max_solves} solves` : `${used} of ${best.bounds.max_solves} solves`)
  }
  if (best.bounds.tier !== undefined) parts.push(`tier ${best.bounds.tier}`)
  if (best.bounds.max_size_class !== undefined) parts.push(`up to ${best.bounds.max_size_class}`)
  if (best.bounds.device !== undefined) parts.push(`device ${best.bounds.device}`)
  return parts.length ? parts.join(" · ") : undefined
}
