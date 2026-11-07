// `amico notturno` (amicode #1669 — the #852 step-6 A1′ leg): the TS-native
// notturno surface — registry parse + coverage check, the warrant tiers as
// typed values, the pass runner, and the instance deny-list gate.
//
// PARITY OVER REWRITE: every verdict, message, and file byte below is the
// Python engine's shape (automation/notturno/registry.py + passes.py in
// amicissimo, post-#490). The ground truth was captured by RUNNING the
// Python engine at amicissimo 12e1141 against these very pinned fixtures
// (the parity run, 2026-10-01):
//   - the live registry snapshot parses to 12 jobs / 6 excludes and the
//     coverage verdict reads "coverage: total — 12 jobs, 6 excludes";
//   - every parse-error string is verbatim Python output;
//   - scheduled-passes.pyrender.md is the byte-exact output of three Python
//     `passes` appends (header-once + the section shape + round-trip).
// The instance deny-list fixture is the committed amicissimo boundary
// manifest — the format the public side consumes (amicissimo #490).
// Run: pnpm --filter @amicode/amico-run test notturno
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { notturnoVerb } from "../src/notturno_verb.js";
import { WARRANTS, SURFACES, RECORD_MODES, loadRegistry } from "../src/notturno_registry.js";
import { PASSES_HEADER, PASS_STATUSES, renderPass, appendSection } from "../src/notturno_passes.js";

const FIXTURES = join(__dirname, "fixtures", "notturno");
const REGISTRY_FIXTURE = join(FIXTURES, "notturno.toml");
const DENY_LIST_FIXTURE = join(FIXTURES, "instance-deny-list.toml");
const PYRENDER = join(FIXTURES, "scheduled-passes.pyrender.md");

// The amicissimo .github/workflows set at the parity commit — the on-disk
// truth the coverage verdict was computed against (18 files: 12 jobs + 6
// excludes).
const JOB_WORKFLOWS = [
  "notturno-briefs.yml",
  "fleet-digest.yml",
  "vault-hygiene.yml",
  "coordination-board.yml",
  "notturno-triage.yml",
  "notturno-profile-autoupdate.yml",
  "notturno-assign.yml",
  "notturno-intake.yml",
  "weekly-synthesis.yml",
  "doctor-watchdog.yml",
  "canary.yml",
  "notturno-merge-sentinel.yml",
];
const EXCLUDE_WORKFLOWS = [
  "notturno-smoke.yml",
  "amicobot-query.yml",
  "retrieval-benchmark.yml",
  "vault-tombstone-guard.yml",
  "intent-merge-receipt.yml",
  "notturno-registry-check.yml",
];
const ALL_WORKFLOWS = [...JOB_WORKFLOWS, ...EXCLUDE_WORKFLOWS];

// The six ids retired out of the registry (amicobot retirement 2026-08-10 +
// the weekly-synthesis subsume 2026-09-05): retirement = entry REMOVED, so
// the parse ignores their comment blocks and none of these ids is a job.
const RETIRED_IDS = [
  "notturno-morning-brief",
  "eod-checkin",
  "news-arxiv",
  "news-tech",
  "team-notify",
  "notturno-architecture",
];

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "notturno-test-"));
  delete process.env.AMICO_NOTTURNO_REGISTRY;
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  delete process.env.AMICO_NOTTURNO_REGISTRY;
});

const run = (args: string[]) => {
  const r = notturnoVerb(args);
  return { code: r.code, json: r.json as Record<string, unknown> };
};

function workflows(names: string[], at = join(dir, "workflows")): string {
  mkdirSync(at, { recursive: true });
  for (const n of names) writeFileSync(join(at, n), "name: fixture\n");
  return at;
}

function tinyRegistry(toml: string, name = "registry.toml"): string {
  const p = join(dir, name);
  writeFileSync(p, toml);
  return p;
}

/** The amicissimo instance layout under <root>: registry (and optionally the
 *  deny manifest) at automation/notturno/, workflows at .github/workflows/.
 *  Both walk-up discoveries (deny manifest, workflows dir) hit this shape. */
