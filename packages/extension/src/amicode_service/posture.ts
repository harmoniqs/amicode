// posture.ts — S2 (spec-20260907-011500 D2, issue #859): the posture route
// family's body-builders.
//
//   GET  /amicode/posture           → the latest compiled plan's STAMPED
//                                     posture_recommendation + the
//                                     plan.auto_switch pref + the dismissal
//   POST /amicode/posture           → {auto_switch: "confirm"|"auto"} — the
//                                     plan.auto_switch pref write
//   POST /amicode/posture/dismiss   → {plan_hash} — record the dismissal so
//                                     the offer does not re-fire for THAT plan
//
// THE ROUTE IS A DUMB READER of data the compiler stamped
// (amico-run/src/posture_recommendation.ts): it parses the recommendation out
// of the plan artifact's frontmatter and surfaces it verbatim — it NEVER
// re-derives, never keyword-guesses. A plan compiled before S2 carries no
// stamped field: recommendation reads null (the offer stays quiet), never a
// client-side re-derivation.
//
// Same service discipline as the solver-mode family: pure body-builders with
// injectable roots for tests, one success shape per route family,
// ok:false + "code: detail" on failure, FIXED error strings (nothing the
// caller sent is echoed), tolerant reads that fail safe.
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { resolveMountStack } from "../substrate/mount_store";

const AUTO_SWITCH_VALUES = new Set(["confirm", "auto"]);

export interface PostureDeps {
  /** The compiled plans dir (injectable; default: $AMICODE_PLANS_DIR, else
   *  the first writable mount's plans/ — the same resolution
   *  plan_verb.defaultPlansDir uses, so the route reads the plans the CLI
   *  actually wrote). */
  plansDir?: string;
  /** The prefs file (injectable; default under $AMICODE_OPS_DIR). */
  prefsFile?: string;
}

// ── the prefs (plan.auto_switch + the dismissal) ─────────────────────────────
//
// The ops-dir convention (solver-mode.json, session-retention.json):
// $AMICODE_OPS_DIR → ~/.amico/amicode/. Reads FAIL SAFE to `confirm` — a
// corrupt preference must never widen the posture (never silently auto-switch;
// confirm is the spec's default and the safe direction).

export function posturePrefsFile(env: NodeJS.ProcessEnv = process.env): string {
  const v = env.AMICODE_OPS_DIR;
  return join(v && v.trim() !== "" ? v : join(homedir(), ".amico", "amicode"), "plan-posture.json");
}

export function plansDirOf(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const override = env.AMICODE_PLANS_DIR;
  if (override !== undefined && override.trim() !== "") return override;
  const writable = resolveMountStack().mounts.find((m) => m.writable);
  return writable ? join(writable.path, "plans") : undefined;
}

interface PosturePrefs {
  schema_version?: number;
  auto_switch?: "confirm" | "auto";
  dismissed?: { plan_hash?: string; ts?: string };
}

function readPrefs(file: string): PosturePrefs {
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as PosturePrefs;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
    return parsed;
  } catch {
    return {}; // absent or malformed → the fail-safe default
  }
}

function autoSwitchOf(prefs: PosturePrefs): "confirm" | "auto" {
  return prefs.auto_switch === "auto" ? "auto" : "confirm";
}

// ── the plan-note frontmatter reader ─────────────────────────────────────────
//
// plan_compile.ts writes JSON-ENCODED frontmatter scalars (its comment
// documents why: bare 1 would read back as a number). This reader takes only
// single-line `key: <json>` scalars and skips block keys (steps:, advisories:)
// — the fields the route surfaces are plan_id/plan_hash/goal/compiled_at/
// posture_recommendation, all scalars or one-line objects. A value that does
// not JSON-parse reads as the raw string (tolerant; the schema validation was
// the compiler's job).

export interface ParsedPlanFront {
  plan_id?: string;
  plan_hash?: string;
  goal?: string;
  compiled_at?: string;
  posture_recommendation?: unknown;
}

export function parsePlanFrontmatter(text: string): ParsedPlanFront | undefined {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!m) return undefined;
  const out: ParsedPlanFront = {};
  const wanted = new Set(["plan_id", "plan_hash", "goal", "compiled_at", "posture_recommendation"]);
  for (const line of m[1]!.split(/\r?\n/)) {
    const eq = line.indexOf(": ");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    if (!wanted.has(key)) continue; // block keys (steps:, advisories:) skip naturally
    const raw = line.slice(eq + 2).trim();
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      value = raw;
    }
    (out as Record<string, unknown>)[key] = value;
  }
  return typeof out.plan_id === "string" ? out : undefined;
}

interface LatestPlan {
  front: ParsedPlanFront;
  path: string;
}

/** The latest compiled plan by compiled_at (filename falls back — the
 *  compiled plan_id embeds the compile timestamp). Unparseable files skip. */
