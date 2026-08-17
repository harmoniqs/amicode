import { existsSync, writeFileSync, renameSync, appendFileSync, symlinkSync, rmSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { join, dirname, basename, resolve } from "node:path";
import { studioPathsOrLegacy } from "@amicode/schema";
import { ConfigError, type RunStatus } from "./types.js";

const ID_RE = /^[a-z0-9][a-z0-9_-]*$/;

/** Spec §3: id pointers verbatim; path pointers (contain "/" or end ".toml")
 *  derive the id from the parent directory name of the lab.toml. */
export function deriveLabId(lab: string): string {
  if (ID_RE.test(lab)) return lab;
  if (lab.includes("/") || lab.endsWith(".toml")) {
    const id = basename(dirname(resolve(lab)));
    if (ID_RE.test(id)) return id;
    throw new ConfigError(`cannot derive lab id from "${lab}": parent dir "${id}" is not a valid id`);
  }
  throw new ConfigError(`invalid lab pointer "${lab}" (want [a-z0-9][a-z0-9_-]* or a lab.toml path)`);
}

export function defaultRunsRoot(labId: string): string {
  // The #402 ladder: manifest studio root → legacy ~/.amico. Absent manifest
  // = exactly today's path (the transition symlinks resolve at IO time).
  const paths = studioPathsOrLegacy();
  return join(paths.runs, labId);
}

export function generateRunId(runsRoot: string, now = new Date()): string {
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  const ts =
    `${now.getUTCFullYear()}${p(now.getUTCMonth() + 1)}${p(now.getUTCDate())}` +
    `-${p(now.getUTCHours())}${p(now.getUTCMinutes())}${p(now.getUTCSeconds())}Z`;
  for (;;) {
    const id = `r${ts}-${randomBytes(2).toString("hex")}`;
    if (!existsSync(join(runsRoot, id))) return id;
  }
}

/** Write-temp-then-rename in the same dir: a watcher can never observe a partial file. */
export function atomicWriteFile(dir: string, name: string, content: string): void {
  const tmp = join(dir, `.${name}.tmp-${process.pid}`);
  writeFileSync(tmp, content);
  renameSync(tmp, join(dir, name));
}

const ts = (s: string) => JSON.stringify(s); // JSON escaping is valid TOML basic-string

export interface Manifest {
  schema_version: "1" | "2";
  run_id: string;
  script_path: string;
  lab: string;
  lab_id: string;
  created_at: string;
  orchestrator_version: string;
  julia: { binary: string; project?: string; sysimage?: string };
  // v2 (spec C, --spec launches only) — bare runs stay byte-identical v1
  tier?: string;
  hashes?: Record<string, string>;
}

export function writeManifest(runDir: string, m: Manifest): void {
  const hashEntries = Object.entries(m.hashes ?? {});
  const lines = [
    `schema_version = ${ts(m.schema_version)}`,
    ...(m.tier ? [`tier = ${ts(m.tier)}`] : []),
    `run_id = ${ts(m.run_id)}`,
    `script_path = ${ts(m.script_path)}`,
    `lab = ${ts(m.lab)}`,
    `lab_id = ${ts(m.lab_id)}`,
    `created_at = ${ts(m.created_at)}`,
    `orchestrator_version = ${ts(m.orchestrator_version)}`,
    "",
    "[julia]",
    `binary = ${ts(m.julia.binary)}`,
    ...(m.julia.project ? [`project = ${ts(m.julia.project)}`] : []),
    ...(m.julia.sysimage ? [`sysimage = ${ts(m.julia.sysimage)}`] : []),
    ...(hashEntries.length > 0 ? ["", "[hashes]", ...hashEntries.map(([key, value]) => `${key} = ${ts(value)}`)] : []),
  ];
  atomicWriteFile(runDir, "run.toml", lines.join("\n") + "\n");
}

export function writeFinished(runDir: string, status: RunStatus, exitCode: number): void {
  atomicWriteFile(runDir, "FINISHED", `status = ${ts(status)}\nexit_code = ${exitCode}\n`);
}

export function appendIndex(runsRoot: string, runId: string, createdAt: string, scriptPath: string): void {
  // The index is a tab-separated, one-line-per-run log; a tab/newline in the
  // (last-field) script path would corrupt it. Sanitize control chars to a
  // space — run.toml holds the canonical, TOML-escaped script_path.
  const safePath = scriptPath.replace(/[\t\r\n]/g, " ");
  appendFileSync(join(runsRoot, "index"), `${runId}\t${createdAt}\t${safePath}\n`);
}

export function updateLatest(runsRoot: string, runId: string): void {
  // Scope the temp name to runId so concurrent same-lab submits don't race on
  // a shared `.latest.tmp` (one would unlink the other's in-flight temp).
  const tmp = join(runsRoot, `.latest.${runId}.tmp`);
  rmSync(tmp, { force: true });
  symlinkSync(runId, tmp);
  renameSync(tmp, join(runsRoot, "latest"));
}
