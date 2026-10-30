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
//                    [--stamp YYYYMMDD-HHMMSS] [--commit] [--dry-run]
//       → the routed GENERIC writer (plan Task 8): pick the first WRITABLE mount of
//         the intent kind, else fall back to the personal mount and stamp
//         `route_intent`. `experiment` is NOT a valid --type (that is `note write`'s
//         job). `--stamp` is injectable (clock injected at this verb layer, not the
//         pure core). NEW subcommand — `note write`/`bump-best` are untouched.
//         `--field key=value` (repeatable) adds frontmatter a typed note needs.
//
//       TEAM MOUNTS (#1863, parent #1860 "agents write through"): when the routed
//       mount's kind is `team` the write is ATTRIBUTED — it needs --role <agent role>
//       --session <id> --source <brief|run|digest> (refused with a plain error if any
//       is missing), the note is schema-checked BEFORE it lands, and the result is
//       ONE git commit (role/session/source as trailers) that is then pushed. A note
//       failing its type schema is parked in `<mount>/.quarantine/` with the
//       validation error beside it (exit 65, `quarantined: true`) — never at its
//       target path — and never blocks any other write. Personal mounts: unchanged.
//
// FLAG NAMES (S31 guard): the physics-knob double-dash flags (gate/pulse/system)
// are banned in src/; the gate discriminator is `--kind` (mapping onto the note
// `gate` field, as `amico catalog` does).
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { parse as parseToml } from "smol-toml";
import {
  QUARANTINE_DIR,
  RESERVED_FIELDS,
  ROUTE_FOLDERS,
  attributedCommitMessage,
  bumpBestGatesInText,
  checkNoteSchema,
  experimentId,
  isRoutableType,
  renderExperimentNote,
  renderRoutedNote,
  requireAttribution,
  routeNote,
  routedNoteBasename,
  type Attribution,
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

  const intent = flagValue(argv, "--intent") ?? "personal";
  const stamp = flagValue(argv, "--stamp") ?? nowStamp();

  const stack = resolveMountStack();
  const decision = routeNote(stack.mounts, intent);
  if ("error" in decision) return fail(decision.error);
  const { mount, routeIntent } = decision;

  // `--field key=value` (repeatable): extra frontmatter, e.g. status/visibility for a spec.
  const extra: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] !== "--field") continue;
    const kv = argv[i + 1] ?? "";
    const eq = kv.indexOf("=");
    const key = eq > 0 ? kv.slice(0, eq).trim() : "";
    if (!/^[A-Za-z_][A-Za-z0-9_-]*$/.test(key)) return fail(`--field wants key=value, got "${kv}"`);
    if (RESERVED_FIELDS.includes(key)) return fail(`--field cannot set "${key}" — the writer derives it`);
    const value = kv.slice(eq + 1);
    if (/[\r\n]/.test(value)) return fail(`--field "${key}" must be a single line`);
    extra[key] = value;
  }

  const isTeam = mount.kind === "team";
  let attribution: Attribution | undefined;
  if (isTeam) {
    const a = requireAttribution({
      role: flagValue(argv, "--role"),
      session: flagValue(argv, "--session"),
      source: flagValue(argv, "--source"),
    });
    if (!a.ok) return fail(a.error, { mount: mount.name });
    attribution = a.attribution;
  }

  const content = renderRoutedNote({
    type,
    title,
    body,
    stamp,
    route_intent: routeIntent,
    session_id: attribution ? attribution.session : null,
    extra,
  });
  const basename = routedNoteBasename(type, stamp, title);
  const dir = join(mount.path, folder);
  const file = join(dir, `${basename}.md`);

  const common = {
    verb: "note",
    subcommand: "route",
    type,
    intent,
    mount: mount.name,
    route_intent: routeIntent ?? null,
    path: file,
  };

  if (isTeam && attribution) {
    return teamWrite({ common, mount: mount.path, file, folder, basename, content, type, attribution, dryRun: argv.includes("--dry-run"), fail });
  }

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
    result.commit = gitCommit(mount.path, file, `note: add ${basename}`);
  }
  return { json: result, code: 0 };
}

// ── attributed team write (#1863) ─────────────────────────────────────────────────
function errText(e: unknown): string {
  const err = e as { stderr?: Buffer | string; message?: string };
  const stderr = err.stderr ? String(err.stderr).trim() : "";
  return stderr || (err.message ?? String(e));
}

