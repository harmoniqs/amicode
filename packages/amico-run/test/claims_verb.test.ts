// `amico claims` (amicode #1681, brain flywheel slice 2 + #1682 slice 3): the
// claims registry's CLI surface — `project` (memory card → claim, dry-run by
// default), `lint` (contract + evidence-pointer resolution), and `render`
// (the hot-layer memory index as a GENERATED view of the registry, ranked by
// recency + adoption + confidence, #1682). Hermetic: fixture registries/vaults
// in temp dirs, and a fake personal mount (the .amico-vault.toml marker) for
// default-resolution checks — never the live vault.
// Run: `pnpm --filter @amicode/amico-run test claims`
import { describe, it, expect } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { claimsVerb } from "../src/claims_verb.js";
import { parseClaimNote } from "../src/claims.js";
import { validateClaim } from "@amicode/schema";
import { SPINE_VERBS } from "../src/verbs.js";
import { readDistillState } from "../src/distill.js";
import { INDEX_MAX_LINES } from "../src/claims.js";
import { loadPluginIndexReader, pluginMemoryIndexCap } from "./helpers.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, "fixtures", "claims");
const CARD_FILE = join(FIXTURES, "vault", "amicode", "memory", "project_two_qubit_challenge.md");

/** Parse a claim note, throwing on a bad parse — every file these tests read
 *  is a fixture the test just stamped; a bad parse is a test bug, never a
 *  pass state. */
function claimOf(raw: string): Record<string, unknown> {
  const parsed = parseClaimNote(raw);
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.claim;
}

/** A fake vault root with one personal mount (the marker convention) — the
 *  hermetic stand-in for resolveMountStack's default resolution. */
function fakeVaultRoot(): { root: string; mount: string } {
  const root = mkdtempSync(join(tmpdir(), "claims-vault-"));
  const mount = join(root, "vault-aaron");
  mkdirSync(join(mount, "amicode", "memory"), { recursive: true });
  mkdirSync(join(mount, "amicode", "claims"), { recursive: true });
  writeFileSync(join(mount, ".amico-vault.toml"), 'kind = "personal"\nname = "vault-aaron"\n');
  return { root, mount };
}

