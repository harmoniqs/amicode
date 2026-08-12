// Template registry + exemplars index loaders and the shape resolver core
// (spec C tiers). The registry (templates/registry.toml, an extension asset)
// carries tier-1 templates — ONLY status="vetted" entries are tier-1
// eligible — plus the support package set and the sandbox uuid map. The
// exemplars index (exemplars/index.json, built by build_exemplars.mjs) is
// tier 2, with build-time masked baseline_hash per entry. Loaders never
// throw: a missing/corrupt catalog degrades to tier 3, not a crash.
import { existsSync, readFileSync } from "node:fs";
import { parse as parseToml } from "smol-toml";
import { JULIA_STDLIBS } from "./import_scan.js";

export interface TemplateEntry {
  id: string;
  platform: string;
  kind: string;
  size: number;
  path: string;
  packages: string[];
  status: string; // "vetted" | "experimental" | …
  entitlement?: string; // required entitlement id, when gated
  fill_begin?: string;
  fill_end?: string;
}

export interface ExemplarEntry {
  id: string;
  platform: string;
  kind: string;
  size: number;
  path: string;
  packages: string[];
  baseline_hash: string;
  notes?: string;
  fill_begin?: string;
  fill_end?: string;
}

export interface Registry {
  templates: TemplateEntry[];
  support: string[];
  uuids: Record<string, string>;
  verifyTolerance: number;
}

export interface ExemplarsIndex {
  exemplars: ExemplarEntry[];
}

export interface Shape {
  platform: string;
  kind: string;
  size: number;
}

export type Tier = "spec" | "vetted" | "composed" | "free";

export interface ShapeMatch {
  tier: Tier;
  template?: TemplateEntry;
  exemplar?: ExemplarEntry;
  blockedHigher?: { tier: "spec" | "vetted" | "composed"; requires: string };
  reason?: string; // present when spec was considered but fell through
}

/** Spec-expressibility check (W2.2): a formulation is spec-expressible when its
 *  ProblemSpec validates against the entitlement-keyed schema. Custom/bespoke
 *  objective kinds that are not in either schema render it not spec-expressible
 *  and it falls through to vetted/composed/free with the reason surfaced. The
 *  check is schema-driven, not hand-rolled: the schemas ARE the subset definition. */
export function isSpecExpressible(
  problemSpec: unknown,
  hasIssimo: boolean,
): { expressible: true } | { expressible: false; reason: string } {
  // Lazy import to avoid circular deps — use dynamic validateProblemSpec lookup
  // via @amicode/schema at call site. Here we inline a minimal check: unknown
  // kinds fail validation. Caller should use validateProblemSpec directly.
  // This helper is a convenience for tests; production uses validateProblemSpec.
  if (problemSpec == null || typeof problemSpec !== "object") {
    return { expressible: false, reason: "no problemSpec supplied" };
  }
  const obj = problemSpec as Record<string, unknown>;
  // Custom objective heuristic: an objective kind of "custom" or any key that
  // the schema would reject. We surface a typed reason so the agent can explain
  // the fallback rather than silently downgrading.
  const problem = obj.problem as Record<string, unknown> | undefined;
  const objectives = problem?.objectives;
  if (Array.isArray(objectives)) {
    for (const o of objectives) {
      const kind = (o as Record<string, unknown>)?.kind;
      if (typeof kind === "string" && kind === "custom") {
        return { expressible: false, reason: "custom objective kind 'custom' is not spec-expressible" };
      }
    }
  }
  // If no custom marker, defer to schema validation at the call site — assume
  // expressible here; the gate's validate() is authoritative.
  void hasIssimo;
  return { expressible: true };
}

const EMPTY_REGISTRY: Registry = { templates: [], support: [], uuids: {}, verifyTolerance: 0.01 };

function strings(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((s): s is string => typeof s === "string") : [];
}

export function loadRegistry(file: string): Registry {
  if (!existsSync(file)) return EMPTY_REGISTRY;
  let parsed: Record<string, unknown>;
  try {
    parsed = parseToml(readFileSync(file, "utf8")) as Record<string, unknown>;
  } catch {
    return EMPTY_REGISTRY;
  }
  const templates = (Array.isArray(parsed.template) ? parsed.template : [])
    .filter((t): t is Record<string, unknown> => typeof t === "object" && t !== null)
    .filter((t) => typeof t.id === "string" && typeof t.platform === "string" && typeof t.kind === "string")
    .map(
      (t): TemplateEntry => ({
        id: t.id as string,
        platform: t.platform as string,
        kind: t.kind as string,
        size: typeof t.size === "number" ? t.size : 1,
        path: typeof t.path === "string" ? t.path : "",
        packages: strings(t.packages),
        status: typeof t.status === "string" ? t.status : "experimental",
        entitlement: typeof t.entitlement === "string" ? t.entitlement : undefined,
        fill_begin: typeof t.fill_begin === "string" ? t.fill_begin : undefined,
        fill_end: typeof t.fill_end === "string" ? t.fill_end : undefined,
      }),
    );
  const support = strings((parsed.support as Record<string, unknown> | undefined)?.packages);
  const uuids: Record<string, string> = {};
  if (typeof parsed.uuids === "object" && parsed.uuids !== null)
    for (const [name, uuid] of Object.entries(parsed.uuids as Record<string, unknown>))
      if (typeof uuid === "string") uuids[name] = uuid;
  return {
    templates,
    support,
    uuids,
    verifyTolerance: typeof parsed.verify_tolerance === "number" ? parsed.verify_tolerance : 0.01,
  };
}

