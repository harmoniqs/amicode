// Shared sandbox seeder for the amicode-service contract tests (#451, M1).
//
// ONE seeder serves both sides of the parity proof so they can never drift:
//   - scripts/record_amicode_fixtures.mjs seeds a sandbox, boots the FORK
//     binary against it, and records golden request/response pairs.
//   - test/amicode_service_contract.test.ts seeds the SAME sandbox, boots the
//     PORTED service against it, and replays the recorded pairs.
//
// Determinism rules (any nondeterminism here = flaky parity forever):
//   - platform counts are UNEQUAL (transmon 2, cavity 1) so platformMix's
//     count-descending sort is total — no reliance on readdir order.
//   - memory note mtimes are pinned via utimesSync so remembers()' recency
//     tiebreak is stable across seedings.
//   - terminal-run file mtimes are PINNED to fixed epochs: FINISHED's mtime
//     feeds elapsed_ms + finished_at, so both sides compute identical values.
//   - the solving run's run.log mtime is pinned to seed-time NOW (so it reads
//     "solving", not "stalled") — its elapsed_ms is therefore wall-clock and
//     is normalized to <ELAPSED> at replay; same for the stalled run.
//   - every value (names, dates, fidelities) is fixed data, never Date.now().
import { chmodSync, mkdirSync, writeFileSync, utimesSync } from "node:fs";
import { dirname, join } from "node:path";

