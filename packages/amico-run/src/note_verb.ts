// `amico note` — the librarian's deterministic bookkeeping half (issue #113,
// slice B3; spec-20260708-112732 §3.1 / W-3). Two subcommands, both pure-logic
// (note.ts) wrapped in filesystem I/O against the mounted vault
// ($AMICO_VAULT_DIR):
//
//   amico note write  --platform <p> --kind <g> --fidelity <f> [--duration-us <d>]
//                     [--status <s>] [--session <id>] [--warm-start <id>]
//                     [--from-run <dir>] [--date <YYYY-MM-DD>] [--desc <text>]
//                     [--dry-run]
//       → write an experiment note (full frontmatter + body skeleton) into
//         experiments/. Deterministic: --date pins the id/date; --from-run reads
//         result.toml for fidelity/duration.
//
//   amico note bump-best --platform <p> --kind <g> --fidelity <f>
//                        [--duration-ns <d> | --duration-us <d>] [--source <link>]
//                        [--context <path>] [--dry-run]
//       → bump the `best_gates` list in the platform's system-context note,
//         replacing the incumbent gate entry iff the candidate has higher
//         fidelity. Surgical text edit — the rest of the note is untouched.
//
//   amico note route --type <spec|plan|insight|method|note|hopper> --title <t>
//                    (--body <s> | --body-file <f>) [--intent <kind>]
//                    [--stamp YYYYMMDD-HHMMSS] [--commit] [--field k=v]... [--dry-run]
//                    [--role <r> --session <id> --source <link>]
//       → the routed GENERIC writer (plan Task 8): pick the first WRITABLE mount of
//         the intent kind, else fall back to the personal mount and stamp
//         `route_intent`. `experiment` is NOT a valid --type (that is `note write`'s
//         job). `--stamp` is injectable (clock injected at this verb layer, not the
//         pure core). NEW subcommand — `note write`/`bump-best` are untouched.
//       → TEAM mounts (#1863): attribution (--role/--session/--source) is mandatory
//         and refused plainly when absent; the mount must be a git repo; the note is
//         schema-checked before it lands (--field supplies extra schema fields, e.g.
//         status/visibility); a valid note is ONE attributed commit (Agent-Role /
//         Session / Source trailers) and is pushed (exit 69 if the push fails — the
//         commit stays local and revertible); an invalid note is quarantined under
//         the mount's quarantine/ with the error attached (exit 65), never at its
//         target path. Personal mounts are unchanged.
//
// FLAG NAMES (S31 guard): the physics-knob double-dash flags (gate/pulse/system)
// are banned in src/; the gate discriminator is `--kind` (mapping onto the note
// `gate` field, as `amico catalog` does).
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseToml } from "smol-toml";
import {
  ROUTE_FOLDERS,
  bumpBestGatesInText,
  checkRoutedSchema,
  experimentId,
  isRoutableType,
  renderExperimentNote,
  renderRoutedNote,
  routeExtraError,
  routeNote,
  routedFields,
  routedNoteBasename,
  teamCommitMessage,
  type BestGate,
  type ExperimentFields,
} from "./note.js";
import { resolveMountStack } from "./mounts.js";
import { parseShapeQuartet } from "./repertoire.js";
import { vaultDir } from "./vault_query.js";
import type { VerbResult } from "./verbs.js";

function flagValue(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined;
}