function instanceLayout(root: string, withDenyList: boolean): string {
  const ntDir = join(root, "automation", "notturno");
  mkdirSync(ntDir, { recursive: true });
  copyFileSync(REGISTRY_FIXTURE, join(ntDir, "notturno.toml"));
  if (withDenyList) copyFileSync(DENY_LIST_FIXTURE, join(ntDir, "instance-deny-list.toml"));
  workflows(ALL_WORKFLOWS, join(root, ".github", "workflows"));
  return join(ntDir, "notturno.toml");
}

describe("amico notturno registry-check — parity with the Python registry", () => {
  it("byte-equivalent verdict on the pinned live-registry snapshot: total, 12 jobs / 6 excludes, exit 0", () => {
    const wf = workflows(ALL_WORKFLOWS);
    // NOTE: the pinned deny manifest sits BESIDE this fixture registry, so
    // deny-list discovery finds it and lets it pass (the fixture path matches
    // no deny row) — the gate is row-keyed, and a clean tree carrying the
    // reference manifest is the gate's own no-op proof.
    const { code, json } = run(["registry-check", "--registry", REGISTRY_FIXTURE, "--workflows-dir", wf]);
    expect(code).toBe(0);
    expect(json.verdict).toBe("coverage: total — 12 jobs, 6 excludes");
    expect(json).toMatchObject({ verb: "notturno", subcommand: "registry-check", ok: true, jobs: 12, excludes: 6, problems: [] });
    expect(json.workflows_dir).toBe(wf);
  });

  it("an unregistered workflow on disk is the Python's exact problem, exit 1", () => {
    const wf = workflows([...ALL_WORKFLOWS, "mystery.yml"]);
    const { code, json } = run(["registry-check", "--registry", REGISTRY_FIXTURE, "--workflows-dir", wf]);
    expect(code).toBe(1);
    expect(json.ok).toBe(false);
    expect(json.problems).toEqual(["workflow 'mystery.yml' is neither a registered job nor an exclude"]);
  });

  it("multiple unregistered workflows are sorted (Python sorted() parity)", () => {
    const wf = workflows([...ALL_WORKFLOWS, "zzz.yml", "aaa.yml"]);
    const { code, json } = run(["registry-check", "--registry", REGISTRY_FIXTURE, "--workflows-dir", wf]);
    expect(code).toBe(1);
    expect(json.problems).toEqual([
      "workflow 'aaa.yml' is neither a registered job nor an exclude",
      "workflow 'zzz.yml' is neither a registered job nor an exclude",
    ]);
  });

  it("a missing job workflow and a missing exclude workflow are the Python's exact problems (category order)", () => {
    const wf = workflows(ALL_WORKFLOWS.filter((n) => n !== "fleet-digest.yml" && n !== "notturno-smoke.yml"));
    const { code, json } = run(["registry-check", "--registry", REGISTRY_FIXTURE, "--workflows-dir", wf]);
    expect(code).toBe(1);
    expect(json.problems).toEqual([
      `job workflow 'fleet-digest.yml' has no file in ${wf}`,
      `exclude workflow 'notturno-smoke.yml' has no file in ${wf}`,
    ]);
  });

  it("a missing workflows dir reads as empty (Python glob parity): every job + exclude is a problem", () => {
    const { code, json } = run(["registry-check", "--registry", REGISTRY_FIXTURE, "--workflows-dir", join(dir, "nope")]);
    expect(code).toBe(1);
    const problems = json.problems as string[];
    expect(problems).toHaveLength(18); // 12 jobs + 6 excludes, all "has no file"
    expect(problems[0]).toBe(`job workflow 'canary.yml' has no file in ${join(dir, "nope")}`);
  });

  it("the retirement contract: a retired job's workflow left on disk (entry removed, no exclude) is flagged", () => {
    const wf = workflows([...ALL_WORKFLOWS, "notturno-morning-brief.yml"]);
    const { code, json } = run(["registry-check", "--registry", REGISTRY_FIXTURE, "--workflows-dir", wf]);
    expect(code).toBe(1);
    expect(json.problems).toEqual(["workflow 'notturno-morning-brief.yml' is neither a registered job nor an exclude"]);
  });
});

