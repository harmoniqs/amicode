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
//
// FLAG NAMES (S31 guard): the physics-knob double-dash flags (gate/pulse/system)
// are banned in src/; the gate discriminator is `--kind` (mapping onto the note
// `gate` field, as `amico catalog` does).
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseToml } from "smol-toml";
import {
  ROUTE_FOLDERS,
  bumpBestGatesInText,
  experimentId,
  isRoutableType,
  renderExperimentNote,
  renderRoutedNote,
  routeNote,
  routedNoteBasename,
  type BestGate,
  type ExperimentFields,
} from "./note.js";
import { resolveMountStack } from "./mounts.js";
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

  const content = renderRoutedNote({ type, title, body, stamp, route_intent: routeIntent, session_id: null });
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
