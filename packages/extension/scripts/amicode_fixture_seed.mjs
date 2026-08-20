// Shared sandbox seeder for the amicode-service contract tests (#451, M1).
//
// ONE seeder serves both sides of the parity proof so they can never drift:
//   - scripts/record_amicode_fixtures.mjs seeds a sandbox, boots the FORK
//     binary against it, and records golden request/response pairs.
//   - test/amicode_service_profile.test.ts seeds the SAME sandbox, boots the
//     PORTED service against it, and replays the recorded pairs.
//
// Determinism rules (any nondeterminism here = flaky parity forever):
//   - platform counts are UNEQUAL (transmon 2, cavity 1) so platformMix's
//     count-descending sort is total — no reliance on readdir order.
//   - memory note mtimes are pinned via utimesSync so remembers()' recency
//     tiebreak is stable across seedings.
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

  // --- problems (platform mix + count) ----------------------------------------
  const problems = join(dir, "problems");
  const problem = (slug, platform, withEntitySystem) => {
    const d = join(problems, slug);
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, "problem.json"), JSON.stringify({ slug, platform, status: "solved" }, null, 2) + "\n");
    if (withEntitySystem) {
      mkdirSync(join(d, "entities"), { recursive: true });
      writeFileSync(join(d, "entities", "system.json"), JSON.stringify({ platform }, null, 2) + "\n");
    }
  };
  problem("x-gate-transmon", "transmon", true);
  problem("t-gate-transmon", "transmon", false);
  problem("cat-state-cavity", "cavity", false);

  // --- runs (stats: runs/banked/best_fidelity/since) ---------------------------
  const runs = join(dir, "runs", "default");
  const run = (name, files) => {
    const d = join(runs, name);
    mkdirSync(d, { recursive: true });
    for (const [f, content] of Object.entries(files ?? {})) writeFileSync(join(d, f), content);
  };
  run("r20260801-0a1b2c", {
    "result.toml": "fidelity = 0.9982\n",
    "pulse.jld2": "stub", // presence is all runStats checks
  });
  run("r20260810-3d4e5f", {}); // unfinished — no result.toml
  run("r20260815-6a7b8c", { "result.toml": "fidelity = 0.9999\n" });

  // --- vaults (the vault family: mounts with the marker taxonomy) --------------
  const vaults = join(dir, "vaults");
  const mount = (base, marker, files) => {
    const d = join(vaults, base);
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, ".amico-vault.toml"), marker);
    for (const [f, content] of Object.entries(files ?? {})) {
      const p = join(d, f);
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, content);
    }
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
      JSON.stringify({ type: "solve", plan_hash: planHash, run_id: "r20260801-0a1b2c" }),
      JSON.stringify({ type: "solve", plan_hash: planHash, run_id: "r20260815-6a7b8c" }),
      JSON.stringify({ type: "approval", plan_hash: "cafebabecafebabecafebabecafebabecafebabe", bounds: {}, expires_at: "2026-09-30T00:00:00Z", issued_by: "user:ui" }),
      "this line is not json", // per-line tolerance: one bad line must not blind the card
      "",
    ].join("\n"),
  );

  // --- stub PATH: `amico` exists (fixed output → deterministic approve fixture),
  //     `amico-vault` does NOT (forces the CLI-less scanMounts path on both
  //     sides, so fixtures never depend on a real CLI being installed). ----------
  const stubbin = join(dir, "stubbin");
  mkdirSync(stubbin, { recursive: true });
  writeFileSync(join(stubbin, "amico"), "#!/bin/sh\necho 'stubbed approve ok'\n");
  chmodSync(join(stubbin, "amico"), 0o755);

  // --- project dir (tier-4 relative resolution resolves against it) ------------
  mkdirSync(join(dir, "docs"), { recursive: true });
  writeFileSync(join(dir, "docs", "readme.md"), "Project readme.\n");

  // --- the env overlay both sides use ------------------------------------------
  // AMICODE_MOUNTS_FILE is the port's test seam (the fork resolves HOME only;
  // the recorder ALSO redirects HOME to the sandbox, so both sides read the
  // same mounts.toml through different mechanisms). PATH is pinned to the
  // stub dir on BOTH sides (fork spawn + test process) so CLI discovery and
  // `amico ledger approve` behave identically regardless of the host machine.
  return {
    dir,
    env: {
      AMICODE_PROFILE_FILE: join(amico, "profile.json"),
      AMICODE_MOUNTS_FILE: join(amico, "mounts.toml"),
      AMICODE_MEMORY_DIR: memory,
      AMICODE_PROBLEMS_DIR: problems,
      AMICODE_RUNS_DIR: runs,
      AMICO_VAULTS_ROOT: vaults,
      AMICO_LEDGER: join(ledger, "runs.jsonl"),
      AMICODE_PROJECT_DIR: dir,
      PATH: stubbin,
    },
  };
}