describe("registry parse — byte-parity error strings (the Python _parse_job verdicts)", () => {
  const cases: Array<{ label: string; toml: string; message: string }> = [
    {
      label: "unknown surface",
      toml: '[job.bad]\nworkflow = "x.yml"\ncadence = "c"\nsurface = "nowhere"\nwarrant = "report"\n',
      message: "job 'bad': unknown surface 'nowhere' (expected one of ('github-hosted', 'erlich', 'mini'))",
    },
    {
      label: "unknown warrant",
      toml: '[job.bad]\nworkflow = "x.yml"\ncadence = "c"\nsurface = "erlich"\nwarrant = "someday"\n',
      message: "job 'bad': unknown warrant 'someday' (expected one of ('report', 'stage', 'gated'))",
    },
    {
      label: "missing required key",
      toml: '[job.bad]\ncadence = "c"\nsurface = "erlich"\nwarrant = "report"\n',
      message: "job 'bad': missing required key 'workflow'",
    },
    {
      label: "unknown record mode",
      toml: '[job.bad]\nworkflow = "x.yml"\ncadence = "c"\nsurface = "erlich"\nwarrant = "report"\nrecord = "never"\n',
      message: "job 'bad': unknown record 'never' (expected one of ('always', 'acted'))",
    },
    {
      label: "config not a table",
      toml: '[job.bad]\nworkflow = "x.yml"\ncadence = "c"\nsurface = "erlich"\nwarrant = "report"\nconfig = "oops"\n',
      message: "job 'bad': 'config' must be a [job.bad.config] table of paths, got str",
    },
  ];
  for (const c of cases) {
    it(`${c.label} → registry error exit 2, the Python's exact message`, () => {
      const p = tinyRegistry(c.toml);
      const { code, json } = run(["registry-check", "--registry", p, "--workflows-dir", workflows([])]);
      expect(code).toBe(2);
      expect(json.ok).toBe(false);
      expect(json.error).toBe(c.message);
    });
  }

  it("unparseable TOML → the Python's load-error prefix, exit 2", () => {
    const p = tinyRegistry("this is [ not toml\n");
    const { code, json } = run(["registry-check", "--registry", p, "--workflows-dir", workflows([])]);
    expect(code).toBe(2);
    expect((json.error as string).startsWith(`cannot load registry at ${p}: `)).toBe(true);
  });
});

describe("warrant semantics — typed tiers with the Python enum's coverage", () => {
  it("the enums are the Python's exact vocabulary", () => {
    expect(WARRANTS).toEqual(["report", "stage", "gated"]);
    expect(SURFACES).toEqual(["github-hosted", "erlich", "mini"]);
    expect(RECORD_MODES).toEqual(["always", "acted"]);
    expect(PASS_STATUSES).toEqual(["ok", "failed"]);
  });

  it("all three warrant tiers parse as typed values (gated coverage the live registry lacks)", () => {
    const p = tinyRegistry(
      [
        '[job.a]\nworkflow = "a.yml"\ncadence = "c"\nsurface = "erlich"\nwarrant = "report"\n',
        '[job.b]\nworkflow = "b.yml"\ncadence = "c"\nsurface = "erlich"\nwarrant = "stage"\n',
        '[job.c]\nworkflow = "c.yml"\ncadence = "c"\nsurface = "erlich"\nwarrant = "gated"\n',
      ].join(""),
    );
    const { code, json } = run(["list", "--registry", p]);
    expect(code).toBe(0);
    const warrants = (json.jobs as Array<Record<string, unknown>>).map((j) => j.warrant).sort();
    expect(warrants).toEqual(["gated", "report", "stage"]);
  });

  it("the pinned snapshot's warrant census: 9 report, 3 stage, 0 gated", () => {
    const { json } = run(["list", "--registry", REGISTRY_FIXTURE]);
    const counts: Record<string, number> = { report: 0, stage: 0, gated: 0 };
    for (const j of json.jobs as Array<Record<string, unknown>>) counts[j.warrant as string]!++;
    expect(counts).toEqual({ report: 9, stage: 3, gated: 0 });
  });
});

