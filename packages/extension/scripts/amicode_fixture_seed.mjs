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
import { mkdirSync, writeFileSync, utimesSync } from "node:fs";
import { join } from "node:path";

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

  // --- the env overlay both sides use ------------------------------------------
  // AMICODE_MOUNTS_FILE is the port's test seam (the fork resolves HOME only;
  // the recorder ALSO redirects HOME to the sandbox, so both sides read the
  // same mounts.toml through different mechanisms).
  return {
    dir,
    env: {
      AMICODE_PROFILE_FILE: join(amico, "profile.json"),
      AMICODE_MOUNTS_FILE: join(amico, "mounts.toml"),
      AMICODE_MEMORY_DIR: memory,
      AMICODE_PROBLEMS_DIR: problems,
      AMICODE_RUNS_DIR: runs,
    },
  };
}
