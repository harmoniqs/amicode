// Deterministic fixtures for the harness-reframe prototype (amicode#109, B4).
// Shared by the runnable demo (run_demo.ts) and the test
// (test/experiment_iteration.test.ts). The whole point: the experimenter leaf
// and the re-rollout harness are FAKES, so the CONTROL FLOW is exercised with NO
// model and NO Julia — proving the iteration runs without an LLM orchestrator.
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { maskedHash } from "../src/baseline.js";
import type { ExperimenterDispatch } from "../src/harness/index.js";

/** The exemplar the (fake) experimenter leaf splices — a minimal Piccolo script
 *  with the template convention's default fill-point markers. */
export const EXEMPLAR_SCRIPT =
  `using Piccolo\n` +
  `using JLD2, TOML\n` +
  `# ── FILL IN ──────\n` +
  `T = 10.0\n` +
  `# ─────────────────\n` +
  `# (a real leaf would build + serialize system_verify.jld2 here)\n` +
  `solve()\n`;

export interface FakeEnv {
  juliaBin: string;
  verifyHarness: string;
  authoringFile: string;
  /** Env for the amico-run CLI child (authoring path + verify runner). */
  env: Record<string, string>;
  /** The deterministic experimenter leaf — a plain function, NOT an LLM. */
  dispatchExperimenter: ExperimenterDispatch;
  exemplarId: string;
}

function writeExec(dir: string, name: string, body: string): string {
  const p = join(dir, name);
  writeFileSync(p, `#!/usr/bin/env node\n${body}\n`);
  chmodSync(p, 0o755);
  return p;
}

/**
 * Build a deterministic environment for one harness iteration:
 *   - a fake `julia` that writes result.toml into the run dir and exits 0;
 *   - a fake re-rollout harness that writes verification.toml with the requested
 *     `agree` (stands in for the VETTED Julia harness — the trust anchor);
 *   - the authoring.json the CLI gate + verify read;
 *   - a matching tier-2 exemplars index so the composed launch gate passes.
 * The returned `dispatchExperimenter` authors the exemplar with an inside-fill-
 * point edit — a pure function so the loop has no model in it.
 */
export function setupFakeIterationEnv(dir: string, opts: { agree: boolean } = { agree: true }): FakeEnv {
  mkdirSync(dir, { recursive: true });
  const exemplarId = "demo-cz";

  const juliaBin = writeExec(
    dir,
    "fake-julia",
    `const fs=require('fs');\n` +
      `fs.writeFileSync('result.toml','schema_version = "1"\\nfidelity = 0.9995\\niterations = 42\\n');\n` +
      `console.log('AMICODE_ITER iter=1 f=0.5');\n` +
      `console.log('DONE f=0.9995');`,
  );

  // Run by the CLI as `node <harness> <runDir> <tol>` (AMICO_VERIFY_RUNNER=node),
  // so argv[2] is the run dir.
  const verifyHarness = writeExec(
    dir,
    "fake-verify.js",
    `const fs=require('fs'),p=require('path');\n` +
      `const runDir=process.argv[2];\n` +
      `fs.writeFileSync(p.join(runDir,'verification.toml'),\n` +
      `  'schema_version = "1"\\nagree = ${opts.agree}\\nfidelity_rerolled = 0.9994\\n' +\n` +
      `  'fidelity_reported = 0.9995\\ntolerance = 0.01\\nintegrator = "fake"\\n');`,
  );

  // exemplars index — baseline hash of the UNEDITED exemplar (masked outside its fill points).
  const exemplarsIndex = join(dir, "exemplars-index.json");
  writeFileSync(
    exemplarsIndex,
    JSON.stringify({
      schema_version: 1,
      exemplars: [
        {
          id: exemplarId,
          platform: "rydberg",
          kind: "gate_synthesis",
          size: 2,
          path: `${exemplarId}/script.jl`,
          packages: ["Piccolo", "JLD2", "TOML"],
          baseline_hash: maskedHash(EXEMPLAR_SCRIPT),
        },
      ],
    }),
  );

  const authoringFile = join(dir, "authoring.json");
  writeFileSync(
    authoringFile,
    JSON.stringify({
      schema_version: 1,
      allowlist: ["Piccolo", "Legato"],
      support_set: ["JLD2", "CairoMakie", "TOML", "Printf"],
      exemplars: exemplarsIndex,
      verify_harness: verifyHarness,
      verify_tolerance: 0.01,
    }),
  );

  // The deterministic experimenter leaf. In production this is
  // `opencode run --agent experimenter` (headless, flat); here it is a function.
  const dispatchExperimenter: ExperimenterDispatch = async (_target, ctx) => {
    const scriptPath = join(ctx.workdir, "solve.jl");
    writeFileSync(scriptPath, EXEMPLAR_SCRIPT.replace("T = 10.0", "T = 25.0"));
    return { scriptPath, note: "spliced T=25.0 into demo-cz (fake leaf, no LLM)" };
  };

  return {
    juliaBin,
    verifyHarness,
    authoringFile,
    env: { AMICO_AUTHORING_FILE: authoringFile, AMICO_VERIFY_RUNNER: "node" },
    dispatchExperimenter,
    exemplarId,
  };
}