describe("amico notturno list — the registry slate as typed rows", () => {
  it("12 jobs sorted by id: canary's config table, briefs' acted mode, disabled-with-reason rows", () => {
    const { code, json } = run(["list", "--registry", REGISTRY_FIXTURE]);
    expect(code).toBe(0);
    expect(json.ok).toBe(true);
    const jobs = json.jobs as Array<Record<string, unknown>>;
    expect(jobs).toHaveLength(12);
    expect(jobs.map((j) => j.id)).toEqual([...jobs.map((j) => j.id)].sort());
    expect(jobs.find((j) => j.id === "canary")).toMatchObject({
      workflow: "canary.yml",
      surface: "erlich",
      warrant: "stage",
      enabled: true,
      record: "always",
      delivers: ["slack-channel", "issue"],
      config: { allowlist: "canary/known-reds.toml", state: "~/.amico/ops/fleet/canary-state.json" },
    });
    expect(jobs.find((j) => j.id === "notturno-briefs")).toMatchObject({ record: "acted", enabled: true });
    // disabled-with-reason: the registry documents the reason as comments; the
    // parsed row is the honest disabled state
    expect(jobs.find((j) => j.id === "doctor-watchdog")).toMatchObject({ enabled: false, surface: "mini" });
    expect(jobs.find((j) => j.id === "weekly-synthesis")).toMatchObject({ enabled: true, warrant: "stage" });
    const excludes = json.excludes as Array<Record<string, unknown>>;
    expect(excludes).toHaveLength(6);
    expect(excludes[0]).toEqual({
      workflow: "notturno-smoke.yml",
      reason: "substrate validation harness (opencode + Bedrock); manual-only by design",
    });
  });

  it("the retirement comment blocks stay comments: no retired id parses as a job", () => {
    const loaded = loadRegistry(REGISTRY_FIXTURE);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    const ids = loaded.registry.jobs.map((j) => j.id);
    expect(ids).toHaveLength(12);
    for (const retired of RETIRED_IDS) expect(ids).not.toContain(retired);
  });
});

describe("the instance deny list — the public CLI's load-bearing gate", () => {
  it("THE PLANTED VIOLATION: the org registry (a denied manifest row beside it) fails loudly — exit 64, named reason, pointing at the instance's runner", () => {
    const reg = instanceLayout(join(dir, "org-repo"), true);
    // no --deny-list flag: DISCOVERY must find the manifest beside the registry
    const { code, json } = run(["registry-check", "--registry", reg]);
    expect(code).toBe(64);
    expect(json.ok).toBe(false);
    expect(json.deny).toEqual({
      path: "automation/notturno/notturno.toml",
      reason: "the org's job registry entries — instance config by construction (#490)",
    });
    expect(json.hint).toContain("python -m automation.notturno.registry");
    expect(json.hint).toContain("amicissimo");
  });

  it("the same denial gates `list` and `pass` — org config never runs silently, and never gets written", () => {
    const reg = instanceLayout(join(dir, "org-repo"), true);
    const list = run(["list", "--registry", reg]);
    expect(list.code).toBe(64);
    expect(list.json.hint).toContain("python -m automation.notturno.registry");
    const dash = join(dir, "dash");
    const pass = run([
      "pass",
      "--job",
      "canary",
      "--status",
      "ok",
      "--outcome",
      "x",
      "--dashboards",
      dash,
      "--registry",
      reg,
    ]);
    expect(pass.code).toBe(64);
    expect(pass.json.hint).toContain("python -m automation.notturno.passes");
    expect(existsSync(join(dash, "scheduled-passes.md"))).toBe(false); // denied BEFORE any write
  });

  it("a directory deny row claims every file under it recursively (the manifest's own rule)", () => {
    const regDir = join(dir, "tree", "automation", "notturno", "briefs");
    mkdirSync(regDir, { recursive: true });
    copyFileSync(REGISTRY_FIXTURE, join(regDir, "notturno.toml"));
    writeFileSync(
      join(regDir, "instance-deny-list.toml"),
      '[[deny]]\npath = "automation/notturno/briefs"\nreason = "member briefs are instance content"\n',
    );
    const { code, json } = run([
      "registry-check",
      "--registry",
      join(regDir, "notturno.toml"),
      "--workflows-dir",
      workflows([]),
    ]);
    expect(code).toBe(64);
    expect(json.deny).toEqual({ path: "automation/notturno/briefs", reason: "member briefs are instance content" });
  });

  it("an explicit --deny-list is honored even when discovery cannot find it", () => {
    const ntDir = join(dir, "deep", "automation", "notturno");
    mkdirSync(ntDir, { recursive: true });
    copyFileSync(REGISTRY_FIXTURE, join(ntDir, "notturno.toml"));
    const manifestDir = join(dir, "elsewhere");
    mkdirSync(manifestDir, { recursive: true });
    const manifest = join(manifestDir, "instance-deny-list.toml"); // NOT beside the registry
    writeFileSync(manifest, '[[deny]]\npath = "automation/notturno/notturno.toml"\nreason = "instance registry — denied"\n');
    const { code, json } = run([
      "registry-check",
      "--registry",
      join(ntDir, "notturno.toml"),
      "--workflows-dir",
      workflows([]),
      "--deny-list",
      manifest,
    ]);
    expect(code).toBe(64);
    expect(json.deny).toEqual({ path: "automation/notturno/notturno.toml", reason: "instance registry — denied" });
  });

  it("a manifest whose rows do not match lets a public registry pass (the gate is row-keyed)", () => {
    const pub = join(dir, "pub");
    mkdirSync(pub, { recursive: true });
    copyFileSync(REGISTRY_FIXTURE, join(pub, "registry.toml"));
    const manifest = join(dir, "m.toml");
    writeFileSync(manifest, '[[deny]]\npath = "some/other/path.toml"\nreason = "unrelated"\n');
    const wf = workflows(ALL_WORKFLOWS);
    const { code, json } = run([
      "registry-check",
      "--registry",
      join(pub, "registry.toml"),
      "--workflows-dir",
      wf,
      "--deny-list",
      manifest,
    ]);
    expect(code).toBe(0);
    expect(json.verdict).toBe("coverage: total — 12 jobs, 6 excludes");
  });

  it("a malformed deny-list manifest fails loudly — the gate never opens on a broken input", () => {
    const manifest = tinyRegistry("this is [ not toml\n", "broken-deny.toml");
    const { code, json } = run([
      "registry-check",
      "--registry",
      REGISTRY_FIXTURE,
      "--workflows-dir",
      workflows(ALL_WORKFLOWS),
      "--deny-list",
      manifest,
    ]);
    expect(code).toBe(2);
    expect(json.error).toContain("cannot load deny list");
  });

  it("the deny-list modules are pure data: the pinned manifest parses to 14 deny rows with reasons", () => {
    const manifest = readFileSync(DENY_LIST_FIXTURE, "utf8");
    // count [[deny]] rows in the committed manifest — the total CORE/INSTANCE
    // classification (amicissimo #490's 14 deny rows)
    expect((manifest.match(/\[\[deny\]\]/g) ?? []).length).toBe(14);
    expect((manifest.match(/\[\[core\]\]/g) ?? []).length).toBe(10);
  });
});