describe("amico claims project — the memory-card projection verb", () => {
  it("usage: no subcommand / unknown subcommand → usage error, exit 64", async () => {
    expect((await claimsVerb([], {})).code).toBe(64);
    expect((await claimsVerb(["frobnicate"], {})).code).toBe(64);
    expect(((await claimsVerb([], {})).json as { usage: string }).usage).toContain("amico claims");
  });

  it("dry-run by default: renders + validates, writes NOTHING", async () => {
    const out = mkdtempSync(join(tmpdir(), "claims-out-"));
    const r = await claimsVerb(["project", CARD_FILE, "--out", out], {});
    expect(r.code).toBe(0);
    const j = r.json as Record<string, unknown>;
    expect(j.dry_run).toBe(true);
    expect(j.type).toBe("insight");
    expect(j.statement).toContain("Two-qubit gates");
    expect(j.valid).toBe(true); // the in-process schema gate ran before reporting
    expect(existsSync(join(out, "project_two_qubit_challenge.md"))).toBe(false);
  });

  it("--apply writes the claim note, idempotently (same card + same clock → same path, same bytes)", async () => {
    const out = mkdtempSync(join(tmpdir(), "claims-out-"));
    const noon = () => new Date("2026-10-02T12:00:00.000Z");
    const first = await claimsVerb(["project", CARD_FILE, "--out", out, "--apply"], {}, { now: noon });
    expect(first.code).toBe(0);
    const file = join(out, "project_two_qubit_challenge.md");
    const bytes = readFileSync(file, "utf8");
    expect(bytes).toContain("type: insight");
    expect(bytes).toContain("memory-card/project_two_qubit_challenge.md");
    // second run with the same clock: same path, same bytes — no duplicate
    await claimsVerb(["project", CARD_FILE, "--out", out, "--apply"], {}, { now: noon });
    expect(readFileSync(file, "utf8")).toBe(bytes);
  });

  it("--type overrides the mechanical map; a bad type is a usage error", async () => {
    const out = mkdtempSync(join(tmpdir(), "claims-out-"));
    const r = await claimsVerb(["project", CARD_FILE, "--out", out, "--type", "hazard", "--apply"], {});
    expect(r.code).toBe(0);
    expect(readFileSync(join(out, "project_two_qubit_challenge.md"), "utf8")).toContain("type: hazard");
    const bad = await claimsVerb(["project", CARD_FILE, "--out", out, "--type", "rant"], {});
    expect(bad.code).toBe(64);
  });

  it("refuses an unknown card type and a missing card, writing nothing", async () => {
    const out = mkdtempSync(join(tmpdir(), "claims-out-"));
    const scratch = mkdtempSync(join(tmpdir(), "claims-card-"));
    const badCard = join(scratch, "bad.md");
    writeFileSync(badCard, "---\nname: x\ndescription: y\ntype: rant\n---\n\nbody\n");
    const r = await claimsVerb(["project", badCard, "--out", out, "--apply"], {});
    expect(r.code).toBe(64);
    expect((r.json as { error: string }).error).toContain("unknown memory-card type");
    expect(existsSync(join(out, "bad.md"))).toBe(false);

    const missing = await claimsVerb(["project", join(scratch, "nope.md"), "--out", out], {});
    expect(missing.code).toBe(64);
  });

  it("no personal mount and no --out → refuses to guess a vault (the distill doctrine)", async () => {
    const bare = mkdtempSync(join(tmpdir(), "claims-bare-")); // no mounts resolve
    const r = await claimsVerb(["project", CARD_FILE], { AMICO_VAULTS_ROOT: bare });
    expect(r.code).toBe(64);
    expect((r.json as { error: string }).error).toContain("--out");
  });

  it("defaults --out to the personal mount's amicode/claims/ subtree", async () => {
    const { root, mount } = fakeVaultRoot();
    writeFileSync(join(mount, "amicode", "memory", "project_two_qubit_challenge.md"), readFileSync(CARD_FILE, "utf8"));
    const r = await claimsVerb(["project", join(mount, "amicode", "memory", "project_two_qubit_challenge.md"), "--apply"], {
      AMICO_VAULTS_ROOT: root,
    });
    expect(r.code).toBe(0);
    expect(existsSync(join(mount, "amicode", "claims", "project_two_qubit_challenge.md"))).toBe(true);
  });
});

describe("amico claims lint — the registry gate verb", () => {
  it("a clean fixture registry lints clean: exit 0", async () => {
    const r = await claimsVerb(["lint", "--registry", join(FIXTURES, "registry"), "--vault", join(FIXTURES, "vault")], {});
    expect(r.code).toBe(0);
    const j = r.json as Record<string, unknown>;
    expect(j.clean).toBe(true);
    expect(j.files).toBe(1);
  });

  it("a dirty registry exits 1 with the findings, field-precise", async () => {
    const reg = mkdtempSync(join(tmpdir(), "claims-reg-"));
    writeFileSync(
      join(reg, "unknown-type.md"),
      "---\ntype: feedback\nstatement: an unprojected card\nstatus: unverified\nconfidence: medium\nevidence: []\napplied: 0\nlast_applied: null\nhistory: []\nscope: personal\ntags: []\n---\n\nbody\n",
    );
    const r = await claimsVerb(["lint", "--registry", reg, "--vault", join(FIXTURES, "vault")], {});
    expect(r.code).toBe(1);
    const j = r.json as Record<string, unknown>;
    expect(j.clean).toBe(false);
    expect((j.findings as string[]).some((f) => f.includes("unknown-type.md") && f.includes("/type"))).toBe(true);
  });

  it("defaults --registry and --vault to the personal mount (hermetic fake vault)", async () => {
    const { root, mount } = fakeVaultRoot();
    writeFileSync(join(mount, "amicode", "claims", "a.md"), readFileSync(join(FIXTURES, "registry", "project_two_qubit_challenge.md"), "utf8"));
    writeFileSync(join(mount, "amicode", "memory", "project_two_qubit_challenge.md"), readFileSync(CARD_FILE, "utf8"));
    const r = await claimsVerb(["lint"], { AMICO_VAULTS_ROOT: root });
    expect(r.code).toBe(0);
    expect((r.json as Record<string, unknown>).files).toBe(1);

    // no personal mount at all → refuse to guess, exit 64
    const bare = mkdtempSync(join(tmpdir(), "claims-bare-"));
    const none = await claimsVerb(["lint"], { AMICO_VAULTS_ROOT: bare });
    expect(none.code).toBe(64);
  });

  it("is registered as a spine verb (CLI dispatch + MCP facade, one impl)", () => {
    const claims = SPINE_VERBS.find((v) => v.name === "claims");
    expect(claims, "the claims verb is registered").toBeDefined();
    expect(claims!.summary).toContain("lint");
    expect(claims!.summary).toContain("render");
  });
});

