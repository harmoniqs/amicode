// S2 (spec-20260907-011500 D2, issue #859): the posture route family —
// GET /amicode/posture (the latest compiled plan's stamped
// posture_recommendation + the plan.auto_switch pref) and the two POST
// siblings (the pref write, the dismissal). The route is a DUMB READER of
// data the compiler stamped: it never re-derives a recommendation — the
// indicator reads data, never guesses (the doctrine's data-crossing rule).
//
// Same service discipline as the solver-mode family: pure body-builders with
// injectable roots, one success shape per route, ok:false + "code: detail"
// on failure, fixed error strings (nothing the caller sent is echoed).
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { postureResponse, savePostureResponse, dismissPostureResponse } from "../src/amicode_service/posture";

let tmp: string;
let plansDir: string;
let prefsFile: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "amicode-posture-"));
  plansDir = path.join(tmp, "plans");
  fs.mkdirSync(plansDir);
  prefsFile = path.join(tmp, "plan-posture.json");
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** A compiled-plan note the way plan_compile.ts writes it: JSON-encoded
 *  frontmatter scalars, block-array steps/advisories, then the body. */
const planNote = (front: Record<string, unknown>, goal = "do the thing"): string => {
  const scalars = Object.entries(front)
    .map(([k, v]) => `${k}: ${JSON.stringify(v)}`)
    .join("\n");
  return `---\n${scalars}\n---\n\n# ${goal}\n\nbody\n`;
};

const deps = () => ({ plansDir, prefsFile });

describe("GET /amicode/posture — postureResponse", () => {
  it("answers the fail-safe default with no plans dir present", () => {
    const body = JSON.parse(postureResponse({ prefsFile, plansDir: path.join(tmp, "absent") }));
    expect(body.ok).toBe(true);
    expect(body.plan).toBeNull();
    expect(body.recommendation).toBeNull();
    expect(body.auto_switch).toBe("confirm");
    expect(body.dismissed).toBe(false);
  });

  it("returns the LATEST compiled plan (by compiled_at) and its stamped recommendation", () => {
    fs.writeFileSync(
      path.join(plansDir, "plan-20260906-old.md"),
      planNote({
        type: "plan", schema_version: "1", plan_id: "plan-old", goal: "old",
        plan_hash: "a".repeat(64), design_hash: "b".repeat(64),
        compiled_at: "2026-09-06T10:00:00.000Z",
        posture_recommendation: { kind: "recommend", mode: "develop", reason: "implementation-shaped plan: implement-slice" },
        steps: [],
      }),
    );
    fs.writeFileSync(
      path.join(plansDir, "plan-20260907-new.md"),
      planNote({
        type: "plan", schema_version: "1", plan_id: "plan-new", goal: "new",
        plan_hash: "c".repeat(64), design_hash: "d".repeat(64),
        compiled_at: "2026-09-07T10:00:00.000Z",
        posture_recommendation: { kind: "ambiguous", modes: ["develop", "research"], reason: "mixed shape" },
        steps: [],
      }),
    );
    const body = JSON.parse(postureResponse(deps()));
    expect(body.ok).toBe(true);
    expect(body.plan.plan_id).toBe("plan-new");
    expect(body.plan.plan_hash).toBe("c".repeat(64));
    expect(body.recommendation).toEqual({ kind: "ambiguous", modes: ["develop", "research"], reason: "mixed shape" });
    expect(body.auto_switch).toBe("confirm");
    expect(body.dismissed).toBe(false);
  });

  it("kind 'none' is data too — the recommendation surfaces, the offer decides client-side", () => {
    fs.writeFileSync(
      path.join(plansDir, "plan-20260907-abandoned.md"),
      planNote({
        type: "plan", schema_version: "1", plan_id: "plan-abandoned", goal: "abandoned",
        plan_hash: "e".repeat(64), design_hash: "f".repeat(64),
        compiled_at: "2026-09-07T12:00:00.000Z",
        posture_recommendation: { kind: "none", reason: "no terminal execution artifact" },
        steps: [],
      }),
    );
    const body = JSON.parse(postureResponse(deps()));
    expect(body.plan.plan_id).toBe("plan-abandoned");
    expect(body.recommendation).toEqual({ kind: "none", reason: "no terminal execution artifact" });
  });

  it("a compiled plan with NO stamped recommendation reads recommendation null — never a re-derivation", () => {
    fs.writeFileSync(
      path.join(plansDir, "plan-20260907-unstamped.md"),
      planNote({
        type: "plan", schema_version: "1", plan_id: "plan-unstamped", goal: "unstamped",
        plan_hash: "1".repeat(64), design_hash: "2".repeat(64),
        compiled_at: "2026-09-07T12:00:00.000Z",
        steps: [],
      }),
    );
    const body = JSON.parse(postureResponse(deps()));
    expect(body.plan.plan_id).toBe("plan-unstamped");
    expect(body.recommendation).toBeNull();
  });

  it("an unparseable plan file is skipped, never a partial lie", () => {
    fs.writeFileSync(path.join(plansDir, "plan-broken.md"), "not frontmatter at all\n");
    fs.writeFileSync(
      path.join(plansDir, "plan-20260907-good.md"),
      planNote({
        type: "plan", schema_version: "1", plan_id: "plan-good", goal: "good",
        plan_hash: "3".repeat(64), design_hash: "4".repeat(64),
        compiled_at: "2026-09-07T13:00:00.000Z",
        posture_recommendation: { kind: "recommend", mode: "research", reason: "experiment-shaped plan: insight" },
        steps: [],
      }),
    );
    const body = JSON.parse(postureResponse(deps()));
    expect(body.plan.plan_id).toBe("plan-good");
  });

  it("reads the auto_switch pref and the dismissal", () => {
    fs.writeFileSync(
      path.join(plansDir, "plan-20260907-x.md"),
      planNote({
        type: "plan", schema_version: "1", plan_id: "plan-x", goal: "x",
        plan_hash: "5".repeat(64), design_hash: "6".repeat(64),
        compiled_at: "2026-09-07T14:00:00.000Z",
        posture_recommendation: { kind: "recommend", mode: "develop", reason: "implementation-shaped plan: author-script" },
        steps: [],
      }),
    );
    fs.writeFileSync(prefsFile, JSON.stringify({ schema_version: 1, auto_switch: "auto", dismissed: { plan_hash: "5".repeat(64), ts: "t" } }));
    const body = JSON.parse(postureResponse(deps()));
    expect(body.auto_switch).toBe("auto");
    expect(body.dismissed).toBe(true);
  });

  it("a corrupt prefs file fails SAFE to confirm — never widens the posture", () => {
    fs.writeFileSync(prefsFile, "{not json");
    const body = JSON.parse(postureResponse(deps()));
    expect(body.auto_switch).toBe("confirm");
  });
});

