// doctor.ts — `amico doctor`: v1 (#402) validates the studio BINDING — the
// world, not just the schema; v2 (#525) adds the FLEET SURFACE INVENTORY
// (surfaces.ts): five physical surfaces, six records, verdicts by version
// string or content digest (never mtime). v1's checks are preserved verbatim
// — the report GAINS a surfaces section; nothing v1 consumers rely on breaks.
import type { StudioPaths } from "@amicode/schema";
import { studioPathsOrLegacy } from "@amicode/schema";
import {
  surfaceInventory,
  renderSurfacesTable,
  canonicalJson,
  type SurfaceContext,
  type SurfacesReport,
} from "./surfaces.js";

export interface Diagnosis {
  ok: boolean; // no ERRORS (warnings don't fail the doctor)
  errors: string[];
  warnings: string[];
  checks: { name: string; status: "ok" | "warn" | "error"; detail: string }[];
}

type Exists = (p: string) => Promise<boolean>;

/** The binding diagnosed against an injected existence probe (async — the
 *  world is IO). Errors fail the doctor; warnings inform. */
export async function diagnoseStudio(paths: StudioPaths, exists: Exists): Promise<Diagnosis> {
  const checks: Diagnosis["checks"] = [];
  const errors: string[] = [];
  const warnings: string[] = [];
  const err = (name: string, detail: string) => {
    checks.push({ name, status: "error", detail });
    errors.push(`${name}: ${detail}`);
  };
  const warn = (name: string, detail: string) => {
    checks.push({ name, status: "warn", detail });
    warnings.push(`${name}: ${detail}`);
  };
  const ok = (name: string, detail: string) => checks.push({ name, status: "ok", detail });

  ok("source", paths.source === "manifest" ? "manifest-bound" : "legacy (no manifest — today's ladder)");

  for (const [name, p] of [
    ["studio_root", paths.studioRoot],
    ["problems", paths.problems],
    ["runs", paths.runs],
    ["ledger", paths.ledger],
    ["vaults_root", paths.vaultsRoot],
  ] as const) {
    if (await exists(p)) ok(name, p);
    else err(name, `missing: ${p}`);
  }

  // mounts: readable, and exactly one rw personal wins writes by kind
  const personal = paths.mounts.filter((m) => m.kind === "personal" && m.mode === "rw");
  for (const m of paths.mounts) {
    if (await exists(m.path)) ok(`mount ${m.name}`, `${m.kind}/${m.mode} ${m.path}`);
    else err(`mount ${m.name}`, `unreadable: ${m.path}`);
  }
  if (paths.source === "manifest") {
    if (personal.length === 0) err("mounts", "no rw personal mount — writes have nowhere to route by kind");
    if (personal.length > 1) err("mounts", `exactly one rw personal mount wins writes; found ${personal.length} (${personal.map((m) => m.name).join(", ")})`);
  }

  // the KNOWN drift (warnings — the relocation slices' to-do list)
  if (paths.source === "legacy") {
    warn("legacy", "no studio manifest — running today's ~/.amico ladder");
    warn("ledger", `ledger lives in the dotdir (${paths.ledger}) — relocation slice moves it under the studio root`);
    if (paths.catalog === null) warn("catalog", "no studio catalog root (legacy: catalog inside a team vault) — relocation slice");
  } else {
    if (!paths.ledger.startsWith(paths.studioRoot))
      warn("ledger", `ledger outside the studio root (${paths.ledger} ≠ ${paths.studioRoot}/**)`);
    if (!paths.problems.startsWith(paths.studioRoot))
      warn("problems", `problems outside the studio root (${paths.problems}) — legacy layout declared explicitly`);
    if (!paths.runs.startsWith(paths.studioRoot))
      warn("runs", `runs outside the studio root (${paths.runs}) — legacy layout declared explicitly`);
  }

  return { ok: errors.length === 0, errors, warnings, checks };
}