// ── amico claims render — the hot-layer index verb (amicode #1682, slice 3:
// MEMORY.md becomes a generated view of the claims registry) ──────────────────

describe("amico claims render — the hot-layer index verb (#1682)", () => {
  const NOON = () => new Date("2026-10-02T12:00:00.000Z");
  const RENDER_REGISTRY = join(FIXTURES, "render-registry");

  /** A one-claim registry in a temp dir — the minimal live set. */
  function registryWithOneClaim(): string {
    const dir = mkdtempSync(join(tmpdir(), "claims-render-"));
    writeFileSync(
      join(dir, "only.md"),
      "---\ntype: insight\nstatement: the only claim\nstatus: unverified\nconfidence: medium\nevidence: []\napplied: 0\nlast_applied: null\nhistory:\n  - date: 2026-09-01T00:00:00.000Z\n    event: created\n    note: f\nscope: personal\ntags: []\n---\n\nbody\n",
    );
    return dir;
  }

  it("usage errors: unknown flag → 64; missing registry → 64; no mount and no --registry/--out → refuses to guess", async () => {
    const bad = await claimsVerb(["render", "--bogus"], {});
    expect(bad.code).toBe(64);

    const missing = await claimsVerb(["render", "--registry", join(tmpdir(), "definitely-absent-registry")], {});
    expect(missing.code).toBe(64);
    expect((missing.json as { error: string }).error).toContain("claims registry not found");

    const bare = mkdtempSync(join(tmpdir(), "claims-bare-")); // no mount resolves
    const noMount = await claimsVerb(["render"], { AMICO_VAULTS_ROOT: bare });
    expect(noMount.code).toBe(64);
    expect((noMount.json as { error: string }).error).toContain("--registry");

    const noOut = await claimsVerb(["render", "--registry", registryWithOneClaim()], { AMICO_VAULTS_ROOT: bare });
    expect(noOut.code).toBe(64);
    expect((noOut.json as { error: string }).error).toContain("--out");
  });

  it("refuses to overwrite the index with an EMPTY view: zero live claims → 64, naming the dead ones", async () => {
    const empty = mkdtempSync(join(tmpdir(), "claims-empty-"));
    const r = await claimsVerb(["render", "--registry", empty, "--out", join(empty, "MEMORY.md")], {});
    expect(r.code).toBe(64);
    expect((r.json as { error: string }).error).toContain("no live claims");

    const allDead = mkdtempSync(join(tmpdir(), "claims-dead-"));
    writeFileSync(
      join(allDead, "dead.md"),
      "---\ntype: insight\nstatement: dead\nstatus: refuted\nconfidence: medium\nevidence: []\napplied: 0\nlast_applied: null\nhistory:\n  - date: 2026-09-01T00:00:00.000Z\n    event: refuted\n    note: f\nscope: personal\ntags: []\n---\n\nbody\n",
    );
    const dead = await claimsVerb(["render", "--registry", allDead, "--out", join(allDead, "MEMORY.md")], {});
    expect(dead.code).toBe(64);
    expect((dead.json as { error: string }).error).toContain("refuted");
  });

  it("dry-run by default: renders + reports, writes NOTHING", async () => {
    const { root, mount } = fakeVaultRoot();
    const r = await claimsVerb(["render", "--registry", RENDER_REGISTRY], { AMICO_VAULTS_ROOT: root }, { now: NOON });
    expect(r.code).toBe(0);
    const j = r.json as Record<string, unknown>;
    expect(j.dry_run).toBe(true);
    expect(j.bullets).toBe(3); // 5 fixture claims − 1 refuted − 1 superseded
    expect(existsSync(join(mount, "amicode", "memory", "MEMORY.md"))).toBe(false);
    // the full rendered view rides the json — the caller can inspect before applying
    expect((j.rendered as string).startsWith("<!--\ngenerated view")).toBe(true);
  });

  it("--apply writes the index at the default out (<mount>/amicode/memory/MEMORY.md); --cap-per-type caps domains", async () => {
    const { root, mount } = fakeVaultRoot();
    writeFileSync(join(mount, "amicode", "claims", "a.md"), readFileSync(join(RENDER_REGISTRY, "best_practice_warm_start.md"), "utf8"));
    writeFileSync(join(mount, "amicode", "claims", "b.md"), readFileSync(join(RENDER_REGISTRY, "insight_recent_unverified.md"), "utf8"));
    writeFileSync(join(mount, "amicode", "claims", "c.md"), readFileSync(join(RENDER_REGISTRY, "insight_two_qubit_challenge.md"), "utf8"));

    // default registry (the mount's amicode/claims) + default out
    const r = await claimsVerb(["render", "--apply"], { AMICO_VAULTS_ROOT: root }, { now: NOON });
    expect(r.code).toBe(0);
    const file = join(mount, "amicode", "memory", "MEMORY.md");
    expect(existsSync(file)).toBe(true);
    expect(readFileSync(file, "utf8").split("\n").filter((l) => l.startsWith("- ")).length).toBe(3);

    // per-domain cap 1: 2 insight claims → 1 insight bullet + the best-practice
    const capped = await claimsVerb(["render", "--registry", RENDER_REGISTRY, "--out", join(mount, "amicode", "memory", "MEMORY.md"), "--apply", "--cap-per-type", "1"], {}, { now: NOON });
    expect(capped.code).toBe(0);
    const bullets = readFileSync(join(mount, "amicode", "memory", "MEMORY.md"), "utf8").split("\n").filter((l) => l.startsWith("- "));
    expect(bullets.length).toBe(2);
    expect(bullets.some((b) => b.includes("../claims/best_practice_warm_start.md"))).toBe(true);

    const badCap = await claimsVerb(["render", "--registry", RENDER_REGISTRY, "--cap-per-type", "0"], {});
    expect(badCap.code).toBe(64);
  });

  it("idempotent + regenerate-away: apply → HAND-EDIT → re-apply (same clock) → byte-identical to the first render", async () => {
    const { root, mount } = fakeVaultRoot();
    const out = join(mount, "amicode", "memory", "MEMORY.md");
    const first = await claimsVerb(["render", "--registry", RENDER_REGISTRY, "--out", out, "--apply"], {}, { now: NOON });
    expect(first.code).toBe(0);
    const bytes = readFileSync(out, "utf8");

    // the hand-edit the doctrine discards
    writeFileSync(out, bytes + "- [hand-added](../claims/nope.md) — a hand edit that must not survive\n");

    const second = await claimsVerb(["render", "--registry", RENDER_REGISTRY, "--out", out, "--apply"], {}, { now: NOON });
    expect(second.code).toBe(0);
    expect(readFileSync(out, "utf8")).toBe(bytes);
    expect((second.json as Record<string, unknown>).bullets).toBe((first.json as Record<string, unknown>).bullets);
  });

  it("the REAL plugin reader (byte-extracted from the extension's stack_state.ts) parses the generated output unchanged", async () => {
    const { root, mount } = fakeVaultRoot();
    const out = join(mount, "amicode", "memory", "MEMORY.md");
    const r = await claimsVerb(["render", "--registry", RENDER_REGISTRY, "--out", out, "--apply"], {}, { now: NOON });
    expect(r.code).toBe(0);

    // the actual readIndexLines from the plugin source, over the actual file
    const read = loadPluginIndexReader();
    const bullets = read(mount, join("memory", "MEMORY.md"), 50);
    const expected = readFileSync(out, "utf8")
      .split("\n")
      .filter((l) => l.startsWith("- "));
    expect(bullets).toEqual(expected); // every bullet survives the reader, order preserved
    expect(bullets.length).toBe(3);

    // and the plugin's call-site cap IS the renderer's hard cap (never emit
    // what the reader truncates)
    expect(pluginMemoryIndexCap()).toBe(INDEX_MAX_LINES);
  });
});

