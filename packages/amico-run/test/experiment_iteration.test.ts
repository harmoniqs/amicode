// B4 harness-reframe prototype acceptance (amicode#109, spec-20260708-112732
// §3.2/§4.3). Proves ONE experiment iteration runs end-to-end driven by an
// iteration score + the deterministic driver — NOT an LLM orchestrator. The
// experimenter leaf and the re-rollout harness are deterministic fakes, so the
// control-flow path has NO model in it and NO Julia.
import { describe, it, expect, beforeAll } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseToml } from "smol-toml";
import { parseIterationScore, runExperimentIteration, type IterationScore } from "../src/harness/index.js";
import { setupFakeIterationEnv } from "../harness-demo/fixtures.js";

const PKG = join(__dirname, "..");
const BUNDLE = join(PKG, "dist", "amico-run.js");

// The driver shells out to the real amico-run CLI, so build the bundle first —
// this exercises the REAL launch gate + tier-2 re-rollout invocation, not a mock.
beforeAll(() => {
  execFileSync("node", [join(PKG, "esbuild.config.mjs")], { cwd: PKG });
});

function composedScore(exemplarId: string): IterationScore {
  const r = parseIterationScore(
    [
      `schema_version = 1`,
      `id = "test-iteration"`,
      `[target]`,
      `platform = "rydberg"`,
      `gate = "CZ"`,
      `kind = "gate_synthesis"`,
      `size = 2`,
      `tier = "composed"`,
      `exemplar_id = "${exemplarId}"`,
      `env = { kind = "provisioned" }`,
      `[verify]`,
      `promote_on = "agree"`,
    ].join("\n"),
  );
  if (!r.ok) throw new Error(r.error);
  return r.score;
}

describe("experiment-iteration harness (B4 prototype)", () => {
  it("runs ONE iteration: flat leaf → solve → tier-2 re-rollout → promote, no LLM in the loop", async () => {
    const work = mkdtempSync(join(tmpdir(), "b4-iter-"));
    const fake = setupFakeIterationEnv(join(work, "fx"), { agree: true });
    let dispatchCalls = 0;
    const outcome = await runExperimentIteration(composedScore(fake.exemplarId), {
      dispatchExperimenter: async (t, ctx) => {
        dispatchCalls++;
        return fake.dispatchExperimenter(t, ctx);
      },
      workdir: join(work, "iter"),
      runsRoot: join(work, "runs"),
      amicoRunBundle: BUNDLE,
      juliaBin: fake.juliaBin,
      env: fake.env,
    });

    // exactly one experimenter leaf, dispatched flat (depth-1)
    expect(dispatchCalls).toBe(1);
    expect(outcome.dispatched).toBe(1);
    // the solve completed
    expect(outcome.status).toBe("completed");
    // the re-rollout gate ran for TIER-2 (composed) and agreed — the §4.3 extension
    expect(outcome.verified).toBe(true);
    // promotion is gated on that agreement
    expect(outcome.promoted).toBe(true);
    // the run dir carries the verification verdict
    expect(outcome.runDir && existsSync(join(outcome.runDir, "verification.toml"))).toBeTruthy();
    // the deterministic outcome record was written (bookkeeping, in code)
    const rec = parseToml(readFileSync(join(work, "iter", "iteration.toml"), "utf8")) as Record<string, unknown>;
    expect(rec.promoted).toBe(true);
    expect(rec.tier).toBe("composed");
    expect(rec.dispatched_experimenters).toBe(1);
    expect(rec.verified).toBe(true);
  });

  it("promotion is gated on agree: re-rollout DISAGREES → not promoted", async () => {
    const work = mkdtempSync(join(tmpdir(), "b4-iter-"));
    const fake = setupFakeIterationEnv(join(work, "fx"), { agree: false });
    const outcome = await runExperimentIteration(composedScore(fake.exemplarId), {
      dispatchExperimenter: fake.dispatchExperimenter,
      workdir: join(work, "iter"),
      runsRoot: join(work, "runs"),
      amicoRunBundle: BUNDLE,
      juliaBin: fake.juliaBin,
      env: fake.env,
    });
    expect(outcome.status).toBe("completed"); // the solve itself is fine…
    expect(outcome.verified).toBe(false); // …but the independent re-rollout disagreed…
    expect(outcome.promoted).toBe(false); // …so promotion is withheld.
    expect(outcome.promoteReason).toMatch(/did not agree/);
  });

  it("a dispatch fault is recorded, not thrown (the loop never crashes)", async () => {
    const work = mkdtempSync(join(tmpdir(), "b4-iter-"));
    const fake = setupFakeIterationEnv(join(work, "fx"));
    const outcome = await runExperimentIteration(composedScore(fake.exemplarId), {
      dispatchExperimenter: async () => {
        throw new Error("leaf boom");
      },
      workdir: join(work, "iter"),
      runsRoot: join(work, "runs"),
      amicoRunBundle: BUNDLE,
      juliaBin: fake.juliaBin,
      env: fake.env,
    });
    expect(outcome.promoted).toBe(false);
    expect(outcome.error).toMatch(/boom/);
    expect(existsSync(join(work, "iter", "iteration.toml"))).toBe(true);
  });
});

describe("parseIterationScore", () => {
  it("parses the shipped ITERATION.toml (the data-defined flow)", () => {
    const shipped = join(PKG, "..", "extension", "scores", "experiment-iteration", "ITERATION.toml");
    const r = parseIterationScore(readFileSync(shipped, "utf8"));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.score.target.tier).toBe("composed");
      expect(r.score.target.exemplar_id).toBe("rydberg-cz");
      expect(r.score.verify.promote_on).toBe("agree");
    }
  });
  it("rejects composed without exemplar_id (the gate needs it)", () => {
    const r = parseIterationScore(`id="x"\n[target]\nplatform="p"\nkind="k"\nsize=1\ntier="composed"\n`);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/exemplar_id/);
  });
  it("rejects free without a sandbox env (gate step 3)", () => {
    const r = parseIterationScore(`id="x"\n[target]\nplatform="p"\nkind="k"\nsize=1\ntier="free"\n`);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/sandbox/);
  });
  it("rejects an unknown tier", () => {
    const r = parseIterationScore(`id="x"\n[target]\nplatform="p"\nkind="k"\nsize=1\ntier="premium"\n`);
    expect(r.ok).toBe(false);
  });
});
