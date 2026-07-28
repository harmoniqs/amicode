// The tier-2 critic / planner subprocess mechanism (spec-20260728 §3.7).
// Plan: plan-20260728-160000 Task 1.
//
// The env / argv / cwd claims are asserted against a REAL spawn of test/fixtures/fake_agent.mjs,
// not against pure functions. Testing `buildChildEnv` alone stays green while `runAgent` calls
// spawn(bin, argv, {env: {...process.env, ...built}}) — which is the leak that matters. This is
// the pattern test/pasqal_launch.test.ts established.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawn as nodeSpawn } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildChildEnv,
  criticModel,
  parseAgentOutput,
  resolveAgentBin,
  runAgent,
  type AgentOutcome,
} from "../src/agent_spawn.js";

const FAKE = join(__dirname, "fixtures", "fake_agent.mjs");
const NODE = process.execPath;

let dir: string;
let record: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "agent-spawn-"));
  record = join(dir, "record.json");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** Run the fixture through the real spawn path.
 *
 *  Two things happen in the wrapper, and both are deliberate:
 *
 *  1. `bin` is node, so the fixture's own path is prepended to the child's args. runAgent's argv
 *     construction stays under test rather than reimplemented here — every assertion reads the
 *     argv the fixture RECORDED.
 *  2. The fixture's control variables (FAKE_AGENT_*) are injected AFTER buildChildEnv has run.
 *     They have to be: the allowlist correctly refuses to forward them, which is the behaviour
 *     the canary test asserts. Routing them around the allowlist keeps the leak test honest —
 *     if they went through the allowlist, adding a FAKE_ prefix to it would silently weaken the
 *     one guarantee this fixture exists to prove. */
const FIXTURE_KEYS = /^FAKE_AGENT_/;

async function run(
  env: Record<string, string | undefined> = {},
  over: Partial<Parameters<typeof runAgent>[0]> = {},
): Promise<AgentOutcome> {
  const fixtureEnv: Record<string, string> = { FAKE_AGENT_RECORD: record };
  const parentEnv: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(env)) {
    if (FIXTURE_KEYS.test(k)) fixtureEnv[k] = String(v);
    else parentEnv[k] = v;
  }
  return runAgent({
    bin: NODE,
    agent: "critic",
    lens: "hidden-failure",
    prompt: "review this spec through the hidden-failure lens",
    specText: "---\nspec_id: s\n---\n\nbody\n",
    timeoutMs: 10_000,
    env: { ...process.env, ...parentEnv } as NodeJS.ProcessEnv,
    spawn: ((bin: string, args: string[], o: { env?: NodeJS.ProcessEnv }) =>
      nodeSpawn(bin, [FAKE, ...args], { ...o, env: { ...o.env, ...fixtureEnv } })) as never,
    ...over,
  });
}

const recorded = (): { argv: string[]; env: Record<string, string>; cwd: string; files: string[]; enter: number } =>
  JSON.parse(readFileSync(record, "utf8"));

describe("resolveAgentBin", () => {
  it("prefers an ABSOLUTE $AMICO_CRITIC_BIN probed with X_OK", () => {
    const bin = join(dir, "fake-cli");
    writeFileSync(bin, "#!/bin/sh\nexit 0\n");
    chmodSync(bin, 0o755);
    expect(resolveAgentBin({ AMICO_CRITIC_BIN: bin, PATH: "" })).toBe(bin);
  });

  it("REJECTS a non-executable override — X_OK, not existsSync", () => {
    // The claim is "probed with X_OK". A test that only tries a nonexistent path never
    // distinguishes the two, so a mode-0644 file is the case that matters.
    const bin = join(dir, "not-exec");
    writeFileSync(bin, "x");
    chmodSync(bin, 0o644);
    expect(resolveAgentBin({ AMICO_CRITIC_BIN: bin, PATH: "" })).toBeUndefined();
  });

  it("REJECTS a relative override — the spawn must not depend on cwd", () => {
    expect(resolveAgentBin({ AMICO_CRITIC_BIN: "./opencode", PATH: "" })).toBeUndefined();
  });

  it("returns undefined when nothing is executable — never throws, never a silent skip", () => {
    expect(resolveAgentBin({ PATH: "/nonexistent-dir-xyz" })).toBeUndefined();
  });

  it("finds `opencode` on PATH when there is no override", () => {
    const bin = join(dir, "opencode");
    writeFileSync(bin, "#!/bin/sh\nexit 0\n");
    chmodSync(bin, 0o755);
    expect(resolveAgentBin({ PATH: dir })).toBe(bin);
  });
});

