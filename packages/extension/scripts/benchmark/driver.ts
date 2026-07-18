// ============================================================================
// STAGE 1 — driver.ts
//
// Boots `opencode serve` with the REAL config + REAL amicode_* plugin + the
// REAL AGENTS.md (via prepareOpencodeProject / buildOpencodeConfigContent — the
// same primitives the extension and the slow e2e use, so ZERO drift), FORCES the
// candidate model through the config `model` PIN (NOT the message body — the
// message body errors), replays a scenario's user turns, and captures EVERYTHING
// per turn (prose, every tool call + input args, tokens, cost, wall-clock,
// finish reason, opencode errors) to ONE JSONL file per (model × scenario × run)
// cell under scripts/benchmark/out/.
//
// It NEVER scores. A cell crash / timeout writes an `error` record and the batch
// continues to the next cell.
//
// KEY FACTS (probed live, 2026-07-17):
//   * Model is set via config.model PIN + a serve RESTART per model. Passing
//     `model` in the message body errors — confirmed. So one server per model,
//     reused across that model's scenarios×runs (a cheap restart between models).
//   * opencode error responses come back HTTP 200 with `info.error =
//     {name, data:{message, statusCode}}`. Status codes alone lie — inspect
//     info.error on every assistant message.
//   * Per-message tokens/cost/time ARE available: on the synchronous POST
//     /message response (`info.cost`, `info.tokens`, `info.time`) AND on GET
//     /session/:id/message (per-message `info`). ONE user turn can spawn
//     MULTIPLE assistant messages (multi-step tool use), and the POST returns
//     only the LAST message's info. So we GET the message list after each turn
//     and aggregate cost/tokens across ALL assistant messages created for the
//     turn (diffed against the pre-turn message count).
//   * Tool-call input args live at part.state.input; prose at part.text.
//
// USAGE:
//   bun scripts/benchmark/driver.ts [--models m1,m2] [--scenarios S1,S2]
//                                   [--runs N] [--turn-timeout MS] [--out DIR]
//   (bun runs the .ts directly; the vendored binary is invoked via child_process.)
// ============================================================================
import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createServer } from "node:net";
import {
  buildOpencodeConfigContent,
  prepareOpencodeProject,
  resolveJuliaProject,
} from "../../src/opencode_config";
import { loadModels, loadScenarios, vendoredOpencodeBin, extRoot, BENCH_DIR } from "./config";
import type {
  Scenario,
  ToolCall,
  TokenUsage,
  MetaRecord,
  TurnRecord,
  TurnExpectation,        // NEW — runOneTurn's signature uses it
  ErrorRecord,
  DoneRecord,
  StageUnrecoveredRecord, // NEW — written for an unrecovered iterate stage
} from "./types";

// ---- opencode message API shapes (only the fields we read) ------------------
interface OcPart {
  type: string;
  text?: string;
  tool?: string;
  callID?: string;
  state?: { status?: string; input?: Record<string, unknown> };
  input?: Record<string, unknown>;
}
interface OcInfo {
  role?: string;
  cost?: number;
  tokens?: TokenUsage;
  time?: { created?: number; completed?: number };
  modelID?: string;
  providerID?: string;
  finish?: string;
  error?: { name?: string; data?: { message?: string; statusCode?: number } };
}
interface OcMessage {
  info?: OcInfo;
  parts?: OcPart[];
}

// ---- CLI parsing ------------------------------------------------------------
function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const val = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : "true";
      out[key] = val;
    }
  }
  return out;
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const p = typeof addr === "object" && addr ? addr.port : 0;
      srv.close(() => resolve(p));
    });
    srv.on("error", reject);
  });
}

const OC_BIN = vendoredOpencodeBin();
const AGENTS_SRC = path.join(extRoot(), "AGENTS.md");
const TEMPLATE_SRC = path.join(extRoot(), "templates", "solve_template.jl");

// ---- server lifecycle -------------------------------------------------------
interface Server {
  child: ChildProcess;
  url: string;
  port: number;
  log: () => string;
  kill: () => void;
}

/** Boot `opencode serve` with the extension's REAL config, pinned to `model`.
 *  Uses prepareOpencodeProject (real AGENTS.md substitution + score compile +
 *  plugin registration) then rebuilds the config with the model pin — identical
 *  to the extension path except for the forced model. HOME is the real home so
 *  the live Bedrock/opencode creds resolve (per the e2e tier-C pattern). */