export function seedAmicodeSandbox(dir) {
  const amico = join(dir, ".amico");
  mkdirSync(amico, { recursive: true });

  // --- identity -------------------------------------------------------------
  writeFileSync(
    join(amico, "profile.json"),
    JSON.stringify(
      {
        name: "Ada Lovelace",
        affiliation: "Analytical Engine Lab",
        focus: "Rydberg CZ",
        scholar: "https://scholar.example/ada",
      },
      null,
      2,
    ) + "\n",
  );

  // mounts.toml — the name fallback (only fires when profile.name is cleared).
  writeFileSync(
    join(amico, "mounts.toml"),
    [
      "[[mount]]",
      'id = "armonia-test-personal"',
      'kind = "personal"',
      "",
      "[[mount]]",
      'id = "armonia-team-ro"',
      'kind = "team"',
      "",
    ].join("\n"),
  );

  // --- memory (Amico remembers) ----------------------------------------------
  // Three notes, three distinct scores: control feedback (+2) > user identity
  // (0) > ops feedback (-2). Limit is 3 so all appear; ordering is score-only.
  const memory = join(amico, "memory");
  mkdirSync(memory, { recursive: true });
  const note = (file, frontmatter) => writeFileSync(join(memory, file), `---\n${frontmatter}\n---\n\nbody\n`);
  note(
    "smooth-pulses.md",
    'name: smooth-pulses\ndescription: "smooth pulse parameterization reliably hits F>0.9999 on transmon X"\nmetadata:\n  type: feedback',
  );
  note(
    "identity.md",
    'name: identity\ndescription: "prefers LaTeX-formatted physics answers"\nmetadata:\n  type: user',
  );
  note(
    "slack-ops.md",
    'name: slack-ops\ndescription: "vault sync and slack broadcast automation notes"\nmetadata:\n  type: feedback',
  );
  // Pin mtimes: oldest first, matching the listing above.
  const t0 = new Date("2026-07-01T00:00:00Z");
  for (const [i, f] of ["smooth-pulses.md", "identity.md", "slack-ops.md"].entries()) {
    const p = join(memory, f);
    const t = new Date(t0.getTime() + i * 86_400_000);
    utimesSync(p, t, t);
  }

  // --- problems (platform mix, count, problem-UI state, run refs) --------------
  const problems = join(dir, "problems");
  const writeFile = (p, content) => {
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, content);
  };
  const writeJson = (p, obj) => writeFile(p, JSON.stringify(obj, null, 2) + "\n");

  // The score manifest at the problems root (score_stages resolution target).
  writeJson(join(problems, "score_manifest.json"), {
    manifest: {
      id: "pulse-designer",
      stages: [{ name: "platform", emits: ["system"] }, { name: "formulate", emits: ["formulation", "run"] }],
    },
  });
  // The active-problem marker (GET /amicode/problem with no slug).
  writeFile(join(problems, "active"), "x-gate-transmon\n");

  // x-gate-transmon: score stamped in problem.json; full entity set; events;
  // runs.json refs every default-lab run (one per terminal state + stalled).
  const xg = join(problems, "x-gate-transmon");
  writeJson(join(xg, "problem.json"), {
    slug: "x-gate-transmon",
    name: "X Gate (Transmon)",
    platform: "transmon",
    status: "solved",
    score: { id: "pulse-designer" },
    recorded: "2026-08-15",
  });
  // Entities carry BOTH shapes the readers use: platformMix reads
  // entities/system.json.platform (top level); run-cards reads .params.
  writeJson(join(xg, "entities", "system.json"), {
    platform: "transmon",
    params: { platform: "transmon", gate: "X" },
  });
  writeJson(join(xg, "entities", "formulation.json"), { params: { T: 10, N: 50 } });
  writeFile(
    join(xg, "events.jsonl"),
    [
      JSON.stringify({ seq: 1, entity: "system", action: "recorded", source: { tool: "amicode_pick_system" } }),
      JSON.stringify({ seq: 2, entity: "formulation", action: "recorded", source: { tool: "amicode_formulate" } }),
      JSON.stringify({ seq: 3, entity: "run", action: "recorded", source: { tool: "amicode_solve" } }),
      "",
    ].join("\n"),
  );
  writeJson(join(xg, "runs.json"), {
    runs: [
      { run_id: "r20260801-000000Z-0a1b2c", lab: "default" },
      { run_id: "r20260805-000000Z-9z8y7x", lab: "default" },
      { run_id: "r20260810-000000Z-3d4e5f", lab: "default" },
      { run_id: "r20260815-000000Z-6a7b8c", lab: "default" },
      { run_id: "r20260818-000000Z-4h5i6j", lab: "default" },
    ],
  });

  // t-gate-transmon: NO score in problem.json — score_stages must fall back to
  // interview_state.json's score_id (the guard's durable record).
  const tg = join(problems, "t-gate-transmon");
  writeJson(join(tg, "problem.json"), { slug: "t-gate-transmon", name: "T Gate (Transmon)", platform: "transmon", status: "solved" });
  writeJson(join(tg, "entities", "system.json"), { platform: "transmon", params: { platform: "transmon", gate: "T" } });
  writeJson(join(tg, "interview_state.json"), { score_id: "pulse-designer", stage: "solve" });

  // cat-state-cavity: designing; its run lives in ANOTHER lab ("other") —
  // pins run-status/run-cards lab resolution.
  const cat = join(problems, "cat-state-cavity");
  writeJson(join(cat, "problem.json"), { slug: "cat-state-cavity", name: "Cat State (Cavity)", platform: "cavity", status: "designing" });
  writeJson(join(cat, "entities", "system.json"), { platform: "cavity", params: { platform: "cavity" } });
  writeJson(join(cat, "runs.json"), { runs: [{ run_id: "r20260812-000000Z-5c6d7e", lab: "other" }] });

  // --- runs (one per terminal state + stalled; elapsed pinned via FINISHED
  //     mtimes = fixed epoch - the run-id-encoded start) ------------------------
  const runsRoot = join(dir, "runs");
  const runLog = (iters, extra = []) =>
    [
      'AMICODE_PULSE_META drives=2 knots=3 labels="a_1","a_2" bounds=-0.2:0.2,-0.2:0.2',
      ...iters.map(([i, f]) => `AMICODE_ITER iter=${i} f=${f} inf_pr=1.0e-0${i} inf_du=5.0e-0${i}`),
      "AMICODE_PULSE iter=" + iters[iters.length - 1][0] + " dt=0.2 a=0.01,0.02,0.03;0.04,0.05,0.06",
      ...extra,
      "",
    ].join("\n");
  const seedRun = (lab, runId, files, mtimeEpoch) => {
    const d = join(runsRoot, lab, runId);
    for (const [f, content] of Object.entries(files ?? {})) writeFile(join(d, f), content);
    if (mtimeEpoch) {
      const t = new Date(mtimeEpoch);
      for (const f of Object.keys(files ?? {})) utimesSync(join(d, f), t, t);
    }
    return d;
  };
  const fiveIters = [
    [1, "2.5e-01"],
    [2, "1.0e-01"],
    [3, "3.0e-02"],
    [4, "5.0e-03"],
    [5, "1.0e-03"],
  ];
  // completed: FINISHED + result + pulse; elapsed 120s (00:02:00 - 00:00:00).
  seedRun("default", "r20260801-000000Z-0a1b2c", {
    FINISHED: 'status = "completed"\n',
    "result.toml": "fidelity = 0.9999\niterations = 5\n",
    "pulse.jld2": "stub",
    "run.log": runLog(fiveIters, ["DONE fidelity=0.9999"]),
  }, "2026-08-01T00:02:00Z");
  // stopped: FINISHED says completed, but the cooperative-stop marker relabels.
  // Fidelity low so the profile's best_fidelity stays the completed run's.
  seedRun("default", "r20260805-000000Z-9z8y7x", {
    FINISHED: 'status = "completed"\n',
    "result.toml": "fidelity = 0.71\niterations = 2\n",
    "run.log": runLog([
      [1, "3.0e-01"],
      [2, "2.9e-01"],
    ], ["AMICODE_STOPPED", "DONE fidelity=0.71"]),
  }, "2026-08-05T00:03:00Z");
  // solving: no FINISHED; run.log mtime pinned to seed-NOW so it reads
  // "solving" (not stalled). elapsed_ms is wall-clock → normalized at replay.
  const solvingDir = seedRun("default", "r20260810-000000Z-3d4e5f", {
    "run.log": runLog([
      [1, "4.0e-01"],
      [2, "3.5e-01"],
    ]),
  });
  {
    const now = new Date();
    utimesSync(join(solvingDir, "run.log"), now, now);
  }
  // failed: FINISHED says failed (a failed run with a result.toml is NOT
  // finished — the one-spine rule).
  seedRun("default", "r20260815-000000Z-6a7b8c", {
    FINISHED: 'status = "failed"\n',
    "result.toml": "fidelity = 0.42\niterations = 3\n",
    "run.log": runLog([
      [1, "5.0e-01"],
      [2, "4.8e-01"],
      [3, "4.7e-01"],
    ]),
  }, "2026-08-15T00:01:30Z");
  // stalled: no FINISHED, run.log mtime 2h before seed-now → "stalled".
  const stalledDir = seedRun("default", "r20260818-000000Z-4h5i6j", {
    "run.log": runLog([
      [1, "6.0e-01"],
      [2, "5.9e-01"],
    ]),
  });
  {
    const stale = new Date(Date.now() - 2 * 60 * 60 * 1000);
    utimesSync(join(stalledDir, "run.log"), stale, stale);
  }
  // other-lab completed: the cat-state run; elapsed 45s.
  seedRun("other", "r20260812-000000Z-5c6d7e", {
    FINISHED: 'status = "completed"\n',
    "result.toml": "fidelity = 0.998\niterations = 4\n",
    "run.log": runLog([
      [1, "2.0e-01"],
      [2, "8.0e-02"],
      [3, "2.0e-02"],
      [4, "2.0e-03"],
    ], ["DONE fidelity=0.998"]),
  }, "2026-08-12T00:00:45Z");

  // --- vaults (the vault family: mounts with the marker taxonomy) --------------
  const vaults = join(dir, "vaults");
  const mount = (base, marker, files) => {
    const d = join(vaults, base);
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, ".amico-vault.toml"), marker);
    for (const [f, content] of Object.entries(files ?? {})) writeFile(join(d, f), content);
  };
  // personal: browsable by default. Sizes are fixed → deterministic listing.
  mount("personal-main", 'kind = "personal"\nname = "personal-main"\n', {
    "welcome.md": "# Welcome\n\nVault knowledge base.\n",
    "notes/note.md": "Note body — deterministic.\n",
    "data/binary.bin": "\u0000\u0001\u0002binary",
  });
  // team WITHOUT browse=true: the fail-closed refusal fixture (opts in for
  // nothing; listing it must refuse).
  mount("team-shared", 'kind = "team"\nname = "team-shared"\n', {});
  // public: browsable by definition.
  mount("public-open", 'kind = "public"\nname = "public-open"\n', {
    "pub.md": "Public note.\n",
  });

  // attachable vault OUTSIDE the vaults root (POST /amicode/vaults path flavor
  // symlinks it in) — its appearance in the post-attach listing pins the
  // status-cache bust.
  const attachable = join(dir, "attachable-demo");
  mkdirSync(attachable, { recursive: true });
  writeFileSync(join(attachable, ".amico-vault.toml"), 'kind = "personal"\nname = "attached-demo"\n');
  writeFileSync(join(attachable, "attached.md"), "Attached vault note.\n");

  // --- ledger (warrants: one approval + two solves under its plan) --------------
  const ledger = join(amico, "ledger");
  mkdirSync(ledger, { recursive: true });
  const planHash = "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef";
  writeFileSync(
    join(ledger, "runs.jsonl"),
    [
      JSON.stringify({ type: "approval", plan_hash: planHash, bounds: { max_solves: 3, tier: "free" }, expires_at: "2026-12-31T00:00:00Z", issued_by: "user:cli" }),
      JSON.stringify({ type: "solve", plan_hash: planHash, run_id: "r20260801-000000Z-0a1b2c" }),
      JSON.stringify({ type: "solve", plan_hash: planHash, run_id: "r20260815-000000Z-6a7b8c" }),
      JSON.stringify({ type: "approval", plan_hash: "cafebabecafebabecafebabecafebabecafebabe", bounds: {}, expires_at: "2026-09-30T00:00:00Z", issued_by: "user:ui" }),
      "this line is not json", // per-line tolerance: one bad line must not blind the card
      "",
    ].join("\n"),
  );

  // --- library (uploaded papers; added_ms = mtime → pinned epochs) -------------
  const libraryDir = join(amico, "library");
  mkdirSync(libraryDir, { recursive: true });
  const paper = (name, content, epoch) => {
    const p = join(libraryDir, name);
    writeFileSync(p, content);
    const t = new Date(epoch);
    utimesSync(p, t, t);
  };
  paper("rydberg-blockade-2024.pdf", "%PDF-1.4 fake rydberg paper\n", "2026-08-02T00:00:00Z");
  paper("piccolo-trajectory-2023.pdf", "%PDF-1.4 fake piccolo paper\n", "2026-08-06T00:00:00Z");

  // --- widgets + dashboard (the widget kernel) -------------------------------
  // widgets dir: EMPTY of user widgets at seed (the fork-arc populates it
  // mid-sequence); env-redirected so the fork never sees the host's.
  const widgetsDir = join(dir, "widgets");
  mkdirSync(widgetsDir, { recursive: true });
  // Stored dashboard state: a hidden builtin, an entry with passthrough keys
  // (group/view), an UNKNOWN id (→ missing:true), and reserved top-level keys.
  writeJson(join(amico, "dashboard.json"), {
    version: 1,
    widget: [
      { id: "meet-amico", hidden: true, config: {} },
      { id: "about-you", config: {}, group: "left", view: "expanded" },
      { id: "ghost-widget", config: { any: "values" } },
    ],
    views: { home: "grid" },
  });

  // --- connections (credentials + status cache + custom registry) -------------
  // company-compute + slack CONNECTED. validated_at is seeded one minute
  // before seed-NOW: the 24h staleness clock MUST read fresh, or the fork's
  // GET kicks a background network revalidation (probe → cache write) whose
  // landing races the later reads — observed as the CI offline-flag flake.
  // Credential mtimes pinned to the SAME instant so the 5s edit-slack also
  // reads fresh. Tokens are inert seed values — no probe runs, no probe is
  // kicked. The wall-clock validated_at is normalized to <NOW> at replay.
  const ccValidatedAt = new Date(Date.now() - 60_000);
  const ccValidatedIso = ccValidatedAt.toISOString();
  writeJson(join(amico, "cloud.json"), { base_url: "https://solve.example.internal", token: "tok-cc-seed" });
  writeJson(join(amico, "slack.json"), { token: "xoxb-seed-token" });
  utimesSync(join(amico, "cloud.json"), ccValidatedAt, ccValidatedAt);
  utimesSync(join(amico, "slack.json"), ccValidatedAt, ccValidatedAt);
  writeJson(join(amico, "connections.json"), {
    "company-compute": {
      state: "connected",
      identity: "aaron",
      entitlements: ["hpc"],
      validated_at: ccValidatedIso,
    },
    slack: { state: "connected", identity: "aaron@example", validated_at: ccValidatedIso },
  });
  // one custom connection (the remove-fixture target)
  writeJson(join(dir, "custom-connections.json"), [
    { id: "custom-seed1", name: "Lab QPU", token: "tok-qpu", url: "https://qpu.example" },
  ]);

  // --- projects (defaultParentDir is HOME-based — HOME rides the env overlay) --
  mkdirSync(join(dir, "AmicodeProjects", "prior-project"), { recursive: true });

  // --- stub PATH: `amico` exists (fixed output → deterministic approve fixture),
  //     `amico-vault` does NOT (forces the CLI-less scanMounts path on both
  //     sides, so fixtures never depend on a real CLI being installed). ----------
  const stubbin = join(dir, "stubbin");
  mkdirSync(stubbin, { recursive: true });
  writeFileSync(join(stubbin, "amico"), "#!/bin/sh\necho 'stubbed approve ok'\n");
  chmodSync(join(stubbin, "amico"), 0o755);

  // --- project dir (tier-4 relative resolution resolves against it) ------------
  writeFile(join(dir, "docs", "readme.md"), "Project readme.\n");

  // --- the env overlay both sides use ------------------------------------------
  // AMICODE_MOUNTS_FILE is the port's test seam (the fork resolves HOME only;
  // the recorder ALSO redirects HOME to the sandbox, so both sides read the
  // same mounts.toml through different mechanisms). PATH is pinned to the
  // stub dir on BOTH sides (fork spawn + test process) so CLI discovery and
  // `amico ledger approve` behave identically regardless of the host machine.
  return {
    dir,
    seededAt: Date.now(),
    env: {
      AMICODE_PROFILE_FILE: join(amico, "profile.json"),
      AMICODE_MOUNTS_FILE: join(amico, "mounts.toml"),
      AMICODE_MEMORY_DIR: memory,
      AMICODE_PROBLEMS_DIR: problems,
      AMICODE_RUNS_DIR: runsRoot,
      AMICO_VAULTS_ROOT: vaults,
      AMICO_LEDGER: join(ledger, "runs.jsonl"),
      AMICODE_PROJECT_DIR: dir,
      AMICODE_LIBRARY_DIR: libraryDir,
      AMICODE_WIDGETS_DIR: widgetsDir,
      AMICODE_DASHBOARD_FILE: join(amico, "dashboard.json"),
      AMICODE_CONNECTIONS_FILE: join(amico, "connections.json"),
      AMICO_CUSTOM_CONNECTIONS_FILE: join(dir, "custom-connections.json"),
      AMICO_CLOUD_FILE: join(amico, "cloud.json"),
      AMICO_SLACK_FILE: join(amico, "slack.json"),
      AMICO_PASQAL_FILE: join(amico, "pasqal.json"),
      AMICO_GITHUB_FILE: join(amico, "github.json"),
      AMICO_LINEAR_FILE: join(amico, "linear.json"),
      AMICO_GOOGLE_FILE: join(amico, "google.json"),
      AMICO_GOOGLE_DRIVE_FILE: join(amico, "google-drive.json"),
      HOME: dir, // the projects default parent + CLI candidate paths are HOME-based
      PATH: stubbin,
    },
  };
}
