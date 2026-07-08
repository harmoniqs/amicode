#!/usr/bin/env node
// Batch retro-ingest (spec-20260705-002847 §5) — one-shot seeding of the
// user-memory substrate from existing history. Self-contained: builds the
// distiller OPENCODE_CONFIG_CONTENT inline (does not depend on the running
// extension's distiller.config.json) and runs jobs SEQUENTIALLY via
// `opencode run --agent distiller` (a one-shot batch needs no queue/lock).
//
// SAFETY (tonight): the opencode SERVER is alive, so the DB-archive step is
// SKIPPED — reads only. The distiller writes ONLY to <vault>/amicode/ with
// pathspec-scoped commits (DISTILLER.md rule 1).
//
// Usage:
//   node scripts/distill_batch.mjs --dry-run              # triage counts only
//   node scripts/distill_batch.mjs --runs-only [--limit N]# distill runs w/ result.toml
//   node scripts/distill_batch.mjs --sweeps [--limit N]   # distill substantive sessions
//   node scripts/distill_batch.mjs --all                  # runs + sweeps
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const HOME = os.homedir();
const EXT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const OPENCODE = path.join(EXT, "vendor", "opencode", "linux-x64", "opencode");
const DISTILLER_MD = path.join(EXT, "DISTILLER.md");
const DB = path.join(HOME, ".local", "share", "opencode", "opencode.db");
const RUNS_ROOT = path.join(HOME, ".amico", "runs", "default");
const PROBLEMS_ROOT = path.join(HOME, ".amico", "problems");
const OPS = path.join(HOME, ".amico", "amicode");
const MODEL = process.env.AMICODE_DISTILLER_MODEL || "opencode/big-pickle";

const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const limit = args.includes("--limit") ? parseInt(args[args.indexOf("--limit") + 1], 10) : Infinity;

function resolveVault() {
  const root = path.join(HOME, ".amico", "vaults");
  for (const name of fs.readdirSync(root).sort()) {
    try {
      const t = fs.readFileSync(path.join(root, name, ".amico-vault.toml"), "utf8");
      if (/^\s*kind\s*=\s*"personal"\s*$/m.test(t)) return path.join(root, name);
    } catch {}
  }
  throw new Error("no kind=personal vault under ~/.amico/vaults");
}
const VAULT = resolveVault();

// Pre-create the distiller's working root so it never needs to explore the vault
// root (which it isn't granted). First run starts from an empty skeleton.
for (const d of ["", "problems", "pulses", "environment", "devices", "demos"]) {
  fs.mkdirSync(path.join(VAULT, "amicode", d), { recursive: true });
}
{
  const kn = path.join(VAULT, "amicode", "KNOWLEDGE.md");
  if (!fs.existsSync(kn)) fs.writeFileSync(kn, "# Amicode knowledge map\n\n");
}

function sql(q) {
  return execFileSync("sqlite3", [`file:${DB}?mode=ro`, q], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }).trim();
}

function distillerConfig() {
  return JSON.stringify({
    $schema: "https://opencode.ai/config.json",
    instructions: [DISTILLER_MD],
    agent: {
      distiller: {
        description: "Amico's background memory distiller (headless; no subagents)",
        prompt:
          "You are Amico's distiller. Follow the distiller instructions exactly. Your input is one JSON job object. Work silently; never spawn subagents; finish with a one-line summary.",
        model: MODEL,
      },
    },
    permission: {
      bash: "allow",
      edit: "allow",
      external_directory: {
        [`${VAULT}/amicode`]: "allow",
        [`${VAULT}/amicode/**`]: "allow",
        [`${VAULT}/.git/**`]: "allow",
        [`${OPS}/**`]: "allow",
        [`${PROBLEMS_ROOT}/**`]: "allow",
        [`${RUNS_ROOT}/**`]: "allow",
        [`${path.join(HOME, "harmoniqs", "demos")}/**`]: "allow", // demo-ingest reads
      },
    },
  });
}

function runsWithResult() {
  return fs
    .readdirSync(RUNS_ROOT)
    .filter((d) => d.startsWith("r") && fs.existsSync(path.join(RUNS_ROOT, d, "result.toml")))
    .sort();
}

function substantiveSessions() {
  const q = `SELECT DISTINCT p.session_id FROM part p JOIN session s ON s.id=p.session_id
    WHERE COALESCE(s.agent,'') != 'distiller'
    AND (p.data LIKE '%amicode_pick_system%' OR p.data LIKE '%amicode_formulate%'
      OR p.data LIKE '%amico-run --spec%' OR p.data LIKE '%amicode_solve%');`;
  return sql(q).split("\n").filter(Boolean);
}

