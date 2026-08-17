// doctor.ts — `amico doctor` (#402): validate the studio BINDING — the world,
// not just the schema. The schema checks structure; this checks existence,
// mount health, the exactly-one-rw-personal rule, and flags the KNOWN legacy
// drift as warnings (the relocation slices' to-do list — drift is not breakage).
import type { StudioPaths } from "@amicode/schema";
import { studioPathsOrLegacy } from "@amicode/schema";

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

/** The CLI entry: diagnose THIS machine's binding and print the table. */
export async function doctorReport(): Promise<{ diagnosis: Diagnosis; rendered: string; exit: number }> {
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
  const width = Math.max(...diagnosis.checks.map((c) => c.name.length));
  const lines = diagnosis.checks.map((c) => {
    const mark = c.status === "ok" ? "ok  " : c.status === "warn" ? "warn" : "ERR ";
    return `  ${mark}  ${c.name.padEnd(width)}  ${c.detail}`;
  });
  const summary = diagnosis.ok
    ? `studio binding healthy${diagnosis.warnings.length ? ` (${diagnosis.warnings.length} warning${diagnosis.warnings.length > 1 ? "s" : ""})` : ""}`
    : `studio binding has ${diagnosis.errors.length} error${diagnosis.errors.length > 1 ? "s" : ""}`;
  return { diagnosis, rendered: `${summary}\n${lines.join("\n")}`, exit: diagnosis.ok ? 0 : 1 };
}