function readTomlSafe(file: string): Record<string, unknown> | undefined {
  if (!existsSync(file)) return undefined;
  try {
    return parseToml(readFileSync(file, "utf8")) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

// ── write ─────────────────────────────────────────────────────────────────────
export function noteWrite(argv: string[]): VerbResult {
  const fail = (error: string): VerbResult => ({ json: { verb: "note", subcommand: "write", error }, code: 64 });

  const platform = flagValue(argv, "--platform");
  const gate = flagValue(argv, "--kind");
  if (!platform || !gate) return fail("--platform and --kind are required");

  const runDir = flagValue(argv, "--from-run");
  const result = runDir ? readTomlSafe(join(runDir, "result.toml")) : undefined;

  const fidRaw = flagValue(argv, "--fidelity");
  const fidelity = fidRaw !== undefined ? Number(fidRaw) : num(result?.fidelity);
  if (fidelity === undefined || !Number.isFinite(fidelity)) {
    return fail("a fidelity is required: --fidelity <f> or --from-run <dir> with a result.toml");
  }

  const durRaw = flagValue(argv, "--duration-us");
  const duration_us = durRaw !== undefined ? Number(durRaw) : num(result?.duration_us);

  // ── SEAM 3 (amicode #714): the shape quartet rides the EXISTING --from-run
  // read (no new flag). Present only when the run's result.toml carries it
  // under params.shape_metrics (PR #713's emission); REFERENCED, never
  // re-computed. Absent-means-absent: an older run writes the note cleanly
  // with no Metrics block — and a malformed table degrades to absent, never
  // a half-stamp, never an error.
  const params = result?.params;
  const shape_metrics =
    typeof params === "object" && params !== null && !Array.isArray(params)
      ? parseShapeQuartet((params as Record<string, unknown>).shape_metrics)
      : undefined;

  const fields: ExperimentFields = {
    platform,
    gate,
    fidelity,
    date: flagValue(argv, "--date") ?? today(),
    duration_us: duration_us !== undefined && Number.isFinite(duration_us) ? duration_us : undefined,
    status: flagValue(argv, "--status"),
    task_type: flagValue(argv, "--task-type"),
    session_id: flagValue(argv, "--session"),
    warm_start: flagValue(argv, "--warm-start"),
    failure_mode: flagValue(argv, "--failure-mode"),
    device: flagValue(argv, "--device-note"),
    branch: flagValue(argv, "--branch"),
    desc: flagValue(argv, "--desc"),
    shape_metrics,
  };

  const id = flagValue(argv, "--id") ?? experimentId(fields);
  const dir = vaultDir();
  const expDir = join(dir, "experiments");
  const file = join(expDir, `${id}.md`);
  const content = renderExperimentNote(fields);

  if (argv.includes("--dry-run")) {
    return { json: { verb: "note", subcommand: "write", written: false, dry_run: true, id, path: file, content }, code: 0 };
  }
  if (existsSync(file)) return fail(`experiment note already exists: ${file} (pass --id to override)`);

  try {
    mkdirSync(expDir, { recursive: true });
    writeFileSync(file, content);
  } catch (e) {
    return fail(`failed to write note: ${e instanceof Error ? e.message : String(e)}`);
  }
  return {
    json: { verb: "note", subcommand: "write", written: true, id, path: file, platform, gate, fidelity, duration_us: fields.duration_us ?? null },
    code: 0,
  };
}

// ── bump-best ─────────────────────────────────────────────────────────────────
/** Frontmatter `platform:` scalar of a note file (cheap regex; undefined on any
 *  read/parse trouble). */
function notePlatform(file: string): string | undefined {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
  const m = text.match(/^platform:\s*(.+)$/m);
  return m ? m[1].trim().replace(/^["']|["']$/g, "") : undefined;
}

/** Resolve the system-context note: explicit --context path, else the first
 *  qubit-hardware-context/*.md whose `platform:` matches (sorted for
 *  determinism). */
function resolveContextNote(argv: string[], dir: string, platform: string): { path: string } | { error: string } {
  const explicit = flagValue(argv, "--context");
  if (explicit) {
    if (!existsSync(explicit)) return { error: `--context note not found: ${explicit}` };
    return { path: explicit };
  }
  const ctxDir = join(dir, "qubit-hardware-context");
  if (!existsSync(ctxDir)) return { error: `no qubit-hardware-context/ under the vault (${dir}) — pass --context <path>` };
  let names: string[];
  try {
    names = readdirSync(ctxDir).filter((n) => n.endsWith(".md")).sort();
  } catch {
    return { error: `cannot read qubit-hardware-context/ under ${dir}` };
  }
  const match = names.find((n) => notePlatform(join(ctxDir, n)) === platform);
  if (!match) return { error: `no system-context note with platform "${platform}" — pass --context <path>` };
  return { path: join(ctxDir, match) };
}

export function noteBumpBest(argv: string[]): VerbResult {
  const fail = (error: string): VerbResult => ({ json: { verb: "note", subcommand: "bump-best", error }, code: 64 });

  const platform = flagValue(argv, "--platform");
  const gate = flagValue(argv, "--kind");
  if (!platform || !gate) return fail("--platform and --kind are required");

  const fidRaw = flagValue(argv, "--fidelity");
  const fidelity = fidRaw !== undefined ? Number(fidRaw) : undefined;
  if (fidelity === undefined || !Number.isFinite(fidelity)) return fail("--fidelity <f> is required");

  const durNsRaw = flagValue(argv, "--duration-ns");
  const durUsRaw = flagValue(argv, "--duration-us");
  let duration_ns: number | undefined;
  if (durNsRaw !== undefined && Number.isFinite(Number(durNsRaw))) duration_ns = Number(durNsRaw);
  else if (durUsRaw !== undefined && Number.isFinite(Number(durUsRaw))) duration_ns = Number(durUsRaw) * 1000;

  const entry: BestGate = { gate, fidelity, duration_ns, source: flagValue(argv, "--source") };

  const dir = vaultDir();
  const resolved = resolveContextNote(argv, dir, platform);
  if ("error" in resolved) return fail(resolved.error);

  const text = readFileSync(resolved.path, "utf8");
  const res = bumpBestGatesInText(text, entry);
  if (!res.ok) return fail(`${res.reason} (${resolved.path})`);

  const common = {
    verb: "note",
    subcommand: "bump-best",
    context: resolved.path,
    platform,
    gate,
    fidelity,
    bumped: res.bumped,
    previous: res.previous ?? null,
    reason: res.reason,
  };

  if (!res.bumped) return { json: { ...common, written: false }, code: 0 };
  if (argv.includes("--dry-run")) return { json: { ...common, written: false, dry_run: true }, code: 0 };

  try {
    writeFileSync(resolved.path, res.text!);
  } catch (e) {
    return fail(`failed to write context note: ${e instanceof Error ? e.message : String(e)}`);
  }
  return { json: { ...common, written: true }, code: 0 };
}

// ── route (routed generic writer) ────────────────────────────────────────────
/** A `YYYYMMDD-HHMMSS` stamp from the system clock (UTC — matches `today()`). The
 *  clock lives HERE, not in the pure core (note.ts), which takes the stamp as a
 *  parameter (b3 house rule). */
function nowStamp(): string {
  const iso = new Date().toISOString(); // 2026-07-11T01:30:00.000Z
  return iso.slice(0, 10).replace(/-/g, "") + "-" + iso.slice(11, 19).replace(/:/g, "");
}

/** `git add <file> && git commit -m <message>` in the mount. Tolerates a non-repo
 *  (or any git failure): returns a warning, never throws — the note is already on
 *  disk, so a failed commit is a warning, not a verb failure. */
function gitCommit(mountPath: string, file: string, message: string): { committed: boolean; warning?: string } {
  try {
    execFileSync("git", ["-C", mountPath, "add", file], { stdio: ["ignore", "ignore", "ignore"] });
    execFileSync("git", ["-C", mountPath, "commit", "-m", message], { stdio: ["ignore", "ignore", "ignore"] });
    return { committed: true };
  } catch (e) {
    return { committed: false, warning: `git commit skipped: ${e instanceof Error ? e.message : String(e)}` };
  }
}

export function noteRoute(argv: string[]): VerbResult {
  const fail = (error: string, extra: Record<string, unknown> = {}): VerbResult => ({
    json: { verb: "note", subcommand: "route", error, ...extra },
    code: 64,
  });

  const type = flagValue(argv, "--type");
  if (!type) return fail("--type is required (spec|plan|insight|method|note|hopper)");
  if (type === "experiment") {
    return fail("`experiment` is not a routable type — schema-complete experiment notes are written by `note write`", {
      use: "amico note write --platform <p> --kind <g> --fidelity <f>",
    });
  }
  if (!isRoutableType(type)) return fail(`unknown --type "${type}" (want: spec|plan|insight|method|note|hopper)`);
  const folder = ROUTE_FOLDERS[type];

  const title = flagValue(argv, "--title");
  if (!title) return fail("--title <t> is required");

  const bodyInline = flagValue(argv, "--body");
  const bodyFile = flagValue(argv, "--body-file");
  let body: string;
  if (bodyInline !== undefined) {
    body = bodyInline;
  } else if (bodyFile !== undefined) {
    if (!existsSync(bodyFile)) return fail(`--body-file not found: ${bodyFile}`);
    try {
      body = readFileSync(bodyFile, "utf8");
    } catch (e) {
      return fail(`cannot read --body-file: ${e instanceof Error ? e.message : String(e)}`);
    }
  } else {
    return fail("a body is required: --body <s> or --body-file <f>");
  }

  // `--field key=value` (repeatable): extra schema fields, e.g. status/visibility for a spec.
  const extra: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] !== "--field") continue;
    const pair = argv[i + 1] ?? "";
    const eq = pair.indexOf("=");
    if (eq <= 0) return fail(`--field expects key=value (got "${pair}")`);
    const key = pair.slice(0, eq);
    const value = pair.slice(eq + 1);
    const bad = routeExtraError(key, value);
    if (bad) return fail(bad);
    extra[key] = value;
  }

  const intent = flagValue(argv, "--intent") ?? "personal";
  const stamp = flagValue(argv, "--stamp") ?? nowStamp();

  const stack = resolveMountStack();
  const decision = routeNote(stack.mounts, intent);
  if ("error" in decision) return fail(decision.error);
  const { mount, routeIntent } = decision;

  // ── team mount (#1863): attribution is mandatory, the write is one attributed
  // git commit, schema-checked before it lands, and pushed. Personal (and other)
  // mounts keep today's behaviour below.
  if (mount.kind === "team") return teamRoute({ mount, folder, type, title, body, stamp, routeIntent, extra, argv });

  const content = renderRoutedNote({ type, title, body, stamp, route_intent: routeIntent, session_id: null, extra });
  const dir = join(mount.path, folder);
  const file = join(dir, `${routedNoteBasename(type, stamp, title)}.md`);

  const common = {
    verb: "note",
    subcommand: "route",
    type,
    intent,
    mount: mount.name,
    route_intent: routeIntent ?? null,
    path: file,
  };

  if (argv.includes("--dry-run")) {
    return { json: { ...common, written: false, dry_run: true, content }, code: 0 };
  }

  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, content);
  } catch (e) {
    return fail(`failed to write note: ${e instanceof Error ? e.message : String(e)}`);
  }

  const result: Record<string, unknown> = { ...common, written: true };
  if (argv.includes("--commit")) {
    result.commit = gitCommit(mount.path, file, `note: add ${routedNoteBasename(type, stamp, title)}`);
  }
  return { json: result, code: 0 };
}