async function bootServer(model: string): Promise<Server> {
  const project = prepareOpencodeProject({
    agentsSrc: AGENTS_SRC,
    templateSrc: TEMPLATE_SRC,
    juliaProject: resolveJuliaProject(""),
  });
  const config = buildOpencodeConfigContent(
    project.agentsPath,
    project.templatePath,
    path.join(os.homedir(), ".amico", "runs", "default"),
    undefined, // default plugin path (resolves off src/ — correct)
    undefined, // default scores root
    project.skillPaths,
    project.skillsStageDir,
    project.vaultDir,
    project.mounts,
    model, // <-- the model PIN (this is how the candidate is forced)
  );
  const port = await freePort();
  const env: NodeJS.ProcessEnv = { ...process.env, OPENCODE_CONFIG_CONTENT: config };
  let buf = "";
  const child = spawn(OC_BIN, ["serve", "--port", String(port)], {
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout!.on("data", (c) => (buf += c));
  child.stderr!.on("data", (c) => (buf += c));
  const url = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 45_000;
  for (;;) {
    try {
      const r = await fetch(url + "/", { signal: AbortSignal.timeout(1000) });
      if (r.ok) break;
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) {
      try {
        child.kill("SIGKILL");
      } catch {
        /* ignore */
      }
      throw new Error(`serve not ready in 45s (model ${model}); log:\n${buf.slice(0, 2000)}`);
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  const kill = () => {
    try {
      child.kill("SIGTERM");
    } catch {
      /* ignore */
    }
    setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        /* ignore */
      }
    }, 2000).unref();
  };
  return { child, url, port, log: () => buf, kill };
}

// ---- per-turn capture -------------------------------------------------------
/** Extract prose text + tool calls from a set of assistant messages. */
function extractParts(msgs: OcMessage[]): { prose: string; toolCalls: ToolCall[] } {
  const proseParts: string[] = [];
  const toolCalls: ToolCall[] = [];
  for (const m of msgs) {
    for (const p of m.parts ?? []) {
      if (p.type === "text" && typeof p.text === "string" && p.text.trim() !== "") {
        proseParts.push(p.text);
      } else if (p.type === "tool") {
        toolCalls.push({
          tool: p.tool ?? "unknown",
          callID: p.callID,
          input: (p.state?.input ?? p.input ?? {}) as Record<string, unknown>,
          status: p.state?.status,
        });
      }
    }
  }
  return { prose: proseParts.join("\n"), toolCalls };
}

/** Sum tokens field-wise across assistant messages. */
function sumTokens(msgs: OcMessage[]): TokenUsage {
  const acc = {
    total: 0,
    input: 0,
    output: 0,
    reasoning: 0,
    cache: { read: 0, write: 0 },
  };
  for (const m of msgs) {
    const t = m.info?.tokens;
    if (!t) continue;
    acc.total += t.total ?? 0;
    acc.input += t.input ?? 0;
    acc.output += t.output ?? 0;
    acc.reasoning += t.reasoning ?? 0;
    acc.cache.read += t.cache?.read ?? 0;
    acc.cache.write += t.cache?.write ?? 0;
  }
  return acc;
}

/** Drive ONE user turn: POST the text, then GET the full message list and take
 *  every NEW assistant message (created after `beforeCount`). Aggregates cost /
 *  tokens across all of them; surfaces any info.error. */
async function driveTurn(
  server: Server,
  sessionID: string,
  text: string,
  beforeCount: number,
  timeoutMs: number,
): Promise<{ record: Omit<TurnRecord, "kind" | "index" | "expect">; newCount: number }> {
  const t0 = Date.now();
  const r = await fetch(`${server.url}/session/${sessionID}/message`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ agent: "pulse-designer", parts: [{ type: "text", text }] }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const wallMs = Date.now() - t0;
  if (!r.ok) {
    // A non-200 (rare — errors usually ride a 200) is still an error turn.
    return {
      record: {
        sent: text,
        prose: "",
        toolCalls: [],
        usage: { cost: 0, tokens: {}, assistantMessages: 0 },
        wallMs,
        error: { name: "HTTPError", message: `POST /message ${r.status}`, statusCode: r.status },
      },
      newCount: beforeCount,
    };
  }
  // Authoritative per-message record (POST returns only the LAST message).
  const list = (await (await fetch(`${server.url}/session/${sessionID}/message`)).json()) as OcMessage[];
  const fresh = Array.isArray(list) ? list.slice(beforeCount) : [];
  const assistants = fresh.filter((m) => m.info?.role === "assistant");
  const { prose, toolCalls } = extractParts(assistants);
  const cost = assistants.reduce((s, m) => s + (m.info?.cost ?? 0), 0);
  const tokens = sumTokens(assistants);
  const last = assistants[assistants.length - 1]?.info;
  // opencode errors come back HTTP 200 with info.error on an assistant message.
  const errMsg = assistants.find((m) => m.info?.error)?.info?.error;
  return {
    record: {
      sent: text,
      prose,
      toolCalls,
      usage: { cost, tokens, assistantMessages: assistants.length },
      wallMs,
      modelID: last?.modelID,
      providerID: last?.providerID,
      finish: last?.finish,
      error: errMsg
        ? { name: errMsg.name, message: errMsg.data?.message, statusCode: errMsg.data?.statusCode }
        : undefined,
    },
    newCount: Array.isArray(list) ? list.length : beforeCount,
  };
}

// ---- one cell ---------------------------------------------------------------
/** Run one (model × scenario × run) cell against an already-booted server.
 *  Writes the JSONL transcript. Never throws — a crash writes an error record. */
async function runCell(
  server: Server,
  model: string,
  scenario: Scenario,
  run: number,
  outDir: string,
  turnTimeoutMs: number,
): Promise<void> {
  const outFile = path.join(outDir, `${cellName(model, scenario.id, run)}.jsonl`);
  const sink = fs.createWriteStream(outFile, { flags: "w" });
  const write = (rec: object) => sink.write(JSON.stringify(rec) + "\n");
  let turnsCompleted = 0;
  let totalCost = 0;
  let totalWallMs = 0;
  try {
    const ses = (await (
      await fetch(server.url + "/session", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      })
    ).json()) as { id: string };

    const meta: MetaRecord = {
      kind: "meta",
      model,
      scenario: scenario.id,
      run,
      startedAt: new Date().toISOString(),
      sessionID: ses.id,
      scenario_meta: {
        id: scenario.id,
        title: scenario.title,
        exclude_from_headline: scenario.exclude_from_headline,
        judge_note: scenario.judge_note,
      },
      opencodeBin: OC_BIN,
    };
    write(meta);

    let beforeCount = 0;
    let turnIndex = 0;

    // Shared: drive one turn, write a stamped TurnRecord, update counters.
    // Returns the record so the caller can inspect prose/error for iteration.
    const runOneTurn = async (
      send: string,
      expect: TurnExpectation | undefined,
      stage: string | undefined,
      iterationIndex: number | undefined,
    ): Promise<{ record: Awaited<ReturnType<typeof driveTurn>>["record"]; errored: boolean }> => {
      const { record, newCount } = await driveTurn(server, ses.id, send, beforeCount, turnTimeoutMs);
      beforeCount = newCount;
      totalCost += record.usage.cost;
      totalWallMs += record.wallMs;
      turnIndex++;
      const turnRec: TurnRecord = {
        kind: "turn",
        index: turnIndex,
        ...record,
        expect,
        ...(stage !== undefined ? { stage } : {}),
        ...(iterationIndex !== undefined ? { iterationIndex } : {}),
      };
      write(turnRec);
      turnsCompleted++;
      if (record.error) {
        write({
          kind: "error",
          phase: `turn:${turnIndex}`,
          message: `${record.error.name}: ${record.error.message ?? ""}`.slice(0, 500),
          turnsCompleted,
        } as ErrorRecord);
        return { record, errored: true };
      }
      return { record, errored: false };
    };

    if (scenario.stages && scenario.stages.length > 0) {
      // v2 multi-stage: replay each stage's turns, then inject its iterate
      // follow-up until recovered_when matches or max_iterations is hit.
      outer: for (const stage of scenario.stages) {
        for (const t of stage.turns) {
          const { errored } = await runOneTurn(t.send, t.expect, stage.name, 0);
          if (errored) break outer;
        }
        if (stage.iterate) {
          const it = stage.iterate;
          const re = it.recovered_when ? new RegExp(it.recovered_when) : undefined;
          let recovered = false;
          for (let k = 1; k <= it.max_iterations && !recovered; k++) {
            const { record, errored } = await runOneTurn(it.send, it.expect, stage.name, k);
            if (errored) break outer;
            const hay = record.prose + " " + JSON.stringify(record.toolCalls.map((c) => c.input));
            if (re && re.test(hay)) recovered = true;
          }
          if (!recovered && re) {
            const ur: StageUnrecoveredRecord = {
              kind: "stage_unrecovered",
              stage: stage.name,
              iterations: it.max_iterations,
            };
            write(ur);
          }
        }
      }
    } else {
      for (const turn of scenario.turns) {
        const { errored } = await runOneTurn(turn.send, turn.expect, undefined, undefined);
        if (errored) break;
      }
    }
    const done: DoneRecord = {
      kind: "done",
      turns: turnsCompleted,
      totalCost,
      totalWallMs,
      finishedAt: new Date().toISOString(),
    };
    write(done);
  } catch (e) {
    const er: ErrorRecord = {
      kind: "error",
      phase: turnsCompleted === 0 ? "boot" : `turn:${turnsCompleted + 1}`,
      message: String((e as Error)?.message ?? e).slice(0, 500),
      turnsCompleted,
    };
    write(er);
  } finally {
    await new Promise<void>((resolve) => sink.end(resolve));
  }
}