// readDistillState re-export sanity: the distill seam stays importable beside
// the claims seam (one substrate, one CLI).
it("the distill state seam remains untouched by this slice", () => {
  expect(readDistillState(join(tmpdir(), "definitely-absent-state.json")).entries).toEqual({});
});

// ── amico claims stamp — the adoption verb (amicode #1683, slice 4: the
// feedback loop closes — knowledge USED reaches the card) ────────────────────

describe("amico claims stamp — the adoption verb (#1683)", () => {
  const STAMP_AT = () => new Date("2026-10-02T21:00:00.000Z");
  const STAMP_REGISTRY = join(FIXTURES, "stamp-registry");
  const PROBLEMS = join(FIXTURES, "sweep-problems");

  /** A temp copy of the stamp registry — stamps mutate the registry, and the
   * committed fixture is the contract, never the scratch space. */
  function registryCopy(): string {
    const dir = mkdtempSync(join(tmpdir(), "claims-stamp-"));
    for (const f of readdirSync(STAMP_REGISTRY)) writeFileSync(join(dir, f), readFileSync(join(STAMP_REGISTRY, f)));
    return dir;
  }

  it("the committed stamp fixtures are valid claims (the fixture of record IS the contract)", () => {
    for (const f of readdirSync(STAMP_REGISTRY)) {
      const parsed = parseClaimNote(readFileSync(join(STAMP_REGISTRY, f), "utf8"));
      expect(parsed.ok).toBe(true);
      if (parsed.ok) expect(validateClaim(parsed.claim).ok).toBe(true);
    }
  });

  it("an accepted recommend-outcome referencing the claim stamps it: applied +1, last_applied set, ONE applied history entry", async () => {
    const reg = registryCopy();
    const r = await claimsVerb(
      ["stamp", "feedback_warm_starts.md", "--via", "recommend-outcome", "--ref", "demo-quad-gate/2", "--registry", reg, "--apply"],
      { AMICODE_PROBLEMS_DIR: PROBLEMS },
      { now: STAMP_AT },
    );
    expect(r.code).toBe(0);
    const j = r.json as Record<string, unknown>;
    expect(j.stamped).toBe(true);
    expect(j.dry_run).toBe(false);
    const parsed = claimOf(readFileSync(join(reg, "feedback_warm_starts.md"), "utf8"));
    expect(parsed.applied).toBe(1);
    expect(parsed.last_applied).toBe("2026-10-02T21:00:00.000Z");
    const history = parsed.history as { event: string; note: string }[];
    expect(history).toHaveLength(2); // ONE new entry, appended
    expect(history[1].event).toBe("applied");
    expect(history[1].note).toContain("demo-quad-gate/2"); // the citation rides the note
  });

  it("dry-run by default: reports the stamp, writes NOTHING", async () => {
    const reg = registryCopy();
    const before = readFileSync(join(reg, "feedback_warm_starts.md"), "utf8");
    const r = await claimsVerb(
      ["stamp", "feedback_warm_starts.md", "--via", "recommend-outcome", "--ref", "demo-quad-gate/2", "--registry", reg],
      { AMICODE_PROBLEMS_DIR: PROBLEMS },
      { now: STAMP_AT },
    );
    expect(r.code).toBe(0);
    expect((r.json as Record<string, unknown>).dry_run).toBe(true);
    expect(readFileSync(join(reg, "feedback_warm_starts.md"), "utf8")).toBe(before); // untouched
  });

  it("refuses an OVERRIDDEN outcome even though its recommendation's ref would resolve — an override is a human declining, not a use", async () => {
    const reg = registryCopy();
    const r = await claimsVerb(
      ["stamp", "two_qubit_challenge.md", "--via", "recommend-outcome", "--ref", "demo-quad-gate/4", "--registry", reg, "--apply"],
      { AMICODE_PROBLEMS_DIR: PROBLEMS },
    );
    expect(r.code).toBe(64);
    expect((r.json as { error: string }).error).toContain("only ACCEPTED");
    // and nothing moved
    const parsed = claimOf(readFileSync(join(reg, "two_qubit_challenge.md"), "utf8"));
    expect(parsed.applied).toBe(0);
  });

  it("refuses citations that do not resolve: unknown problem, unknown event seq, a non-recommendation event", async () => {
    const reg = registryCopy();
    const env = { AMICODE_PROBLEMS_DIR: PROBLEMS };
    const noProblem = await claimsVerb(["stamp", "feedback_warm_starts.md", "--via", "recommend-outcome", "--ref", "no-such-problem/2", "--registry", reg], env);
    expect(noProblem.code).toBe(64);
    const noSeq = await claimsVerb(["stamp", "feedback_warm_starts.md", "--via", "recommend-outcome", "--ref", "demo-quad-gate/99", "--registry", reg], env);
    expect(noSeq.code).toBe(64);
    // seq 6 in the fixture is a system-recorded event, not a recommendation
    const wrongEntity = await claimsVerb(["stamp", "feedback_warm_starts.md", "--via", "recommend-outcome", "--ref", "demo-quad-gate/6", "--registry", reg], env);
    expect(wrongEntity.code).toBe(64);
  });

  it("usage errors: missing --via / --ref, unknown --via, unknown claim, malformed ref", async () => {
    const reg = registryCopy();
    expect((await claimsVerb(["stamp", "a.md"], {})).code).toBe(64);
    expect((await claimsVerb(["stamp", "a.md", "--via", "recommend-outcome"], {})).code).toBe(64);
    expect((await claimsVerb(["stamp", "a.md", "--via", "vibe", "--ref", "x/1"], {})).code).toBe(64);
    expect((await claimsVerb(["stamp", "absent.md", "--via", "recommend-outcome", "--ref", "demo-quad-gate/2", "--registry", reg], {})).code).toBe(64);
    expect((await claimsVerb(["stamp", "a.md", "--via", "recommend-outcome", "--ref", "no-slash-here", "--registry", reg], {})).code).toBe(64);
  });

  it("idempotent: re-stamping the SAME citation moves NOTHING — the file is byte-identical", async () => {
    const reg = registryCopy();
    const env = { AMICODE_PROBLEMS_DIR: PROBLEMS };
    await claimsVerb(["stamp", "feedback_warm_starts.md", "--via", "recommend-outcome", "--ref", "demo-quad-gate/2", "--registry", reg, "--apply"], env, { now: STAMP_AT });
    const bytes = readFileSync(join(reg, "feedback_warm_starts.md"), "utf8");
    const again = await claimsVerb(
      ["stamp", "feedback_warm_starts.md", "--via", "recommend-outcome", "--ref", "demo-quad-gate/2", "--registry", reg, "--apply"],
      env,
      { now: () => new Date("2026-10-09T04:00:00.000Z") }, // a later clock must NOT move last_applied
    );
    expect(again.code).toBe(0);
    expect((again.json as Record<string, unknown>).stamped).toBe(false);
    expect(readFileSync(join(reg, "feedback_warm_starts.md"), "utf8")).toBe(bytes);
  });

  it("AC 3, byte-level: a stamp preserves statement + status + confidence + evidence + scope + tags AND the prose body verbatim", async () => {
    const reg = registryCopy();
    const before = readFileSync(join(reg, "feedback_warm_starts.md"), "utf8");
    const r = await claimsVerb(
      ["stamp", "feedback_warm_starts.md", "--via", "recommend-outcome", "--ref", "second-problem/2", "--registry", reg, "--apply"],
      { AMICODE_PROBLEMS_DIR: PROBLEMS },
      { now: STAMP_AT },
    );
    expect(r.code).toBe(0);
    const after = readFileSync(join(reg, "feedback_warm_starts.md"), "utf8");

    const beforeClaim = claimOf(before);
    const afterClaim = claimOf(after);
    expect(afterClaim.statement).toBe(beforeClaim.statement);
    expect(afterClaim.status).toBe(beforeClaim.status); // lifecycle is slice 5's, never the stamp's
    expect(afterClaim.confidence).toBe(beforeClaim.confidence);
    expect(afterClaim.evidence).toEqual(beforeClaim.evidence);
    expect(afterClaim.scope).toBe(beforeClaim.scope);
    expect(afterClaim.tags).toEqual(beforeClaim.tags);
    // the body survives VERBATIM — machinery never edits prose
    expect(after.slice(after.indexOf("---", 3))).toBe(before.slice(before.indexOf("---", 3)));
    expect(after).toContain("survive a stamp VERBATIM");
  });

  it("AC 2: a citation in a solve run stamps the cited claim (run dir must exist)", async () => {
    const reg = registryCopy();
    const runs = mkdtempSync(join(tmpdir(), "claims-runs-"));
    const runDir = join(runs, "r20261002-090000Z-ab12");
    mkdirSync(runDir); // the run dir IS the substrate a citation resolves into
    const r = await claimsVerb(
      ["stamp", "feedback_warm_starts.md", "--via", "solve-run", "--ref", runDir, "--detail", "warm-started from the banked pulse", "--registry", reg, "--apply"],
      {},
      { now: STAMP_AT },
    );
    expect(r.code).toBe(0);
    const parsed = claimOf(readFileSync(join(reg, "feedback_warm_starts.md"), "utf8"));
    expect(parsed.applied).toBe(1);
    expect(parsed.last_applied).toBe("2026-10-02T21:00:00.000Z");
    const entry = (parsed.history as { event: string; note: string }[])[1];
    expect(entry.event).toBe("applied");
    expect(entry.note).toContain("solve-run r20261002-090000Z-ab12"); // the run id is the citation
    expect(entry.note).toContain("warm-started from the banked pulse");

    // re-citing the SAME run (a different path alias to the same dir) is still the same citation → no-op
    const alias = join(runs, ".", "r20261002-090000Z-ab12");
    const again = await claimsVerb(["stamp", "feedback_warm_starts.md", "--via", "solve-run", "--ref", alias, "--registry", reg, "--apply"], {}, { now: STAMP_AT });
    expect(again.code).toBe(0);
    expect((again.json as Record<string, unknown>).stamped).toBe(false);
    expect(claimOf(readFileSync(join(reg, "feedback_warm_starts.md"), "utf8")).applied).toBe(1);
  });

  it("refuses a solve-run citation whose run dir does not exist (pointers must resolve)", async () => {
    const reg = registryCopy();
    const r = await claimsVerb(
      ["stamp", "feedback_warm_starts.md", "--via", "solve-run", "--ref", join(tmpdir(), "definitely-absent-run"), "--registry", reg],
      {},
    );
    expect(r.code).toBe(64);
    expect((r.json as { error: string }).error).toContain("does not resolve");
  });

});