// ── team-mount write (#1863) ───────────────────────────────────────────────────
/** Run a git command in the mount; on failure throw with git's own stderr so the
 *  caller can report it plainly. */
function gitOrThrow(mountPath: string, args: string[]): string {
  try {
    return execFileSync("git", ["-C", mountPath, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (e) {
    const err = e as { stderr?: string | Buffer; message?: string };
    const detail = (err.stderr ? String(err.stderr) : err.message ?? String(e)).trim();
    throw new Error(`git ${args[0]} failed: ${detail}`);
  }
}

/** Undo a half-finished team write so the mount is left exactly as it was. */
function rollbackTeamWrite(mountPath: string, file: string): void {
  try {
    gitOrThrow(mountPath, ["reset", "-q", "--", file]);
  } catch {
    /* not staged — nothing to unstage */
  }
  try {
    unlinkSync(file);
  } catch {
    /* never written */
  }
}

interface TeamRouteArgs {
  mount: { name: string; path: string; kind: string };
  folder: string;
  type: string;
  title: string;
  body: string;
  stamp: string;
  routeIntent?: string;
  extra: Record<string, string>;
  argv: string[];
}

function teamRoute(a: TeamRouteArgs): VerbResult {
  const { mount, folder, type, title, body, stamp, routeIntent, extra, argv } = a;
  const base = routedNoteBasename(type, stamp, title);
  const fail = (error: string, extraJson: Record<string, unknown> = {}): VerbResult => ({
    json: { verb: "note", subcommand: "route", error, mount: mount.name, ...extraJson },
    code: 64,
  });

  // 1. Attribution is mandatory and refused plainly — nothing is written.
  const role = flagValue(argv, "--role");
  const session = flagValue(argv, "--session");
  const source = flagValue(argv, "--source");
  const missing = [
    ...(role ? [] : ["--role"]),
    ...(session ? [] : ["--session"]),
    ...(source ? [] : ["--source"]),
  ];
  if (missing.length > 0) {
    return fail(`team-mount write refused: attribution is mandatory (missing ${missing.join(", ")})`, { missing });
  }

  // 2. Every team write must be revertible with git alone — refuse a non-repo mount.
  try {
    gitOrThrow(mount.path, ["rev-parse", "--is-inside-work-tree"]);
  } catch {
    return fail(`team-mount write refused: ${mount.path} is not a git repository (writes must be revertible with git)`);
  }

  // 3. Schema-check the exact field set the renderer will emit, before anything lands.
  const fields = routedFields({ type, title, body, stamp, route_intent: routeIntent, session_id: session, extra });
  const schemaErrors = checkRoutedSchema(fields, type);
  const content = renderRoutedNote({ type, title, body, stamp, route_intent: routeIntent, session_id: session, extra });
  const target = join(mount.path, folder, `${base}.md`);

  const common = {
    verb: "note",
    subcommand: "route",
    type,
    intent: routeIntent ?? mount.kind,
    mount: mount.name,
    route_intent: routeIntent ?? null,
    role,
    session,
    source,
  };
  const message = teamCommitMessage({ basename: base, role: role!, session: session!, source: source! });

  if (argv.includes("--dry-run")) {
    return {
      json: { ...common, path: target, written: false, dry_run: true, schema_errors: schemaErrors, content },
      code: schemaErrors.length ? 65 : 0,
    };
  }

  // 4. Invalid → quarantine (never the target path), with the validation error attached.
  if (schemaErrors.length > 0) {
    const quarantineDir = join(mount.path, "quarantine");
    const qPath = join(quarantineDir, `${base}.md`);
    const errLines = schemaErrors.map((e) => `  - "${e}"`).join("\n");
    const quarantined = content.replace(/\n---\n/, `\nquarantine_error:\n${errLines}\n---\n`);
    const qCommitMsg = teamCommitMessage({ basename: `quarantine/${base}`, role: role!, session: session!, source: source! });
    try {
      mkdirSync(quarantineDir, { recursive: true });
      writeFileSync(qPath, quarantined);
      gitOrThrow(mount.path, ["add", "--", qPath]);
      gitOrThrow(mount.path, ["commit", "-q", "-m", qCommitMsg]);
    } catch (e) {
      rollbackTeamWrite(mount.path, qPath);
      return fail(`quarantine failed: ${e instanceof Error ? e.message : String(e)}`, { ...common, path: target, written: false, quarantined: false, schema_errors: schemaErrors });
    }
    let pushed = true;
    let pushWarning: string | undefined;
    try {
      gitOrThrow(mount.path, ["push", "-q", "origin", "HEAD"]);
    } catch (e) {
      pushed = false;
      pushWarning = e instanceof Error ? e.message : String(e);
    }
    return {
      json: {
        ...common,
        error: "note failed its type schema and was quarantined (not written to its target path)",
        path: target,
        written: false,
        quarantined: true,
        quarantine_path: qPath,
        schema_errors: schemaErrors,
        pushed,
        ...(pushWarning ? { push_warning: pushWarning } : {}),
      },
      code: 65,
    };
  }

  // 5. Valid → target path, ONE attributed commit, then push.
  const file = target;
  try {
    mkdirSync(join(mount.path, folder), { recursive: true });
    writeFileSync(file, content);
  } catch (e) {
    return fail(`failed to write note: ${e instanceof Error ? e.message : String(e)}`, { ...common, path: file, written: false });
  }
  try {
    gitOrThrow(mount.path, ["add", "--", file]);
    gitOrThrow(mount.path, ["commit", "-q", "-m", message]);
  } catch (e) {
    rollbackTeamWrite(mount.path, file);
    return fail(`commit failed; note not written: ${e instanceof Error ? e.message : String(e)}`, { ...common, path: file, written: false });
  }
  try {
    gitOrThrow(mount.path, ["push", "-q", "origin", "HEAD"]);
  } catch (e) {
    // The commit is local and revertible; report the push as the failure to retry.
    return {
      json: { ...common, path: file, written: true, pushed: false, error: `committed locally but push failed: ${e instanceof Error ? e.message : String(e)}` },
      code: 69,
    };
  }
  return { json: { ...common, path: file, written: true, pushed: true }, code: 0 };
}

// ── dispatch ─────────────────────────────────────────────────────────────────
/** The `note` verb body: dispatch on the subcommand. Backs BOTH the CLI
 *  (amico.ts) and the MCP facade (mcp_serve.ts). */
export function noteVerb(argv: string[]): VerbResult {
  const sub = argv[0];
  const rest = argv.slice(1);
  if (sub === "write") return noteWrite(rest);
  if (sub === "bump-best") return noteBumpBest(rest);
  if (sub === "route") return noteRoute(rest);
  return {
    json: {
      verb: "note",
      error: `unknown subcommand ${sub ? `"${sub}"` : "(none)"}`,
      usage:
        "amico note write --platform <p> --kind <g> --fidelity <f>  |  amico note bump-best --platform <p> --kind <g> --fidelity <f> [--source <link>]  |  amico note route --type <t> --title <t> (--body <s> | --body-file <f>) [--intent <kind>] [--stamp <s>] [--commit]",
    },
    code: 64,
  };
}