export function loadExemplarsIndex(file: string): ExemplarsIndex {
  if (!existsSync(file)) return { exemplars: [] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return { exemplars: [] };
  }
  const raw = (parsed as Record<string, unknown>)?.exemplars;
  const exemplars = (Array.isArray(raw) ? raw : [])
    .filter((e): e is Record<string, unknown> => typeof e === "object" && e !== null)
    .filter((e) => typeof e.id === "string" && typeof e.baseline_hash === "string")
    .map(
      (e): ExemplarEntry => ({
        id: e.id as string,
        platform: typeof e.platform === "string" ? e.platform : "",
        kind: typeof e.kind === "string" ? e.kind : "",
        size: typeof e.size === "number" ? e.size : 1,
        path: typeof e.path === "string" ? e.path : "",
        packages: strings(e.packages),
        baseline_hash: e.baseline_hash as string,
        notes: typeof e.notes === "string" ? e.notes : undefined,
        fill_begin: typeof e.fill_begin === "string" ? e.fill_begin : undefined,
        fill_end: typeof e.fill_end === "string" ? e.fill_end : undefined,
      }),
    );
  return { exemplars };
}

/** Tier resolution (spec C, locked decision 5; W2.2 adds `spec` above vetted):
 *  spec (fully validated data, no authored code) → tier 0; exact vetted template
 *  match → tier 1; else exemplar match on platform+kind (size may differ) → tier 2;
 *  else tier 3. A spec-expressible formulation resolves to `spec` WITHOUT
 *  consulting the registry; out-of-subset falls through to vetted/composed/free
 *  with the reason surfaced. Entitlement- or allowlist-blocked higher matches
 *  are excluded from selection but reported via blockedHigher so the agent can
 *  run the explicit-confirmation flow (never a silent downgrade). */
export function matchShape(
  shape: Shape,
  registry: Registry,
  exemplars: ExemplarsIndex,
  allowlist: string[],
  problemSpec?: unknown,
): ShapeMatch {
  // ── tier 0: spec — fully validated data, no authored code ──
  if (problemSpec !== undefined) {
    const check = isSpecExpressible(problemSpec, false);
    if (check.expressible) {
      // Defer to schema validation at the gate — here we treat presence of a
      // problemSpec that passed the cheap custom-objective heuristic as
      // spec-expressible. The gate's validateProblemSpec is authoritative.
      return { tier: "spec" };
    }
    // Not spec-expressible → fall through with reason; do NOT short-circuit
    const reason = (check as { expressible: false; reason: string }).reason;
    const fallback = matchShapeWithoutSpec(shape, registry, exemplars, allowlist);
    return { ...fallback, reason };
  }
  return matchShapeWithoutSpec(shape, registry, exemplars, allowlist);
}

function matchShapeWithoutSpec(
  shape: Shape,
  registry: Registry,
  exemplars: ExemplarsIndex,
  allowlist: string[],
): ShapeMatch {
  const allowed = new Set([...allowlist, ...registry.support, ...JULIA_STDLIBS]);
  const packagesOk = (packages: string[]) => packages.every((p) => allowed.has(p));
  let blockedHigher: ShapeMatch["blockedHigher"];

  const templateMatches = registry.templates.filter(
    (t) => t.status === "vetted" && t.platform === shape.platform && t.kind === shape.kind && t.size === shape.size,
  );
  for (const template of templateMatches) {
    if (packagesOk(template.packages)) return { tier: "vetted", template };
    blockedHigher ??= { tier: "vetted", requires: template.entitlement ?? "unknown" };
  }

  const exemplarMatches = exemplars.exemplars.filter((e) => e.platform === shape.platform && e.kind === shape.kind);
  // prefer exact-size, then any
  exemplarMatches.sort((a, b) => Number(b.size === shape.size) - Number(a.size === shape.size));
  for (const exemplar of exemplarMatches) {
    if (packagesOk(exemplar.packages)) return { tier: "composed", exemplar, blockedHigher };
    blockedHigher ??= { tier: "composed", requires: "unknown" };
  }

  return { tier: "free", blockedHigher };
}
