// Runnable demo of the harness-reframe prototype (amicode#109, slice B4).
//
//   pnpm --filter @amicode/amico-run build
//   pnpm --filter @amicode/amico-run demo:harness
//
// Runs ONE experiment iteration driven entirely by code + data (an iteration
// score) — NO LLM in the control-flow loop and NO Julia. The experimenter leaf
// and the re-rollout harness are deterministic fakes; what is exercised is the
// deterministic control flow that replaces the 1117-line orchestrator prompt:
// select target → dispatch one flat leaf → launch via amico-run → tier-2
// re-rollout verify → record + gate promotion on `agree`.
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseIterationScore, runExperimentIteration } from "../src/harness/index.js";
import { setupFakeIterationEnv } from "./fixtures.js";

async function main(): Promise<void> {
  const here = dirname(fileURLToPath(import.meta.url)); // dist/ after bundling
  const amicoRunBundle = resolve(here, "amico-run.js");
  if (!existsSync(amicoRunBundle)) {
    console.error(`[demo] missing ${amicoRunBundle} — run: pnpm --filter @amicode/amico-run build`);
    process.exit(1);
  }

  // 1) The shipped harness score (data) parses — the flow lives as data.
  const shipped = resolve(here, "..", "..", "extension", "scores", "experiment-iteration", "ITERATION.toml");
  if (existsSync(shipped)) {
    const r = parseIterationScore(readFileSync(shipped, "utf8"));
    console.log(
      r.ok
        ? `[demo] shipped ITERATION.toml parses → ${r.score.target.platform}/${r.score.target.gate} tier=${r.score.target.tier}, promote_on=${r.score.verify.promote_on}`
        : `[demo] shipped score error: ${r.error}`,
    );
  }

  // 2) Run one iteration against a demo-tuned score (exemplar matches the fakes).
  const work = mkdtempSync(join(tmpdir(), "harness-demo-"));
  const fake = setupFakeIterationEnv(join(work, "fixtures"));
  const parsed = parseIterationScore(
    [
      `schema_version = 1`,
      `id = "experiment-iteration-demo"`,
      `[target]`,
      `platform = "rydberg"`,
      `gate = "CZ"`,
      `kind = "gate_synthesis"`,
      `size = 2`,
      `tier = "composed"`,
      `exemplar_id = "${fake.exemplarId}"`,
      `env = { kind = "provisioned" }`,
      `[verify]`,
      `promote_on = "agree"`,
    ].join("\n"),
  );
  if (!parsed.ok) {
    console.error(`[demo] score error: ${parsed.error}`);
    process.exit(1);
  }

  console.log("\n[demo] ── running one iteration (control flow = code, one flat leaf) ──");
  const iterDir = join(work, "iter");
  const outcome = await runExperimentIteration(parsed.score, {
    dispatchExperimenter: fake.dispatchExperimenter, // ← the ONLY model seam (here: a fake)
    workdir: iterDir,
    runsRoot: join(work, "runs"),
    amicoRunBundle,
    juliaBin: fake.juliaBin,
    env: fake.env,
    logger: (l) => console.log(l),
  });

  console.log("\n[demo] ── outcome ──");
  console.log(JSON.stringify(outcome, null, 2));
  console.log(`\n[demo] iteration.toml (${join(iterDir, "iteration.toml")}):`);
  console.log(readFileSync(join(iterDir, "iteration.toml"), "utf8"));

  const ok =
    outcome.dispatched === 1 && outcome.status === "completed" && outcome.verified === true && outcome.promoted === true;
  if (!ok) {
    console.error("[demo] UNEXPECTED outcome — the prototype did not behave as designed");
    process.exit(1);
  }
  console.log(
    "[demo] PASS — one iteration ran: exactly one flat experimenter leaf, tier-2 re-rollout agreed, promotion gated on agree. No LLM in the control-flow loop.",
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