/** Run git in the mount; throws on failure (stderr captured into the error). */
function git(mountPath: string, args: string[], timeout = 60_000): string {
  return execFileSync("git", ["-C", mountPath, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
}

interface TeamWrite {
  common: Record<string, unknown>;
  mount: string;
  file: string;
  folder: string;
  basename: string;
  content: string;
  type: string;
  attribution: Attribution;
  dryRun: boolean;
  fail: (error: string, extra?: Record<string, unknown>) => VerbResult;
}

/** Land a note on a team mount as ONE attributed commit, then push. Schema-checks
 *  first; a failing note is quarantined (same single-commit + push treatment) and
 *  reported with exit 65. Transactional: if the commit cannot be made, the files are
 *  removed again so no unattributed write is left behind. A push failure keeps the
 *  commit (revertible, re-pushable) and exits 1. */
function teamWrite(w: TeamWrite): VerbResult {
  const check = checkNoteSchema(w.content, w.type);
  const quarantined = !check.ok;
  const errors = check.ok ? [] : check.errors;
  const target = quarantined ? join(w.mount, QUARANTINE_DIR, w.folder, `${w.basename}.md`) : w.file;
  const files = quarantined ? [target, `${target}.error.txt`] : [target];
  const rel = (p: string) => relative(w.mount, p);

  if (w.dryRun) {
    return {
      json: { ...w.common, written: false, dry_run: true, quarantined, ...(quarantined ? { errors, quarantine_path: target } : {}), content: w.content },
      code: quarantined ? 65 : 0,
    };
  }

  try {
    git(w.mount, ["rev-parse", "--is-inside-work-tree"], 10_000);
  } catch {
    return w.fail(`team mount is not a git repo (${w.mount}) — an attributed team write needs git history as its undo`, { mount: w.common.mount });
  }
  if (existsSync(w.file) && !quarantined) {
    return w.fail(`note already exists on the team mount: ${w.file}`, { mount: w.common.mount });
  }

  const created: string[] = [];
  const cleanup = () => {
    try {
      git(w.mount, ["reset", "-q", "--", ...files.map(rel)], 10_000);
    } catch {
      /* nothing staged */
    }
    for (const f of created) rmSync(f, { force: true });
  };
  try {
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, w.content);
    created.push(target);
    if (quarantined) {
      writeFileSync(
        `${target}.error.txt`,
        `schema validation failed for ${rel(w.file)} (type ${w.type}):\n${errors.map((e) => `- ${e}`).join("\n")}\n`,
      );
      created.push(`${target}.error.txt`);
    }
    git(w.mount, ["add", "--", ...files.map(rel)]);
    const subject = quarantined ? `quarantine ${w.basename} (schema check failed)` : `add ${w.basename}`;
    git(w.mount, ["commit", "-q", "-m", attributedCommitMessage(subject, w.attribution), "--", ...files.map(rel)]);
  } catch (e) {
    cleanup();
    return w.fail(`failed to commit the team write (nothing was left behind): ${errText(e)}`, { mount: w.common.mount });
  }
  const sha = git(w.mount, ["rev-parse", "HEAD"], 10_000).trim();

  let push: { pushed: boolean; error?: string };
  try {
    git(w.mount, ["push", "-q", "origin", "HEAD"]);
    push = { pushed: true };
  } catch (e) {
    push = { pushed: false, error: errText(e) };
  }

  const json = {
    ...w.common,
    written: !quarantined,
    quarantined,
    ...(quarantined ? { errors, quarantine_path: target, path: w.file } : {}),
    commit: { committed: true, sha },
    attribution: w.attribution,
    push,
  };
  return { json, code: quarantined ? 65 : push.pushed ? 0 : 1 };
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
        "amico note write --platform <p> --kind <g> --fidelity <f>  |  amico note bump-best --platform <p> --kind <g> --fidelity <f> [--source <link>]  |  amico note route --type <t> --title <t> (--body <s> | --body-file <f>) [--intent <kind>] [--stamp <s>] [--commit] [--field k=v] [--role <r> --session <id> --source <s>  (team mounts)]",
    },
    code: 64,
  };
}
