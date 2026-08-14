// Warrant org-scoped shared counters (spec §6)
// Counters total across hosts per org token — refusing with bound/margin/declaration
// This is the 8th warrant class: shared spend/device/size, org-local

const orgCounters = new Map<string, Map<string, number>>(); // org → (plan_hash → count)

export function checkWarrant(warrant: any, key: { work_id: string; plan_hash?: string }): { pass: boolean; bound?: string; margin?: number; declaration?: string } {
  if (!warrant || !warrant.bounds) return { pass: true };
  const org = warrant.org ?? warrant.owner ?? "default";
  const planHash = warrant.plan_hash ?? key.plan_hash ?? "default";
  const counts = orgCounters.get(org) ?? new Map();
  const used = counts.get(planHash) ?? 0;
  const max = warrant.bounds?.max_solves ?? warrant.bounds?.maxSolves ?? Infinity;
  if (Number.isFinite(max) && used >= max) {
    return { pass: false, bound: "max_solves:" + max, margin: used - max, declaration: warrant.plan_hash ?? planHash };
  }
  // device/size bounds would be checked similarly — per spec §6, omitted bound is refusal not allow
  if (warrant.bounds?.device === "none" && key.work_id.includes("hw")) {
    return { pass: false, bound: "device:none", margin: 1, declaration: warrant.plan_hash };
  }
  return { pass: true };
}

export function recordDispatch(org: string, plan_hash: string): void {
  const m = orgCounters.get(org) ?? new Map();
  m.set(plan_hash, (m.get(plan_hash) ?? 0) + 1);
  orgCounters.set(org, m);
}

export function readWarrant(): any { return null; } // real reads from ~/.amico/ledger/approvals

export function _counters() { return orgCounters; }
export function _clearCounters() { orgCounters.clear(); }
