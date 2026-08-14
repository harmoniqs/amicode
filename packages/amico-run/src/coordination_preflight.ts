// Coordination preflight — deterministic CLI spine (spec §4)
// Dedup → Claim → Warrant → Dispatch → Publish → Release

import { coordinationService, workId } from "./coordination_ledger.js";
import { checkWarrant } from "./coordination_warrant.js";
function readWarrant(): any { return null; }

export type PreflightArgs = {
  structure_hash: string;
  goal: string;
  N: number;
  T: number;
  facet_tuple?: unknown;
  agent_id: string;
  user: string;
  org: string;
  host: string;
  variant_axis?: string;
};

export async function preflight(args: PreflightArgs) {
  const wid = workId({ structure_hash: args.structure_hash, goal: args.goal, N: args.N, T: args.T, facet_tuple: args.facet_tuple });
  // 1. Dedup (fine→coarse handled by service)
  // 2. Claim
  const claimRes = await coordinationService.preflight({ work_id: wid, agent_id: args.agent_id, user: args.user, org: args.org, host: args.host, variant_axis: args.variant_axis });
  if (!claimRes.ok) {
    // 3. Warrant is checked before dispatch even on conflict — caller chooses yield/steer/variant
    return { work_id: wid, step: "claim_conflict" as const, holder: claimRes.holder, error: claimRes.error };
  }
  if (claimRes.dedup?.verified) {
    return { work_id: wid, step: "dedup_hit" as const, pulse_path: claimRes.dedup.pulse_path };
  }
  // 3. Warrant gate
  const warrant = readWarrant();
  const check = checkWarrant(warrant, { work_id: wid });
  if (!check.pass) {
    return { work_id: wid, step: "warrant_refused" as const, bound: check.bound, margin: check.margin, declaration: check.declaration };
  }
  // 4. Dispatch — caller proceeds to solve, then Publish → Release
  return { work_id: wid, step: "dispatch" as const, claim: claimRes.claim };
}