/** The CLI entry: diagnose THIS machine's binding and print the table.
 *  v2 (#525): accepts the doctor flags — `--json` (the machine contract) and
 *  the injectable roots (`--root-vscext`, `--root-config`, `--root-server`,
 *  `--root-repo-amicode`, `--root-repo-fork`, `--root-staging`, plus
 *  `--running-binary <path>` to stub the running-process evidence). With no
 *  args it behaves exactly as v1 plus the appended surfaces table. */
export interface DoctorArgs {
  json: boolean;
  roots: Partial<SurfaceContext>;
  runningBinary: string | null;
}

export function parseDoctorArgs(argv: string[]): { ok: true; args: DoctorArgs } | { ok: false; message: string } {
  const args: DoctorArgs = { json: false, roots: {}, runningBinary: null };
  const rootFlags: Record<string, keyof SurfaceContext> = {
    "--root-vscext": "rootVscext",
    "--root-config": "rootConfig",
    "--root-server": "rootServer",
    "--root-repo-amicode": "rootRepoAmicode",
    "--root-repo-fork": "rootRepoFork",
    "--root-staging": "rootStaging",
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--json") {
      args.json = true;
    } else if (a === "--running-binary") {
      const v = argv[++i];
      if (!v) return { ok: false, message: "--running-binary requires a path" };
      args.runningBinary = v;
    } else if (rootFlags[a]) {
      const v = argv[++i];
      if (!v) return { ok: false, message: `${a} requires a path` };
      (args.roots as Record<string, unknown>)[rootFlags[a]] = v;
    } else {
      return { ok: false, message: `unknown doctor flag: ${a}` };
    }
  }
  if (args.runningBinary !== null) args.roots.runningBinary = args.runningBinary;
  return { ok: true, args };
}

export async function doctorReport(
  argv: string[] = [],
): Promise<{ diagnosis: Diagnosis; surfaces: SurfacesReport; rendered: string; json: string | null; exit: number }> {
  const parsed = parseDoctorArgs(argv);
  if (!parsed.ok) {
    const message = `doctor: ${parsed.message}`;
    return {
      diagnosis: { ok: false, errors: [message], warnings: [], checks: [] },
      surfaces: { schema_version: "2", surfaces: [] },
      rendered: message,
      json: null,
      exit: 64,
    };
  }
  let paths = studioPathsOrLegacy();
  try {
    paths = studioPathsOrLegacy();
  } catch {
    paths = studioPathsOrLegacy(); // malformed already degraded to legacy inside
  }
  const stat = async (p: string) => {
    const { statSync } = await import("node:fs");
    try {
      statSync(p);
      return true;
    } catch {
      return false;
    }
  };
  const diagnosis = await diagnoseStudio(paths, stat);
  const surfaces = await surfaceInventory(parsed.args.roots);
  const width = Math.max(...diagnosis.checks.map((c) => c.name.length));
  const lines = diagnosis.checks.map((c) => {
    const mark = c.status === "ok" ? "ok  " : c.status === "warn" ? "warn" : "ERR ";
    return `  ${mark}  ${c.name.padEnd(width)}  ${c.detail}`;
  });
  const summary = diagnosis.ok
    ? `studio binding healthy${diagnosis.warnings.length ? ` (${diagnosis.warnings.length} warning${diagnosis.warnings.length > 1 ? "s" : ""})` : ""}`
    : `studio binding has ${diagnosis.errors.length} error${diagnosis.errors.length > 1 ? "s" : ""}`;
  const rendered = `${summary}\n${lines.join("\n")}\n\n${renderSurfacesTable(surfaces.surfaces)}`;
  // the machine contract (panel + watchdog): canonical JSON, schema-stamped —
  // deep-sorted keys, 2-space indent, trailing newline (the vault-card form).
  // #804: schema v2 — the top-level schema_version rides every report; the
  // consumers (fleet watchdog, settings panel) are tolerate-then-warn.
  const json = parsed.args.json ? canonicalJson(surfaces) : null;
  return {
    diagnosis,
    surfaces,
    rendered,
    json,
    // surfaces never fail the report (they degrade individually) — exit stays v1's
    exit: diagnosis.ok ? 0 : 1,
  };
}