/** Filesystem-safe cell name: model slashes/colons → `-`. */
export function cellName(model: string, scenarioID: string, run: number): string {
  const m = model.replace(/[^a-zA-Z0-9._-]/g, "-");
  return `${m}__${scenarioID}__run${run}`;
}

// ---- batch orchestration ----------------------------------------------------
async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const cfg = loadModels();
  const allScenarios = loadScenarios();

  const models = args.models ? args.models.split(",").map((s) => s.trim()) : cfg.candidates;
  const scenarioFilter = args.scenarios ? new Set(args.scenarios.split(",").map((s) => s.trim())) : undefined;
  const scenarios = scenarioFilter ? allScenarios.filter((s) => scenarioFilter.has(s.id)) : allScenarios;
  const runs = args.runs ? Number(args.runs) : cfg.runs;
  const turnTimeoutMs = args["turn-timeout"] ? Number(args["turn-timeout"]) : 480_000;
  const outDir = args.out ? path.resolve(args.out) : path.join(BENCH_DIR, "out");
  fs.mkdirSync(outDir, { recursive: true });

  console.error(
    `[driver] ${models.length} model(s) × ${scenarios.length} scenario(s) × ${runs} run(s) = ` +
      `${models.length * scenarios.length * runs} cells → ${outDir}`,
  );
  console.error(`[driver] binary: ${OC_BIN}`);

  for (const model of models) {
    console.error(`\n[driver] === model: ${model} ===`);
    let server: Server | undefined;
    try {
      server = await bootServer(model);
      console.error(`[driver] serve up on :${server.port}`);
    } catch (e) {
      // Boot failure: write an error cell for every (scenario × run) so the
      // batch is complete and the report shows the model as failed.
      console.error(`[driver] BOOT FAILED for ${model}: ${(e as Error).message}`);
      for (const scenario of scenarios) {
        for (let run = 1; run <= runs; run++) {
          const outFile = path.join(outDir, `${cellName(model, scenario.id, run)}.jsonl`);
          const er: ErrorRecord = {
            kind: "error",
            phase: "boot",
            message: String((e as Error).message).slice(0, 500),
            turnsCompleted: 0,
          };
          fs.writeFileSync(outFile, JSON.stringify(er) + "\n");
        }
      }
      continue;
    }
    try {
      for (const scenario of scenarios) {
        for (let run = 1; run <= runs; run++) {
          const label = cellName(model, scenario.id, run);
          const t0 = Date.now();
          process.stderr.write(`[driver] cell ${label} … `);
          await runCell(server, model, scenario, run, outDir, turnTimeoutMs);
          console.error(`done (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
        }
      }
    } finally {
      server.kill();
    }
  }
  console.error(`\n[driver] batch complete → ${outDir}`);
}

// Run when invoked directly (bun scripts/benchmark/driver.ts). `import.meta.main`
// is a bun runtime flag; the `as` keeps tsc (ES2022 lib) happy.
if ((import.meta as unknown as { main?: boolean }).main) {
  main().catch((e) => {
    console.error("[driver] fatal:", e);
    process.exit(1);
  });
}
