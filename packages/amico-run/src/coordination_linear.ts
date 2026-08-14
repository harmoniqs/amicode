// Linear outward/inward projection (spec Phase 2)
// Outward: one issue/campaign + one comment/run card; state mirrors claim/run
// Inward: human approval/steer in Linear → ledger row source:"linear"
// Ledger is source of truth; tracker is interchangeable projection

export type LinearState = "Triage" | "In Progress" | "In Review" | "Done";
export function claimToLinearState(outcome?: string): LinearState {
  if (outcome === "claimed") return "In Progress";
  if (outcome === "solved") return "In Review";
  if (outcome === "failed" || outcome === "abandoned") return "Triage";
  return "Triage";
}

export async function linearOutward(campaign: { work_id: string; claim: any; run?: { fidelity: number; verdict: string; pulse_link?: string } }) {
  // 1 issue per campaign, 1 comment per run card (fidelity+verdict+pulse link)
  const state = claimToLinearState(campaign.claim?.outcome);
  const comment = campaign.run ? `fidelity=${campaign.run.fidelity} verdict=${campaign.run.verdict} pulse=${campaign.run.pulse_link ?? "-"}` : undefined;
  return { issue_id: "lin_" + campaign.work_id.slice(0,8), state, comment, work_id: campaign.work_id };
}

export async function linearInward(event: { type: "approval" | "steer"; issue_id: string; user: string; text: string; work_id?: string }) {
  // Approval or steer in Linear → ledger row with source:"linear" — a comment can request, only ledger records
  if (event.type === "approval") {
    return { type: "approval" as const, ts: new Date().toISOString(), source: "linear" as const, issue_id: event.issue_id, user: event.user, plan_hash: event.text };
  }
  return { type: "steer" as const, ts: new Date().toISOString(), source: "linear" as const, issue_id: event.issue_id, user: event.user, text: event.text, work_id: event.work_id };
}

export async function linearPoll(events: Array<{ issue_id: string; user: string; text: string; work_id?: string }>) {
  return Promise.all(events.map(e => linearInward({ type: "steer", issue_id: e.issue_id, user: e.user, text: e.text, work_id: e.work_id })));
}
