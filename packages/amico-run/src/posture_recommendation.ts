// posture_recommendation.ts — S2 (spec-20260907-011500 D2, issue #859): the
// plan's terminal artifact emits a structured `posture_recommendation`
// (target mode + reason) derived from the plan's ARTIFACT SHAPE, never from
// keyword-guessing. The plan's steps ARE its shape: each step declares a
// task_type (the closed TASK_TYPES vocabulary, ledger.ts), and the task-type
// classes decide —
//
//   implementation-shaped (issues, PRs, code tasks, bookkeeping) → develop
//   experiment-shaped   (hypotheses, experiments, analysis)      → research
//
// TIE-BREAKS, each a named unit in test/posture_recommendation.test.ts:
//   - MIXED shape → `ambiguous` with BOTH modes named; the user picks; no
//     silent coin-flip.
//   - a spec whose executor is another agent (`agent` frontmatter) recommends
//     the EXECUTOR's posture when determinable (read-resolve alias, then the
//     posture-binding map's vocabulary), else `ambiguous` (ask).
//   - an abandoned plan — no steps, or only administrative steps (no terminal
//     execution artifact) — is kind "none": the offer never fires, and an
//     executor hint cannot rescue it.
//
// Pure and synchronous: compilePlan calls it while stamping; the indicator
// reads the stamped field as data (the doctrine's data-crossing rule — the
// indicator never re-derives and never guesses).
import { resolveModeId } from "@amicode/schema";
import type { CompiledStep } from "./plan_compile.js";

/** The two product postures a plan can recommend (spec D1's named modes). */
export type PostureMode = "develop" | "research";

export type PostureRecommendation =
  | { readonly kind: "recommend"; readonly mode: PostureMode; readonly reason: string }
  | { readonly kind: "ambiguous"; readonly modes: readonly PostureMode[]; readonly reason: string }
  | { readonly kind: "none"; readonly reason: string };

/** Implementation-shaped task types: work whose artifact is an issue, a PR,
 *  code, or the bookkeeping that lands it. */
export const IMPLEMENTATION_TASK_TYPES: readonly string[] = ["implement-slice", "author-script", "bookkeeping"];

/** Experiment-shaped task types: work whose artifact is a hypothesis, an
 *  experiment, or an analysis/insight over results. */
export const EXPERIMENT_TASK_TYPES: readonly string[] = ["experiment-sim", "experiment-hw", "insight"];

/** Administrative types: shape-neutral planning work. They never decide a
 *  posture and never count as a terminal execution artifact. */
const ADMINISTRATIVE_TASK_TYPES: readonly string[] = ["triage", "plan", "review", "converse"];

/** The posture-binding vocabulary (mode.toml's `agent` declarations, #808):
 *  these agent ids ARE a posture — the read-resolve alias table maps the old
 *  director ids onto them. `plan` and `build` are deliberately absent: they
 *  are postures of the PLAN ITSELF, not an executor to hand off to. */
const POSTURE_AGENTS: ReadonlySet<string> = new Set(["develop", "research"]);

const REASON_NONE = "no terminal execution artifact — the plan's steps carry no implementation or experiment shape, so the posture offer never fires";

function shapeOf(taskType: string): "implementation" | "experiment" | undefined {
  if (IMPLEMENTATION_TASK_TYPES.includes(taskType)) return "implementation";
  if (EXPERIMENT_TASK_TYPES.includes(taskType)) return "experiment";
  if (ADMINISTRATIVE_TASK_TYPES.includes(taskType)) return undefined;
  // A task_type outside the closed vocabulary cannot happen through
  // compilePlan (checkStepShape refuses it); a direct caller handing one in
  // gets shapeless treatment, not a guess.
  return undefined;
}

/** The executor's posture, when the spec frontmatter's `agent` names one.
 *  Read-resolve first (old director ids are legitimate on append-only
 *  artifacts), then the posture vocabulary; `plan`/`build`/role agents bind
 *  no executor posture (undefined = fall through to shape); an id outside
 *  EVERY known vocabulary is not determinable — `unresolvable` (the caller
 *  asks, never guesses). */
function executorPosture(agent: string): PostureMode | "unresolvable" | undefined {
  const resolved = resolveModeId(agent);
  if (POSTURE_AGENTS.has(resolved)) return resolved as PostureMode;
  if (resolved === "plan" || resolved === "build") return undefined;
  return "unresolvable";
}

function summarize(types: readonly string[]): string {
  return types.length === 1 ? types[0]! : `${types.slice(0, -1).join(", ")} and ${types[types.length - 1]!}`;
}

/** The recommendation for a compiled plan's steps (+ the spec frontmatter's
 *  optional `agent` executor hint). Total and synchronous — never throws. */
export function postureRecommendation(
  steps: ReadonlyArray<Pick<CompiledStep, "task_type">>,
  opts: { executorAgent?: string } = {},
): PostureRecommendation {
  const impl = steps.filter((s) => shapeOf(s.task_type) === "implementation").map((s) => s.task_type);
  const exp = steps.filter((s) => shapeOf(s.task_type) === "experiment").map((s) => s.task_type);

  // An abandoned plan: no terminal execution artifact. The offer never fires,
  // and an executor hint cannot rescue it (the artifact has nothing to hand
  // to).
  if (impl.length === 0 && exp.length === 0) return { kind: "none", reason: REASON_NONE };

  const executor = opts.executorAgent !== undefined && opts.executorAgent.trim() !== "" ? executorPosture(opts.executorAgent.trim()) : undefined;

  // Mixed shape → ambiguous, both named (no silent coin-flip) — UNLESS the
  // spec's executor is determinable, which outranks the shape split (the
  // spec already said who executes).
  if (impl.length > 0 && exp.length > 0) {
    if (executor !== undefined && executor !== "unresolvable")
      return {
        kind: "recommend",
        mode: executor,
        reason: `spec executor ${opts.executorAgent!.trim()} binds the ${executor} posture (mixed shape: ${summarize(impl)} + ${summarize(exp)})`,
      };
    return {
      kind: "ambiguous",
      modes: ["develop", "research"],
      reason: `mixed shape — implementation steps (${summarize(impl)}) and experiment steps (${summarize(exp)})`,
    };
  }

  // Single shape — unless the spec's executor names the OTHER posture, which
  // outranks the shape (the executor is the stronger datum).
  const shapedMode: PostureMode = impl.length > 0 ? "develop" : "research";
  const shapedTypes = impl.length > 0 ? impl : exp;
  if (executor === "unresolvable")
    return {
      kind: "ambiguous",
      modes: ["develop", "research"],
      reason: `spec executor "${opts.executorAgent!.trim()}" resolves to no product posture, and the shape (${shapedMode}: ${summarize(shapedTypes)}) is not decisive for it — pick one`,
    };
  if (executor !== undefined && executor !== shapedMode)
    return {
      kind: "recommend",
      mode: executor,
      reason: `spec executor ${opts.executorAgent!.trim()} binds the ${executor} posture (shape was ${shapedMode}: ${summarize(shapedTypes)})`,
    };
  return {
    kind: "recommend",
    mode: shapedMode,
    reason: `${shapedMode === "develop" ? "implementation" : "experiment"}-shaped plan: ${summarize(shapedTypes)}`,
  };
}
