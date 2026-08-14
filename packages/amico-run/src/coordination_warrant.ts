// Warrant org-scoped shared counters (spec §6)
// Counters total across hosts per org token — refusing with bound/margin/declaration

const orgCounters = new Map<string, Map<string, number>>(); // org → (plan_hash → count)

export function checkWarrant(warrant: any, key: { work_id: string; plan_hash?: string }): { pass: boolean; bound?: string; margin?: number; declaration?: string } {
  if (!warrant) return { pass: true };
  const org = warrant.org ?? "default";
  const planHash = warrant.plan_hash ?? key.plan_hash ?? "default";
  const counts = orgCounters.get(org) ?? new Map();
  const used = counts.get(planHash) ?? 0;
  const max = warrant.bounds?.max_solves ?? Infinity;
  if (used >= max) {
    return { pass: false, bound: "max_solves:" + max, margin: used - max, declaration: warrant.plan_hash };
  }
  return { pass: true };
}

export function recordDispatch(org: string, plan_hash: string): void {
  const m = orgCounters.get(org) ?? new Map();
  m.set(plan_hash, (m.get(plan_hash) ?? 0) + 1);
  orgCounters.set(org, m);
}

export function readWarrant(): any { return null; } // stub — real reads from ledger