function workspaceHygiene() {
  // Flag (report, don't touch) workspaces whose recorded formulation target
  // disagrees with the dir name (spec §5 step 4).
  const flags = [];
  for (const ws of fs.readdirSync(PROBLEMS_ROOT)) {
    const ev = path.join(PROBLEMS_ROOT, ws, "events.jsonl");
    if (!fs.existsSync(ev)) continue;
    let target = null;
    for (const line of fs.readFileSync(ev, "utf8").split("\n").filter(Boolean)) {
      try {
        const e = JSON.parse(line);
        if (e.entity === "formulation" && e.diff?.target?.to) target = e.diff.target.to;
      } catch {}
    }
    if (
      target &&
      !ws.toLowerCase().includes(
        String(target)
          .toLowerCase()
          .replace(/[^a-z0-9]/g, ""),
      )
    )
      flags.push(`${ws} → recorded target "${target}"`);
  }
  return flags;
}

function distill(job, label) {
  process.stdout.write(`  distilling ${label} … `);
  try {
    const out = execFileSync(OPENCODE, ["run", "--agent", "distiller", JSON.stringify(job)], {
      env: { ...process.env, OPENCODE_CONFIG_CONTENT: distillerConfig() },
      encoding: "utf8",
      timeout: 10 * 60 * 1000,
      maxBuffer: 8 * 1024 * 1024,
    });
    const last = out.trim().split("\n").filter(Boolean).pop() || "(no summary)";
    console.log("ok — " + last.slice(0, 160));
    return true;
  } catch (e) {
    console.log("FAILED — " + String(e.message).slice(-200));
    return false;
  }
}

// ── main ──────────────────────────────────────────────────────────────────
const runs = runsWithResult();
const sessions = substantiveSessions();
const hygiene = workspaceHygiene();
const serverAlive = (() => {
  try {
    execFileSync("pgrep", ["-f", "opencode serve"]);
    return true;
  } catch {
    return false;
  }
})();

console.log(`vault:      ${VAULT}`);
console.log(`model:      ${MODEL}`);
console.log(`runs w/ result.toml: ${runs.length}   substantive sessions: ${sessions.length}`);
console.log(`workspace hygiene flags (${hygiene.length}):`);
for (const f of hygiene) console.log(`   ⚠ ${f}`);
console.log(
  `opencode server alive: ${serverAlive}  → DB archive step ${serverAlive ? "SKIPPED (deferred to a no-server window)" : "eligible"}`,
);

if (has("--dry-run")) {
  console.log("\n[dry-run] no distills spawned.");
  process.exit(0);
}

let ok = 0,
  fail = 0;
if (has("--runs-only") || has("--all")) {
  const sel = runs.slice(0, limit === Infinity ? runs.length : limit);
  console.log(`\n[runs] distilling ${sel.length} run(s):`);
  for (const r of sel)
    distill({ kind: "run", run_id: r, vault: VAULT, ops: OPS, runs_root: RUNS_ROOT }, r) ? ok++ : fail++;
}
if (has("--demos-ingest")) {
  const DEMOS = path.join(HOME, "harmoniqs", "demos");
  const dirs = fs.existsSync(DEMOS)
    ? fs.readdirSync(DEMOS).filter((d) => fs.statSync(path.join(DEMOS, d)).isDirectory())
    : [];
  const sel = dirs.slice(0, limit === Infinity ? dirs.length : limit);
  console.log(`\n[demos] ingesting ${sel.length} demo(s) from ${DEMOS}:`);
  for (const d of sel)
    distill({ kind: "demo", demo_dir: path.join(DEMOS, d), vault: VAULT, ops: OPS, runs_root: RUNS_ROOT }, d)
      ? ok++
      : fail++;
}
if (has("--sweeps") || has("--all")) {
  const sel = sessions.slice(0, limit === Infinity ? sessions.length : limit);
  console.log(`\n[sweeps] distilling ${sel.length} session(s):`);
  for (const s of sel)
    distill({ kind: "sweep", session_ids: [s], vault: VAULT, ops: OPS, runs_root: RUNS_ROOT }, s.slice(0, 20))
      ? ok++
      : fail++;
}

// Summary report (spec §5 step 5) — stdout + a vault notes/ file.
const stamp = sql("SELECT strftime('%Y%m%dT%H%M%S','now');");
const report = [
  `# Batch retro-ingest report — ${stamp}`,
  ``,
  `- runs distilled ok: ${ok}, failed: ${fail}`,
  `- substantive sessions seen: ${sessions.length}` +
    (has("--sweeps") || has("--all") ? "" : " (sweeps NOT run this pass)"),
  `- workspace hygiene flags: ${hygiene.length}`,
  ...hygiene.map((f) => `   - ⚠ ${f}`),
  `- DB archive of empty sessions: ${serverAlive ? "DEFERRED (server alive) — run with server stopped to sweep empties + agent='distiller' rows" : "eligible"}`,
  `- distiller sessions created this batch are marked agent='distiller' and excluded from future triage; archive them in a no-server window.`,
].join("\n");
console.log("\n" + report);
if (!has("--dry-run")) {
  const notesDir = path.join(VAULT, "notes");
  fs.mkdirSync(notesDir, { recursive: true });
  fs.writeFileSync(path.join(notesDir, `amicode-batch-report-${stamp}.md`), report + "\n");
  console.log(`\nreport written to notes/amicode-batch-report-${stamp}.md`);
}
