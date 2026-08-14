// Linear outward/inward projection (spec Phase 2)
// Outward: one issue/campaign + one comment/run card; state mirrors claim/run
// Inward: human approval/steer in Linear → ledger row source:"linear"

export async function linearOutward(campaign: { work_id: string; claim: any; run?: any }) {
  // 1 issue per campaign, 1 comment per run card (fidelity+verdict+pulse link)
  return { issue_id: "lin_" + campaign.work_id.slice(0,8), state: campaign.claim?.outcome ?? "Triage" };
}

export async function linearInward(event: { type: string; issue_id: string; user: string; text: string }) {
  // Approval or steer in Linear → ledger row with source:"linear"
  return { type: "approval", ts: new Date().toISOString(), source: "linear", issue_id: event.issue_id, user: event.user };
}