describe("usage — the honest no-defaults posture of a public binary", () => {
  it("no --registry (and no env) → usage error 64", () => {
    const { code, json } = run(["registry-check"]);
    expect(code).toBe(64);
    expect(json.error).toContain("--registry");
  });

  it("AMICO_NOTTURNO_REGISTRY is the default registry path", () => {
    process.env.AMICO_NOTTURNO_REGISTRY = REGISTRY_FIXTURE;
    const wf = workflows(ALL_WORKFLOWS);
    const { code } = run(["registry-check", "--workflows-dir", wf]);
    expect(code).toBe(0);
  });

  it("no workflows dir discoverable above the registry → usage error 64 naming --workflows-dir", () => {
    // the bare tmpdir has no .github ancestor — the amicode repo's own
    // .github/workflows must NOT be found from here
    const p = tinyRegistry(readFileSync(REGISTRY_FIXTURE, "utf8"));
    const { code, json } = run(["registry-check", "--registry", p]);
    expect(code).toBe(64);
    expect(json.error).toContain("--workflows-dir");
  });

  it("walk-up discovery: the public twin of the instance layout passes with NO explicit flags", () => {
    const reg = instanceLayout(join(dir, "clean-repo"), false);
    const { code, json } = run(["registry-check", "--registry", reg]);
    expect(code).toBe(0);
    expect(json.verdict).toBe("coverage: total — 12 jobs, 6 excludes");
    expect(json.workflows_dir).toBe(join(dir, "clean-repo", ".github", "workflows"));
  });

  it("unknown subcommand → usage 64", () => {
    const { code, json } = run(["frobnicate"]);
    expect(code).toBe(64);
    expect(json.usage).toBeDefined();
  });
});

