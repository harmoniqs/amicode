// Federation public registry (spec Phase 3)
// Only double-gated verified results, no live claim leaves org, two-note leakage split
// Publishable entry vs device-identifying params authored apart (visibility doctrine)

const publicRegistry = new Map<string, { work_id: string; platform: string; kind: string; fidelity: number; catalog_pointer: string; published_at: string; org: string }>();

export async function publishPublic(result: { work_id: string; platform: string; kind: string; fidelity: number; catalog_pointer: string; visibility: string; author_mark: boolean; human_merge: boolean; org: string }) {
  if (result.visibility !== "public") return { ok: false, error: "visibility_not_public" };
  if (!result.author_mark || !result.human_merge) return { ok: false, error: "double_gate_required: author_mark + human_merge" };
  // Leakage-aware: platform/kind reveals work area; device params stay split in private note — enforced by two-note discipline
  publicRegistry.set(result.work_id, { work_id: result.work_id, platform: result.platform, kind: result.kind, fidelity: result.fidelity, catalog_pointer: result.catalog_pointer, published_at: new Date().toISOString(), org: result.org });
  return { ok: true, work_id: result.work_id };
}

export async function dedupFederated(work_id: string, opts: { org?: string } = {}) {
  // Agent in different org dedups to public registry and warm-starts — no live claim ever leaves org
  return publicRegistry.get(work_id) ?? undefined;
}

export async function warmStartFromFederation(work_id: string) {
  const entry = await dedupFederated(work_id);
  if (!entry) return null;
  return { pulse_path: entry.catalog_pointer, fidelity: entry.fidelity, source: "federation" as const };
}

export function _registry() { return publicRegistry; }
export function _clearRegistry() { publicRegistry.clear(); }
