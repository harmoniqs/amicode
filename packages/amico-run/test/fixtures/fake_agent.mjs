#!/usr/bin/env node
// A stand-in for the agent CLI, so the env / argv / cwd claims in agent_spawn.ts are asserted
// against a REAL spawn rather than against a pure function. Testing `buildChildEnv` alone stays
// green while `runAgent` calls spawn(bin, argv, {env: {...process.env, ...built}}) — the leak the
// canary assertion exists to catch. This is the pattern test/pasqal_launch.test.ts already uses.
//
// It records everything it received, then behaves per $FAKE_AGENT_MODE so one fixture can drive
// all seven rows of the §3.7 child-outcome table.
import { writeFileSync, readdirSync } from "node:fs";

// `opencode export <sessionID>` — the engine's own session record (#1347). Real `run --format json`
// carries no model on any event; the record's assistant messages do (`providerID`/`modelID`, written
// by the engine for the provider call it made). $FAKE_AGENT_ENGINE_MODEL is what the engine recorded
// (comma-separated for one assistant message per model): unset means no record (an engine that
// cannot find the session), which exits 1 like upstream's "Session not found"; set but empty means
// a record with no assistant message, only the user's request. Handled BEFORE the
// run record is written, so a test reading the run's argv/env never sees the export call's — that
// one goes to `<record>.export`.
const SESSION_ID = "ses_fake1347";
if (process.argv[2] === "export") {
  if (process.env.FAKE_AGENT_RECORD)
    writeFileSync(process.env.FAKE_AGENT_RECORD + ".export", JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd() }));
  // Unset: no record at all. Set but empty: a record holding only the user message (the request).
  const engineModels = (process.env.FAKE_AGENT_ENGINE_MODEL ?? "").split(",").filter(Boolean);
  if (process.env.FAKE_AGENT_ENGINE_MODEL === undefined || process.argv[3] !== SESSION_ID) {
    process.stderr.write(`Session not found: ${process.argv[3]}\n`);
    process.exit(1);
  }
  const [reqProvider, ...reqModel] = (process.env.FAKE_AGENT_REQUESTED ?? "anthropic/claude-opus-5").split("/");
  process.stderr.write(`Exporting session: ${SESSION_ID}\n`);
  process.stdout.write(
    JSON.stringify(
      {
        info: { id: SESSION_ID, model: { providerID: reqProvider, id: reqModel.join("/") } },
        messages: [
          // The USER message carries the REQUEST — reading this one would be stamping argv.
          { info: { role: "user", model: { providerID: reqProvider, modelID: reqModel.join("/") } }, parts: [] },
          ...engineModels.map((m) => {
            const [providerID, ...rest] = m.split("/");
            return { info: { role: "assistant", providerID, modelID: rest.join("/") }, parts: [] };
          }),
        ],
      },
      null,
      2,
    ) + "\n",
  );
  process.exit(0);
}

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

// Every real event carries the session id: `{type, timestamp, sessionID, part}`.
const stream = (parts) => parts.map((p) => JSON.stringify({ sessionID: SESSION_ID, ...p })).join("\n") + "\n";

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
  case "no-model": // a child that will not name itself — recorded as having run ONLY on the engine's record
    // $FAKE_AGENT_TEXT: the answer itself (e.g. a planner's goal+steps), still without a `model`.
    process.stdout.write(
      stream([{ type: "text", part: { type: "text", text: process.env.FAKE_AGENT_TEXT ?? JSON.stringify({ findings: [] }) } }]),
    );
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