describe("criticModel — G-2 resolution", () => {
  it("defaults to a frontier model", () => {
    expect(criticModel({})).toBe("anthropic/claude-opus-5");
  });
  it("honours $AMICO_CRITIC_MODEL", () => {
    expect(criticModel({ AMICO_CRITIC_MODEL: "anthropic/claude-sonnet-5" })).toBe("anthropic/claude-sonnet-5");
  });
});

describe("the child's environment, argv and cwd — asserted from a REAL spawn", () => {
  it("env is built FROM SCRATCH: a canary in the parent does NOT reach the child", async () => {
    await run({ AMICO_TEST_CANARY: "leak-me", ANTHROPIC_API_KEY: "sk-poison" });
    const rec = recorded();
    expect(rec.env.AMICO_TEST_CANARY).toBeUndefined();
    expect(rec.env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(rec.env.HOME).toBeTruthy(); // the allowlist still lets the CLI run
    expect(rec.env.PATH).toBeTruthy();
  });

  it("carries the agent definitions in OPENCODE_CONFIG_CONTENT — the only config channel", async () => {
    await run();
    const cfg = JSON.parse(recorded().env.OPENCODE_CONFIG_CONTENT);
    expect(Object.keys(cfg.agent).sort()).toEqual(["critic", "planner"]);
    // A reviewer that can shell out can act on the spec it was asked to judge.
    expect(cfg.agent.critic.permission).toMatchObject({ bash: "deny", edit: "deny" });
  });

  it("$AMICO_AGENT_CONFIG_DIR overrides the built-in definitions", async () => {
    await run({ AMICO_AGENT_CONFIG_DIR: "/some/config/dir" });
    const rec = recorded();
    expect(rec.env.OPENCODE_CONFIG_DIR).toBe("/some/config/dir");
    expect(rec.env.OPENCODE_CONFIG_CONTENT).toBeUndefined();
  });

  it("NEVER passes --config: opencode has no such flag and its CLI is .strict()", async () => {
    // With --config the child exits 1 printing help, which the outcome table reads as
    // "unparseable" -> skipped -> approved-mechanical on EVERY review.
    await run();
    expect(recorded().argv).not.toContain("--config");
  });

  it("passes NO secret on argv", async () => {
    await run({ ANTHROPIC_API_KEY: "sk-poison", AMICO_PASQAL_FILE: "/tmp/poison-creds.json" });
    const flat = recorded().argv.join(" ");
    for (const secret of ["sk-poison", "/tmp/poison-creds.json"]) expect(flat).not.toContain(secret);
  });

  it("sends the prompt POSITIONALLY after `--`, never as --file", async () => {
    await run();
    const argv = recorded().argv;
    expect(argv).not.toContain("--file"); // --file ATTACHES a file; the prompt is a message
    expect(argv[argv.indexOf("--") + 1]).toMatch(/hidden-failure/);
    expect(argv.slice(0, 4)).toEqual(["run", "--agent", "critic", "--model"]);
    expect(argv).toContain("--format");
    expect(argv).toContain("json");
  });

  it("the cwd holds EXACTLY the spec copy and nothing else", async () => {
    await run();
    expect(recorded().files).toEqual(["spec.md"]);
  });
});

describe("parseAgentOutput — an NDJSON event stream, not a findings array", () => {
  const ev = (text: string) => JSON.stringify({ type: "text", timestamp: 1, sessionID: "s", part: { type: "text", text } });

  it("recovers the payload from the LAST text event, not the first", () => {
    const stream = [ev('{"model":"a/b","findings":[]}'), ev('{"model":"c/d","findings":[{"lens":"x"}]}')].join("\n");
    expect(parseAgentOutput(stream)?.model).toBe("c/d");
  });

  it("ignores tool_use and step events between the text parts", () => {
    const stream = [
      JSON.stringify({ type: "step_start", part: {} }),
      ev("thinking out loud"),
      JSON.stringify({ type: "tool_use", part: {} }),
      ev('{"model":"a/b","findings":[]}'),
    ].join("\n");
    expect(parseAgentOutput(stream)).toMatchObject({ model: "a/b" });
  });

  it("finds JSON wrapped in prose or a fence, because agents do that regardless", () => {
    expect(parseAgentOutput(ev('Here you go:\n```json\n{"model":"a/b","findings":[]}\n```'))).toMatchObject({
      model: "a/b",
    });
  });

  it("returns undefined on prose with no JSON — never a partial parse", () => {
    expect(parseAgentOutput(ev("I read the spec and it looks fine."))).toBeUndefined();
    expect(parseAgentOutput("not json at all")).toBeUndefined();
  });

  it("returns undefined on truncated JSON rather than a half-read object", () => {
    expect(parseAgentOutput(ev('{"model":"a/b","findings":[{'))).toBeUndefined();
  });
});

describe("the child-outcome table — all seven rows", () => {
  const F = JSON.stringify([{ lens: "hidden-failure", severity: "advisory", claim: "c", evidence: "e", remedy: "r" }]);

  it("row 1 — valid stdout, exit 0 → ran, contributes findings", async () => {
    const out = await run({ FAKE_AGENT_FINDINGS: F });
    expect(out.status).toBe("ran");
    expect(out.findings).toHaveLength(1);
    expect(out.model).toBe("anthropic/claude-opus-5");
  });

  it("row 2 — exit ≠ 0 with PARSEABLE stdout → ran, reason recorded", async () => {
    // The child answered and then failed to clean up. That is not the same as not answering.
    const out = await run({ FAKE_AGENT_FINDINGS: F, FAKE_AGENT_EXIT: "3" });
    expect(out.status).toBe("ran");
    expect(out.findings).toHaveLength(1);
    expect(out.reason).toMatch(/exit 3/);
  });

  it("row 3 — exit ≠ 0, unparseable → skipped(failed)", async () => {
    const out = await run({ FAKE_AGENT_MODE: "prose", FAKE_AGENT_EXIT: "1" });
    expect(out).toMatchObject({ status: "skipped", skip_class: "failed" });
    expect(out.reason).toMatch(/unparseable/);
  });

  it("row 4 — killed by signal → skipped(failed)", async () => {
    const out = await run({ FAKE_AGENT_MODE: "hang" }, { timeoutMs: 150 });
    // SIGKILL from our own ceiling reports as a timeout; both are skip_class failed.
    expect(out).toMatchObject({ status: "skipped", skip_class: "failed" });
  });

  it("row 5 — timeout → skipped(failed), naming the ceiling", async () => {
    const out = await run({ FAKE_AGENT_MODE: "hang" }, { timeoutMs: 120 });
    expect(out.status).toBe("skipped");
    expect(out.reason).toMatch(/within 120ms/);
  });

  it("row 6 — exit 0, empty stdout → skipped(failed), never a clean critic", async () => {
    const out = await run({ FAKE_AGENT_MODE: "empty" });
    expect(out).toMatchObject({ status: "skipped", skip_class: "failed" });
    expect(out.reason).toMatch(/empty stdout/);
  });

  it("row 7 — spawn error / binary absent → skipped(ABSENT), a different disclosure", async () => {
    const out = await runAgent({
      bin: "/definitely/not/here",
      agent: "critic",
      prompt: "p",
      specText: "x",
      timeoutMs: 500,
    });
    expect(out).toMatchObject({ status: "skipped", skip_class: "absent" });
  });

  it("records stderr as the reason on a skipped row", async () => {
    const out = await run({ FAKE_AGENT_MODE: "stderr", FAKE_AGENT_EXIT: "1" });
    expect(out.reason).toMatch(/503/);
  });

  it("distinguishes the skip CLASSES, because approved-mechanical vs degraded turns on it", async () => {
    // Collapsing them is a real defect: the shipped runner keyed on critics.length === 0, so
    // three critics that all TIMED OUT recorded "no critic binary available".
    expect((await run({ FAKE_AGENT_MODE: "hang" }, { timeoutMs: 120 })).skip_class).toBe("failed");
    expect((await runAgent({ bin: "/nope", agent: "critic", prompt: "p", specText: "x", timeoutMs: 300 })).skip_class).toBe(
      "absent",
    );
  });

  it("removes the temp dir on EVERY row, including timeout and spawn error", async () => {
    const dirs: string[] = [];
    for (const env of [{}, { FAKE_AGENT_MODE: "prose" }, { FAKE_AGENT_MODE: "empty" }]) {
      await run(env);
      dirs.push(recorded().cwd);
    }
    await run({ FAKE_AGENT_MODE: "hang" }, { timeoutMs: 120 });
    dirs.push(recorded().cwd);
    for (const d of dirs) expect(existsSync(d)).toBe(false);
  });

  it("returns a RESULT when the working directory cannot be staged — never throws", async () => {
    const out = await runAgent({
      bin: NODE,
      agent: "critic",
      prompt: "p",
      specText: "x",
      specFilename: "nested/dir/spec.md", // writeFileSync fails: the parent does not exist
      timeoutMs: 500,
    });
    expect(out).toMatchObject({ status: "skipped", skip_class: "failed" });
    expect(out.reason).toMatch(/working directory/);
  });
});

describe("the model is read back from the CHILD, never from argv", () => {
  it("stamps what the child reported, not what we asked for", async () => {
    const out = await run({ FAKE_AGENT_MODEL: "anthropic/claude-haiku-4-5" }, { model: "anthropic/claude-opus-5" });
    expect(out.model).toBe("anthropic/claude-haiku-4-5");
  });

  it("DISCARDS a critic that will not name itself, rather than stamping the request", async () => {
    // Stamping argv would validate and would be a request masquerading as a fact, in the one
    // field whose job is to let a reader judge how independent the review was.
    const out = await run({ FAKE_AGENT_MODE: "no-model" });
    expect(out).toMatchObject({ status: "skipped", skip_class: "failed" });
    expect(out.reason).toMatch(/did not report the model/);
  });

  it("rejects a reported model that is not provider/name shaped", async () => {
    const out = await run({ FAKE_AGENT_MODEL: "hpc" });
    expect(out.status).toBe("skipped");
  });
});

describe("findings hygiene (§3.9)", () => {
  const withRemedy = { lens: "x", severity: "advisory", claim: "c", evidence: "e", remedy: "r" };

  it("DROPS a finding with no remedy and counts the drop", async () => {
    const out = await run({
      FAKE_AGENT_FINDINGS: JSON.stringify([withRemedy, { ...withRemedy, remedy: "" }, { ...withRemedy, remedy: "  " }]),
    });
    expect(out.findings).toHaveLength(1);
    expect(out.dropped_no_remedy).toBe(2); // a silent drop must not look like a clean critic
  });

  it("stamps the round on every finding", async () => {
    const out = await run({ FAKE_AGENT_FINDINGS: JSON.stringify([withRemedy]) }, { round: 3 });
    expect(out.findings[0].round).toBe(3);
  });

  it("defaults the lens to the one the critic was given, so a mislabelled finding is still placed", async () => {
    const out = await run({ FAKE_AGENT_FINDINGS: JSON.stringify([{ ...withRemedy, lens: "" }]) });
    expect(out.findings[0].lens).toBe("hidden-failure");
  });

  it("coerces an unknown severity to advisory — a critic cannot invent a severity", async () => {
    const out = await run({ FAKE_AGENT_FINDINGS: JSON.stringify([{ ...withRemedy, severity: "catastrophic" }]) });
    expect(out.findings[0].severity).toBe("advisory");
  });
});

describe("buildChildEnv", () => {
  it("allowlists rather than spreads", () => {
    const env = buildChildEnv({ HOME: "/h", PATH: "/p", XDG_CONFIG_HOME: "/x", SECRET: "leak" });
    expect(env).toEqual({ HOME: "/h", PATH: "/p", XDG_CONFIG_HOME: "/x" });
  });
  it("lets explicit extras through", () => {
    expect(buildChildEnv({ HOME: "/h" }, { OPENCODE_CONFIG_CONTENT: "{}" }).OPENCODE_CONFIG_CONTENT).toBe("{}");
  });
});
