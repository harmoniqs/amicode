import { Show, createMemo } from "solid-js"
import { amicodeApprovalBridge } from "./approval-bridge"
import { approvalState, boundsText, isActionable, type ApprovalRequest } from "./approval"

// AMICODE: the capability-warrant card for amicode_request_approval tool parts
// (spec-20260727-164748 §9.5). Structurally the ask card's sibling — request text
// plus one action — with three deliberate differences:
//
//   1. TRANSPORT. The ask card submits the chosen option as the user's next CHAT
//      MESSAGE. This one writes the ledger through ./approval-bridge.ts. If it went
//      through the chat, the agent would read the message and write the row itself,
//      leaving the ledger's only provenance reading "the agent says the user
//      approved". That is the whole reason the two bridges are separate.
//
//   2. STATE SOURCE. The ask card derives answered-ness from message order. This one
//      derives from the LEDGER — is there a live warrant for this plan_hash? — which
//      is equally replay-correct and survives a reload, and means the card cannot
//      disagree with what the gate will see.
//
//   3. NO COVERAGE VERDICT. The card never says whether the granted bounds are
//      enough; that is the gate's call (§5.1 rule 2). It shows what was requested
//      and, once granted, what was actually granted — which may be narrower. A card
//      that rendered "approved ✓" over a warrant the gate will still refuse would be
//      worse than no card.
//
// Display label is AMICO (persona); component/data-* identifiers stay amicode-*.
//
// NO AMICO MARK. The H-glyph came off every amicode chat surface on 2026-08-23 —
// receipt card, run window, ask card, and this one last. It survived the first
// three sweeps because it mounted as a bare glyph rather than through .amc-sig,
// so a class-based search never saw it. Unlike the receipt card's it never
// pulsed, so it carried none of that contrast problem; it went for consistency.
// "Approval needed" already names the surface, and at 13px the glyph resolves to
// a block rather than to a brand.

export function AmicodeApprovalCard(props: { request: ApprovalRequest }) {
  // No clock signal: the state recomputes on any bridge/warrant change, and an
  // expiry crossing while the card sits idle resolves on the next interaction
  // rather than needing a timer per card.
  const state = createMemo(() =>
    approvalState(props.request, amicodeApprovalBridge()?.warrants() ?? [], Date.now(), amicodeApprovalBridge() !== undefined),
  )
  const actionable = () => isActionable(state())

  const approve = () => {
    const bridge = amicodeApprovalBridge()
    if (!bridge || !actionable()) return
    bridge.approve(props.request)
  }

  const granted = () => {
    const s = state()
    return s.kind === "granted" || s.kind === "expired" ? s.warrant : undefined
  }

  return (
    <div data-component="amicode-approval-card" data-state={state().kind}>
      <div class="amc-ap-head">
        <span class="amc-ap-title">
          <Show when={state().kind === "granted"} fallback="Approval needed">
            Approved
          </Show>
        </span>
        <span class="amc-ap-plan" title={props.request.plan_hash}>
          {props.request.plan_hash}
        </span>
      </div>

      <Show when={props.request.rationale}>
        {(why) => <p class="amc-ap-why">{why()}</p>}
      </Show>

      <dl class="amc-ap-bounds">
        <dt>Requested</dt>
        <dd data-slot="amicode-approval-requested">{boundsText(props.request.bounds)}</dd>
        {/* Shown only once a warrant exists, and shows the GRANTED bounds — which
            can legitimately differ from the request. */}
        <Show when={granted()}>
          {(w) => (
            <>
              <dt>Granted</dt>
              <dd data-slot="amicode-approval-granted">{boundsText(w().bounds)}</dd>
            </>
          )}
        </Show>
      </dl>

      <div class="amc-ap-foot">
        <button
          type="button"
          data-slot="amicode-approval-approve"
          disabled={!actionable()}
          onClick={approve}
        >
          <Show when={state().kind === "expired"} fallback="Approve">
            Re-approve
          </Show>
        </button>
        <span class="amc-ap-note">
          <Show when={state().kind === "unavailable"}>read-only surface — approvals are disabled here</Show>
          <Show when={state().kind === "granted"}>the gate decides whether these bounds cover a given launch</Show>
          <Show when={state().kind === "expired"}>this warrant has lapsed</Show>
        </span>
      </div>
    </div>
  )
}