function latestPlan(plansDir: string): LatestPlan | undefined {
  if (!existsSync(plansDir)) return undefined;
  let entries: string[];
  try {
    entries = readdirSync(plansDir).filter((f) => f.startsWith("plan-") && f.endsWith(".md"));
  } catch {
    return undefined;
  }
  let best: LatestPlan | undefined;
  for (const name of entries) {
    const p = join(plansDir, name);
    let front: ParsedPlanFront | undefined;
    try {
      front = parsePlanFrontmatter(readFileSync(p, "utf8"));
    } catch {
      continue; // unreadable → skip, never a partial lie
    }
    if (front === undefined) continue;
    if (
      best === undefined ||
      String(front.compiled_at ?? "") > String(best.front.compiled_at ?? "") ||
      (front.compiled_at === undefined && name > (best.path.split(/[\\/]/).pop() ?? ""))
    ) {
      best = { front, path: p };
    }
  }
  return best;
}

const synthesize = (code: string, detail: string): string => JSON.stringify({ ok: false, error: `${code}: ${detail}` });

/** GET /amicode/posture. One success shape: {ok, plan, recommendation,
 *  auto_switch, dismissed}. NEVER throws — every failure synthesizes into the
 *  shape. */
export function postureResponse(deps: PostureDeps = {}): string {
  const plansDir = deps.plansDir ?? plansDirOf();
  const prefsFile = deps.prefsFile ?? posturePrefsFile();
  const prefs = readPrefs(prefsFile);
  const latest = plansDir === undefined ? undefined : latestPlan(plansDir);
  const recommendation =
    latest !== undefined && latest.front.posture_recommendation !== undefined && typeof latest.front.posture_recommendation === "object"
      ? latest.front.posture_recommendation
      : null;
  const dismissed =
    latest !== undefined &&
    typeof prefs.dismissed?.plan_hash === "string" &&
    prefs.dismissed.plan_hash === latest.front.plan_hash;
  return JSON.stringify({
    ok: true,
    plan:
      latest === undefined
        ? null
        : {
            plan_id: latest.front.plan_id ?? null,
            plan_hash: latest.front.plan_hash ?? null,
            goal: latest.front.goal ?? null,
            compiled_at: latest.front.compiled_at ?? null,
            plan_path: latest.path,
          },
    recommendation,
    auto_switch: autoSwitchOf(prefs),
    dismissed,
  });
}

function atomicWrite(file: string, text: string): void {
  mkdirSync(join(file, ".."), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, text);
  renameSync(tmp, file);
}

/** POST /amicode/posture — {auto_switch: "confirm"|"auto"}. The ONLY values
 *  the vocabulary holds; anything else is the fixed bad_request (never
 *  echoed). */
export function savePostureResponse(body: unknown, deps: PostureDeps = {}): string {
  let parsed: { auto_switch?: unknown } | undefined;
  if (typeof body === "string") {
    try {
      parsed = JSON.parse(body) as { auto_switch?: unknown };
    } catch {
      parsed = undefined;
    }
  } else if (typeof body === "object" && body !== null) {
    parsed = body as { auto_switch?: unknown };
  }
  if (parsed === undefined || !AUTO_SWITCH_VALUES.has(parsed.auto_switch as string))
    return synthesize("bad_request", 'body must be JSON {auto_switch:"confirm"|"auto"}');
  const file = deps.prefsFile ?? posturePrefsFile();
  const prefs = readPrefs(file);
  atomicWrite(file, JSON.stringify({ schema_version: 1, ...prefs, auto_switch: parsed.auto_switch }, null, 2) + "\n");
  return JSON.stringify({ ok: true, auto_switch: parsed.auto_switch, error: null });
}

/** POST /amicode/posture/dismiss — {plan_hash}. Records WHICH plan's offer
 *  was dismissed; a later compile mints a new plan_hash and the offer is
 *  live again (a dismissal is per-plan, never a permanent mute). */
export function dismissPostureResponse(body: unknown, deps: PostureDeps = {}): string {
  let parsed: { plan_hash?: unknown } | undefined;
  if (typeof body === "string") {
    try {
      parsed = JSON.parse(body) as { plan_hash?: unknown };
    } catch {
      parsed = undefined;
    }
  } else if (typeof body === "object" && body !== null) {
    parsed = body as { plan_hash?: unknown };
  }
  if (parsed === undefined || typeof parsed.plan_hash !== "string" || parsed.plan_hash.trim() === "")
    return synthesize("bad_request", "body must be JSON {plan_hash}");
  const file = deps.prefsFile ?? posturePrefsFile();
  const prefs = readPrefs(file);
  const dismissed = { plan_hash: parsed.plan_hash, ts: new Date().toISOString() };
  atomicWrite(file, JSON.stringify({ schema_version: 1, ...prefs, dismissed }, null, 2) + "\n");
  return JSON.stringify({ ok: true, dismissed: parsed.plan_hash, error: null });
}
