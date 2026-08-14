// Federation public registry (spec Phase 3)
// Only double-gated verified results, no live claim leaves org, two-note leakage split

const publicRegistry = new Map<string, { work_id: string; platform: string; kind: string; fidelity: number; catalog_pointer: string }>();

export async function publishPublic(result: { work_id: string; platform: string; kind: string; fidelity: number; catalog_pointer: string; visibility: string; author_mark: boolean; human_merge: boolean }) {
  if (result.visibility !== "public" || !result.author_mark || !result.human_merge) return { ok: false, error: "double_gate_required" };
  // Leakage-aware: platform/kind reveals work area; device params stay split in private note
  publicRegistry.set(result.work_id, { work_id: result.work_id, platform: result.platform, kind: result.kind, fidelity: result.fidelity, catalog_pointer: result.catalog_pointer });
  return { ok: true };
}

export async function dedupFederated(work_id: string) {
  return publicRegistry.get(work_id);
}

export function _registry() { return publicRegistry; }
