// Iteration score — the DATA half of the harness reframe (spec-20260708-112732
// §3.2, plan slice B4). An "iteration score" declares ONE experiment iteration
// as data: which target to solve for, at which trust tier, and how promotion is
// gated. It is deliberately NOT an interview SCORE.md (no questions/choices) —
// the interview repertoire loader only reads `SCORE.md`, so a harness score
// (ITERATION.toml) never enters that machinery. The control flow that walks
// these fields lives in experiment_iteration.ts as CODE, not in an LLM prompt.
//
// G-1 ruling (amicode#107): score-first for flow; a thin TS DRIVER only for what
// the stage model can't express. The experiment-iteration loop is exactly that
// case — the flow (target + gate policy) is data here; the loop is the driver.
import { parse as parseToml } from "smol-toml";

export type Tier = "vetted" | "composed" | "free";
const TIERS: readonly Tier[] = ["vetted", "composed", "free"];

export type EnvKind = "provisioned" | "project" | "sandbox";

/** The target the iteration solves for. Mirrors the fields the experimenter
 *  leaf needs to author + the SolveSpec the gate reads (tier/source/env). */
export interface IterationTarget {
  platform: string;
  gate?: string;
  kind: string;
  size: number;
  tier: Tier;
  target_fidelity?: number;
  /** tier-2: the exemplars-index entry the leaf splices; the gate REQUIRES this
   *  when tier=composed (see gate.ts step 4). Carried through to the SolveSpec. */
  exemplar_id?: string;
  /** tier-1: the registry template id (informational for the driver). */
  template_id?: string;
  /** Julia env for the SolveSpec (kind=sandbox is mandatory for free). */
  env?: { kind: EnvKind; project?: string };
}

export interface IterationScore {
  schema_version: number;
  id: string;
  name?: string;
  target: IterationTarget;
  /** Promotion policy. "agree" = only promote (save to catalog) when the
   *  independent re-rollout agrees with the optimizer-reported fidelity. This is
   *  the trust anchor for author-first tiers (spec §4.3). */
  verify: { promote_on: "agree" };
}

export type ParseResult = { ok: true; score: IterationScore } | { ok: false; error: string };

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() !== "" ? v : undefined;
}
function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

/** Parse + validate an iteration score from TOML text. Never throws — a malformed
 *  score returns { ok:false, error } so the harness reports it, exactly like the
 *  interview repertoire treats a broken SCORE.md (report, don't crash). */
export function parseIterationScore(tomlText: string): ParseResult {
  let raw: Record<string, unknown>;
  try {
    raw = parseToml(tomlText) as Record<string, unknown>;
  } catch (e) {
    return { ok: false, error: `iteration score: unparseable TOML (${(e as Error).message})` };
  }

  const id = str(raw.id);
  if (!id) return { ok: false, error: "iteration score: missing `id`" };

  const t = raw.target;
  if (typeof t !== "object" || t === null) return { ok: false, error: "iteration score: missing `[target]` table" };
  const tt = t as Record<string, unknown>;

  const platform = str(tt.platform);
  const kind = str(tt.kind);
  const size = num(tt.size);
  const tier = str(tt.tier) as Tier | undefined;
  if (!platform) return { ok: false, error: "iteration score: `target.platform` required" };
  if (!kind) return { ok: false, error: "iteration score: `target.kind` required" };
  if (size === undefined || size <= 0) return { ok: false, error: "iteration score: `target.size` must be a positive number" };
  if (!tier || !TIERS.includes(tier))
    return { ok: false, error: `iteration score: \`target.tier\` must be one of ${TIERS.join("|")}` };

  const exemplar_id = str(tt.exemplar_id);
  if (tier === "composed" && !exemplar_id)
    return { ok: false, error: 'iteration score: tier "composed" requires `target.exemplar_id` (the gate needs it)' };

  let env: IterationTarget["env"];
  if (typeof tt.env === "object" && tt.env !== null) {
    const e = tt.env as Record<string, unknown>;
    const kindE = str(e.kind) as EnvKind | undefined;
    if (kindE) env = { kind: kindE, project: str(e.project) };
  }
  if (tier === "free" && env?.kind !== "sandbox")
    return { ok: false, error: 'iteration score: tier "free" requires `target.env.kind = "sandbox"` (gate step 3)' };

  const verifyRaw = (typeof raw.verify === "object" && raw.verify !== null ? raw.verify : {}) as Record<string, unknown>;
  const promote_on = str(verifyRaw.promote_on) ?? "agree";
  if (promote_on !== "agree")
    return { ok: false, error: `iteration score: \`verify.promote_on\` must be "agree" (got "${promote_on}")` };

  return {
    ok: true,
    score: {
      schema_version: num(raw.schema_version) ?? 1,
      id,
      name: str(raw.name),
      target: {
        platform,
        gate: str(tt.gate),
        kind,
        size,
        tier,
        target_fidelity: num(tt.target_fidelity),
        exemplar_id,
        template_id: str(tt.template_id),
        env,
      },
      verify: { promote_on: "agree" },
    },
  };
}
