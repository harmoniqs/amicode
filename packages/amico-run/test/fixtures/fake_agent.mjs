#!/usr/bin/env node
// A stand-in for the agent CLI, so the env / argv / cwd claims in agent_spawn.ts are asserted
// against a REAL spawn rather than against a pure function. Testing `buildChildEnv` alone stays
// green while `runAgent` calls spawn(bin, argv, {env: {...process.env, ...built}}) — the leak the
// canary assertion exists to catch. This is the pattern test/pasqal_launch.test.ts already uses.
//
// It records everything it received, then behaves per $FAKE_AGENT_MODE so one fixture can drive
// all seven rows of the §3.7 child-outcome table.
import { writeFileSync, readdirSync } from "node:fs";

if (process.env.FAKE_AGENT_RECORD) {
  writeFileSync(
    process.env.FAKE_AGENT_RECORD,
    JSON.stringify({
      argv: process.argv.slice(2),
      env: process.env,
      cwd: process.cwd(),
      // The §3.7 isolation claim: the cwd holds ONLY the spec copy.
      files: readdirSync(".").sort(),
      // Stamped so a test can assert two children genuinely overlapped in time.
      enter: Date.now(),
    }),
  );
}

const mode = process.env.FAKE_AGENT_MODE ?? "stream";
const exitCode = Number(process.env.FAKE_AGENT_EXIT ?? 0);

const stream = (parts) => parts.map((p) => JSON.stringify(p)).join("\n") + "\n";

/** opencode `--format json` emits NDJSON — one object per line, `{type, timestamp, sessionID,
 *  ...data}` — NOT a JSON array. The assistant's text arrives as `{type: "text", part: {text}}`,
 *  and the findings live in the LAST such event. Rev 2 of the spec had the child receiving a
 *  file path as its prompt and returning prose; this is the real shape. */
const payload = JSON.stringify({
  model: process.env.FAKE_AGENT_MODEL ?? "anthropic/claude-opus-5",
  variant: process.env.FAKE_AGENT_VARIANT ?? "high",
  findings: JSON.parse(process.env.FAKE_AGENT_FINDINGS ?? "[]"),
});

switch (mode) {
  case "empty": // exit 0, empty stdout
    process.exit(exitCode);
    break;
  case "prose": // unparseable: no JSON anywhere
    process.stdout.write("I read the spec and I think it looks fine.\n");
    process.exit(exitCode);
    break;
  case "no-model": // a critic that will not name itself — must not be recorded as having run
    process.stdout.write(stream([{ type: "text", part: { type: "text", text: JSON.stringify({ findings: [] }) } }]));
    process.exit(exitCode);
    break;
  case "hang": // drives the timeout row; never exits on its own
    setInterval(() => {}, 1000);
    break;
  case "slow": // sleeps, so two children's [enter, exit] intervals can be shown to intersect
    setTimeout(() => {
      process.stdout.write(stream([{ type: "text", part: { type: "text", text: payload } }]));
      process.exit(exitCode);
    }, Number(process.env.FAKE_AGENT_SLEEP_MS ?? 300));
    break;
  case "stderr": // exercises the reason field
    process.stderr.write("model provider returned 503\n");
    process.exit(exitCode);
    break;
  default:
    // A realistic stream: tool use and step markers around the terminal text event, so the
    // parser is shown to pick the LAST text part rather than the first JSON-looking thing.
    process.stdout.write(
      stream([
        { type: "step_start", part: { type: "step-start" } },
        { type: "tool_use", part: { type: "tool", state: { status: "completed" } } },
        { type: "text", part: { type: "text", text: "Let me look at the acceptance block." } },
        { type: "step_finish", part: { type: "step-finish", reason: "stop" } },
        { type: "text", part: { type: "text", text: payload } },
      ]),
    );
    process.exit(exitCode);
}