describe("the pass runner — byte parity with the Python bot's scheduled-passes.md", () => {
  const when = new Date("2026-10-01T15:04:05Z"); // UTC date 2026-10-01 — the parity run's date

  it("renderPass reproduces the Python render byte-for-byte (duration + artifacts)", () => {
    expect(
      renderPass({
        job: "canary",
        status: "ok",
        outcome: "staging slots clean",
        duration_s: 42,
        artifacts: ["https://example.test/run/1"],
        when,
      }),
    ).toBe("## Pass 2026-10-01 — canary — ok\n\n- staging slots clean\n- duration: 42s\n- artifacts:\n  - https://example.test/run/1\n");
  });

  it("a bare record renders the minimal section (no duration, no artifacts)", () => {
    expect(
      renderPass({ job: "fleet-digest", status: "failed", outcome: "mini unreachable", duration_s: null, artifacts: [], when }),
    ).toBe("## Pass 2026-10-01 — fleet-digest — failed\n\n- mini unreachable\n");
  });

  it("PASSES_HEADER is byte-identical to the Python bot's header (one file, two runners, one format)", () => {
    expect(readFileSync(PYRENDER, "utf8").startsWith(PASSES_HEADER + "\n")).toBe(true);
  });

  it("ROUND-TRIP: a TS append onto the Python-rendered file is byte-identical to the Python append idiom", () => {
    const dash = join(dir, "dashboards");
    mkdirSync(dash, { recursive: true });
    copyFileSync(PYRENDER, join(dash, "scheduled-passes.md"));
    const target = appendSection(
      dash,
      renderPass({ job: "vault-hygiene", status: "ok", outcome: "tombstones verified", duration_s: 7, artifacts: [], when }),
    );
    expect(target).toBe(join(dash, "scheduled-passes.md"));
    const expected =
      readFileSync(PYRENDER, "utf8").replace(/\n+$/, "") +
      "\n\n## Pass 2026-10-01 — vault-hygiene — ok\n\n- tombstones verified\n- duration: 7s\n";
    expect(readFileSync(target, "utf8")).toBe(expected);
  });

  it("header-once: the first write on an empty dir creates the file with header + section (the Python fresh-file shape)", () => {
    const dash = join(dir, "fresh");
    const target = appendSection(dash, renderPass({ job: "only", status: "ok", outcome: "o", duration_s: null, artifacts: [], when }));
    expect(readFileSync(target, "utf8")).toBe(PASSES_HEADER + "\n" + "## Pass 2026-10-01 — only — ok\n\n- o\n");
  });
});