// ── amico claims sweep — the nightly backfill (#1683, AC 4: stamps from the
// persisted event streams, re-sweep changes nothing) ──────────────────────────

describe("amico claims sweep — the nightly adoption backfill (#1683)", () => {
  const SWEEP_AT = () => new Date("2026-10-03T04:00:00.000Z");
  const PROBLEMS = join(FIXTURES, "sweep-problems");

  function registryCopy(): string {
    const dir = mkdtempSync(join(tmpdir(), "claims-sweep-"));
    for (const f of readdirSync(join(FIXTURES, "stamp-registry"))) {
      writeFileSync(join(dir, f), readFileSync(join(FIXTURES, "stamp-registry", f)));
    }
    return dir;
  }

  it("backfills stamps from the recommend-outcome event stream: accepted outcomes stamp, overridden never, unresolved refs are named", async () => {
    const reg = registryCopy();
    const r = await claimsVerb(["sweep", "--registry", reg, "--problems", PROBLEMS, "--apply"], {}, { now: SWEEP_AT });
    expect(r.code).toBe(0);
    const j = r.json as Record<string, unknown>;
    expect(j.dry_run).toBe(false);
    expect(j.stamped).toBe(3); // demo-quad-gate/2, demo-quad-gate/5 (Veloce), second-problem/2

    // feedback_warm_starts.md: TWO stamps (one per problem's accepted N outcome)
    const warm = claimOf(readFileSync(join(reg, "feedback_warm_starts.md"), "utf8"));
    expect(warm.applied).toBe(2);
    expect(warm.last_applied).toBe("2026-10-03T04:00:00.000Z");
    const warmHistory = warm.history as { event: string; note: string }[];
    expect(warmHistory.filter((h) => h.event === "applied").map((h) => h.note)).toEqual([
      "applied via recommend-outcome demo-quad-gate/2",
      "applied via recommend-outcome second-problem/2",
    ]);

    // two_qubit_challenge.md: ONE stamp — the Veloce auto-accept (seq 5), NOT the
    // overridden outcome (seq 4) even though its recommendation's ref resolves
    const two = claimOf(readFileSync(join(reg, "two_qubit_challenge.md"), "utf8"));
    expect(two.applied).toBe(1);
    expect((two.history as { note: string }[])[1].note).toContain("demo-quad-gate/5");

    // the accepted outcome whose ref matches NO registry claim is named, never guessed
    expect((j.skipped_refs as string[]).some((s) => s.includes("transmon-rwa-breakdown.md"))).toBe(true);
  });

  it("dry-run by default: reports the plan, writes NOTHING", async () => {
    const reg = registryCopy();
    const before = readFileSync(join(reg, "feedback_warm_starts.md"), "utf8");
    const r = await claimsVerb(["sweep", "--registry", reg, "--problems", PROBLEMS], {}, { now: SWEEP_AT });
    expect(r.code).toBe(0);
    expect((r.json as Record<string, unknown>).dry_run).toBe(true);
    expect(readFileSync(join(reg, "feedback_warm_starts.md"), "utf8")).toBe(before);
  });

  it("idempotent (AC 4): a re-sweep changes NOTHING — every registry byte identical, stamped 0, already-stamped counted", async () => {
    const reg = registryCopy();
    await claimsVerb(["sweep", "--registry", reg, "--problems", PROBLEMS, "--apply"], {}, { now: SWEEP_AT });
    const bytes = Object.fromEntries(readdirSync(reg).map((f) => [f, readFileSync(join(reg, f), "utf8")]));

    const again = await claimsVerb(
      ["sweep", "--registry", reg, "--problems", PROBLEMS, "--apply"],
      {},
      { now: () => new Date("2026-10-04T04:00:00.000Z") }, // a night later — the clock must not move anything
    );
    expect(again.code).toBe(0);
    const j = again.json as Record<string, unknown>;
    expect(j.stamped).toBe(0);
    expect(j.already).toBe(3);
    for (const f of readdirSync(reg)) expect(readFileSync(join(reg, f), "utf8")).toBe(bytes[f]);
  });

  it("usage: missing registry → 64; missing problems root → 64; no mount and no --registry → refuses to guess", async () => {
    const bare = mkdtempSync(join(tmpdir(), "claims-bare-"));
    const noMount = await claimsVerb(["sweep", "--problems", PROBLEMS], { AMICO_VAULTS_ROOT: bare });
    expect(noMount.code).toBe(64);
    expect((noMount.json as { error: string }).error).toContain("--registry");

    const noRegistry = await claimsVerb(["sweep", "--registry", join(tmpdir(), "absent-registry"), "--problems", PROBLEMS], {});
    expect(noRegistry.code).toBe(64);

    const reg = registryCopy();
    const noProblems = await claimsVerb(["sweep", "--registry", reg, "--problems", join(tmpdir(), "absent-problems")], {});
    expect(noProblems.code).toBe(64);
    expect((noProblems.json as { error: string }).error).toContain("problems");
  });

  it("is registered on the spine (CLI dispatch + MCP facade, one impl) with the adoption verbs in the summary", () => {
    const claims = SPINE_VERBS.find((v) => v.name === "claims");
    expect(claims, "the claims verb is registered").toBeDefined();
    expect(claims!.summary).toContain("stamp");
    expect(claims!.summary).toContain("sweep");
  });
});