describe("POST /amicode/posture — savePostureResponse", () => {
  it("writes auto and reads it back", () => {
    const out = JSON.parse(savePostureResponse({ auto_switch: "auto" }, deps()));
    expect(out.ok).toBe(true);
    expect(JSON.parse(postureResponse(deps())).auto_switch).toBe("auto");
  });

  it("an off-vocabulary value is refused with the fixed error, nothing written", () => {
    const out = JSON.parse(savePostureResponse({ auto_switch: "silently-please" }, deps()));
    expect(out.ok).toBe(false);
    expect(out.error).toContain("bad_request");
    expect(fs.existsSync(prefsFile)).toBe(false);
  });

  it("an unparseable body is refused, never echoed", () => {
    const out = JSON.parse(savePostureResponse(undefined, deps()));
    expect(out.ok).toBe(false);
    expect(out.error).toContain("bad_request");
  });
});

describe("POST /amicode/posture/dismiss — dismissPostureResponse", () => {
  it("records the dismissal against the plan_hash and it reads back", () => {
    const hash = "7".repeat(64);
    const out = JSON.parse(dismissPostureResponse({ plan_hash: hash }, deps()));
    expect(out.ok).toBe(true);
    expect(JSON.parse(postureResponse(deps())).dismissed).toBe(false); // no plan carries that hash yet
    fs.writeFileSync(
      path.join(plansDir, "plan-20260907-d.md"),
      planNote({
        type: "plan", schema_version: "1", plan_id: "plan-d", goal: "d",
        plan_hash: hash, design_hash: "8".repeat(64),
        compiled_at: "2026-09-07T15:00:00.000Z",
        posture_recommendation: { kind: "recommend", mode: "develop", reason: "implementation-shaped plan: implement-slice" },
        steps: [],
      }),
    );
    expect(JSON.parse(postureResponse(deps())).dismissed).toBe(true);
  });

  it("a NEW plan_hash is not dismissed by an old dismissal", () => {
    fs.writeFileSync(prefsFile, JSON.stringify({ schema_version: 1, dismissed: { plan_hash: "9".repeat(64), ts: "t" } }));
    fs.writeFileSync(
      path.join(plansDir, "plan-20260907-e.md"),
      planNote({
        type: "plan", schema_version: "1", plan_id: "plan-e", goal: "e",
        plan_hash: "a1".padEnd(64, "0"), design_hash: "b1".padEnd(64, "0"),
        compiled_at: "2026-09-07T16:00:00.000Z",
        posture_recommendation: { kind: "recommend", mode: "research", reason: "experiment-shaped plan: experiment-sim" },
        steps: [],
      }),
    );
    expect(JSON.parse(postureResponse(deps())).dismissed).toBe(false);
  });

  it("a missing plan_hash is refused with the fixed error", () => {
    const out = JSON.parse(dismissPostureResponse({}, deps()));
    expect(out.ok).toBe(false);
    expect(out.error).toContain("bad_request");
  });
});