describe("amico notturno pass — the CLI recorder", () => {
  it("records a pass: exit 0, target named, the file is the header + today's UTC section, repeatable artifacts", () => {
    const dash = join(dir, "d");
    const { code, json } = run([
      "pass",
      "--job",
      "canary",
      "--status",
      "ok",
      "--outcome",
      "staging slots clean",
      "--duration-s",
      "42",
      "--artifact",
      "https://example.test/run/1",
      "--artifact",
      "https://example.test/run/2",
      "--dashboards",
      dash,
      "--registry",
      REGISTRY_FIXTURE,
    ]);
    expect(code).toBe(0);
    expect(json).toMatchObject({ verb: "notturno", subcommand: "pass", ok: true, job: "canary", status: "ok" });
    expect(json.target).toBe(join(dash, "scheduled-passes.md"));
    const today = new Date().toISOString().slice(0, 10);
    expect(readFileSync(join(dash, "scheduled-passes.md"), "utf8")).toBe(
      PASSES_HEADER +
        "\n" +
        `## Pass ${today} — canary — ok\n\n- staging slots clean\n- duration: 42s\n- artifacts:\n  - https://example.test/run/1\n  - https://example.test/run/2\n`,
    );
  });

  it("round-trip: a CLI append onto the Python-rendered file leaves the prefix byte-identical, one blank line between records", () => {
    const dash = join(dir, "rt");
    mkdirSync(dash, { recursive: true });
    copyFileSync(PYRENDER, join(dash, "scheduled-passes.md"));
    const { code } = run([
      "pass",
      "--job",
      "fleet-digest",
      "--status",
      "ok",
      "--outcome",
      "mesh reachable",
      "--dashboards",
      dash,
      "--registry",
      REGISTRY_FIXTURE,
    ]);
    expect(code).toBe(0);
    const py = readFileSync(PYRENDER, "utf8").replace(/\n+$/, "");
    const today = new Date().toISOString().slice(0, 10);
    expect(readFileSync(join(dash, "scheduled-passes.md"), "utf8")).toBe(
      py + "\n\n" + `## Pass ${today} — fleet-digest — ok\n\n- mesh reachable\n`,
    );
  });

  it("--dashboards accepts the FILE path itself (dir-or-file parity)", () => {
    const target = join(dir, "passes.md");
    const { code } = run([
      "pass",
      "--job",
      "canary",
      "--status",
      "ok",
      "--outcome",
      "o",
      "--dashboards",
      target,
      "--registry",
      REGISTRY_FIXTURE,
    ]);
    expect(code).toBe(0);
    expect(existsSync(target)).toBe(true);
  });

  it("unknown job → the Python's exact message, exit 2, nothing written", () => {
    const dash = join(dir, "d");
    const { code, json } = run([
      "pass",
      "--job",
      "nope",
      "--status",
      "ok",
      "--outcome",
      "x",
      "--dashboards",
      dash,
      "--registry",
      REGISTRY_FIXTURE,
    ]);
    expect(code).toBe(2);
    expect(json.error).toBe("passes: unknown job 'nope' — not in the Notturno registry");
    expect(existsSync(join(dash, "scheduled-passes.md"))).toBe(false);
  });

  it("an `acted` job with --acted false records nothing — the Python's skip message, exit 0", () => {
    const dash = join(dir, "d");
    const { code, json } = run([
      "pass",
      "--job",
      "notturno-briefs",
      "--status",
      "ok",
      "--outcome",
      "x",
      "--dashboards",
      dash,
      "--registry",
      REGISTRY_FIXTURE,
      "--acted",
      "false",
    ]);
    expect(code).toBe(0);
    expect(json).toMatchObject({
      ok: true,
      skipped: true,
      reason: "passes: notturno-briefs records on action only; no action this run — skipped",
    });
    expect(existsSync(join(dash, "scheduled-passes.md"))).toBe(false);
  });

  it("an `acted` job with --acted true records (acted ≠ suppressed)", () => {
    const dash = join(dir, "d");
    const { code } = run([
      "pass",
      "--job",
      "notturno-briefs",
      "--status",
      "ok",
      "--outcome",
      "briefs went out",
      "--dashboards",
      dash,
      "--registry",
      REGISTRY_FIXTURE,
      "--acted",
      "true",
    ]);
    expect(code).toBe(0);
    expect(readFileSync(join(dash, "scheduled-passes.md"), "utf8")).toContain("- briefs went out");
  });

  it("an unknown status is the typed-value refusal, exit 2", () => {
    const { code, json } = run([
      "pass",
      "--job",
      "canary",
      "--status",
      "sideways",
      "--outcome",
      "x",
      "--dashboards",
      join(dir, "d"),
      "--registry",
      REGISTRY_FIXTURE,
    ]);
    expect(code).toBe(2);
    expect(json.error).toBe("passes: status must be one of ('ok', 'failed'), got 'sideways'");
  });

  it("missing required flags → usage 64 (job, status, outcome, dashboards, registry)", () => {
    expect(run(["pass"]).code).toBe(64);
    expect(run(["pass", "--job", "canary"]).code).toBe(64);
    expect(run(["pass", "--job", "canary", "--status", "ok"]).code).toBe(64);
    expect(run(["pass", "--job", "canary", "--status", "ok", "--outcome", "x", "--registry", REGISTRY_FIXTURE]).code).toBe(64);
  });

  it("a non-integer --duration-s is a usage error 64 (argparse's int gate, our exit-class convention)", () => {
    const { code, json } = run([
      "pass",
      "--job",
      "canary",
      "--status",
      "ok",
      "--outcome",
      "x",
      "--duration-s",
      "abc",
      "--dashboards",
      join(dir, "d"),
      "--registry",
      REGISTRY_FIXTURE,
    ]);
    expect(code).toBe(64);
    expect(json.error).toContain("--duration-s");
  });
});
