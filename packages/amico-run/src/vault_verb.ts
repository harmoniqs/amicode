// `amico vault` — knowledge-graph retrieval + Armonia mount-stack introspection
// (issue #113, slice B3; spec-20260708-112732 §3.1, §7.3 + plan Task 7). Read-only:
//
//   amico vault query --q "<query>" [--type insight|experiment] [--platform <p>]
//                     [--kind <g>] [--limit <n>] [--mount <id>]
//       → the notes most RELEVANT to the query, ranked (title > tags > body),
//         UNION over the whole mount stack in precedence order. A collision on the
//         same <folder>/<file> relpath is won by the higher-precedence mount.
//         `--mount <id>` restricts to one mount. `$AMICO_VAULT_DIR` forces a single
//         unnamed mount (back-compat — see mounts.ts).
//
//   amico vault status [--json]
//       → the resolved mount stack as `{ok, mounts:[{id,path,kind,writable,
//         last_sync,warnings}], error}` — FIELD-COMPATIBLE with the bash
//         `amico-vault status --json` (ops/scripts/amico-vault cmd_status). A drift
//         warning fires when the marker kind ≠ the manifest-resolved kind (manifest
//         wins); `last_sync` is `git log -1 --format=%cr`, "unknown" tolerated.
//
//   amico vault resolve <relpath>
//       → first-hit lookup of <relpath> across the stack in precedence order:
//         `{found, path, mount}` on a hit, `{found:false, path:null, misses:[…]}`
//         (the mount roots searched) otherwise.
//
// Pure logic lives in vault_query.ts (ranking + union load) and mounts.ts (stack
// resolution). This is the flag surface + I/O.
// FLAG NAMES (S31 guard): the physics-knob double-dash flags (gate/pulse/system)
// are banned in src/; the gate discriminator is `--kind`, the free-text query `--q`.
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { loadNotesAcross, rankNotes, type QueryOpts } from "./vault_query.js";
import { resolveMountStack, readVaultMarker } from "./mounts.js";
import type { VerbResult } from "./verbs.js";

function flagValue(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined;
}

// ── query (union over the mount stack) ──────────────────────────────────────────
export function vaultQuery(argv: string[]): VerbResult {
  const q = flagValue(argv, "--q");
  if (q === undefined || q.trim() === "") {
    return { json: { verb: "vault", subcommand: "query", error: "--q <query> is required" }, code: 64 };
  }
  const opts: QueryOpts = {
    type: flagValue(argv, "--type"),
    platform: flagValue(argv, "--platform"),
    gate: flagValue(argv, "--kind"),
  };
  const limitRaw = flagValue(argv, "--limit");
  if (limitRaw !== undefined) {
    const n = Number(limitRaw);
    if (!Number.isFinite(n) || n <= 0)
      return { json: { verb: "vault", subcommand: "query", error: `--limit must be a positive number (got "${limitRaw}")` }, code: 64 };
    opts.limit = Math.floor(n);
  }

  const stack = resolveMountStack();
  const only = flagValue(argv, "--mount");
  const mounts = only ? stack.mounts.filter((m) => m.name === only) : stack.mounts;
  const hits = rankNotes(loadNotesAcross(mounts), q, opts);
  return {
    json: {
      verb: "vault",
      subcommand: "query",
      vault: mounts[0]?.path ?? null, // back-compat: the highest-precedence mount root
      mounts: mounts.map((m) => m.name),
      query: q,
      filters: { type: opts.type ?? null, platform: opts.platform ?? null, gate: opts.gate ?? null, mount: only ?? null },
      count: hits.length,
      hits,
    },
    code: 0,
  };
}

// ── status (field-compatible with `amico-vault status --json`) ──────────────────
/** `git log -1 --format=%cr` for a mount; "unknown" for a non-repo (tolerated,
 *  matching the bash oracle). */
function gitLastSync(dir: string): string {
  try {
    const out = execFileSync("git", ["-C", dir, "log", "-1", "--format=%cr"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return out || "unknown";
  } catch {
    return "unknown";
  }
}

export function vaultStatus(_argv: string[]): VerbResult {
  const stack = resolveMountStack();
  const mounts = stack.mounts.map((m) => {
    const markerKind = readVaultMarker(m.path).kind;
    const warnings: string[] = [];
    // Drift: the resolved (display) kind differs from the marker kind ⇒ the manifest
    // overrode it (manifest wins). Mirrors cmd_status's drift surfacing.
    if ((markerKind ?? "") !== m.kind) {
      warnings.push(`drift: marker kind='${markerKind ?? ""}' but mounts.toml kind='${m.kind}' (using mounts.toml)`);
    }
    return { id: m.name, path: m.path, kind: m.kind, writable: m.writable, last_sync: gitLastSync(m.path), warnings };
  });
  return { json: { ok: true, mounts, error: null }, code: 0 };
}

// ── resolve (first-hit across precedence) ───────────────────────────────────────
export function vaultResolve(argv: string[]): VerbResult {
  const relpath = argv[0];
  if (!relpath || relpath.startsWith("--")) {
    return { json: { verb: "vault", subcommand: "resolve", error: "a <relpath> is required", usage: "amico vault resolve <relpath>" }, code: 64 };
  }
  const stack = resolveMountStack();
  const misses: string[] = [];
  for (const m of stack.mounts) {
    const candidate = join(m.path, relpath);
    if (existsSync(candidate)) {
      return { json: { verb: "vault", subcommand: "resolve", relpath, found: true, path: candidate, mount: m.name }, code: 0 };
    }
    misses.push(m.path);
  }
  return { json: { verb: "vault", subcommand: "resolve", relpath, found: false, path: null, misses }, code: 0 };
}

/** The `vault` verb body: dispatch on the subcommand. Backs BOTH the CLI
 *  (amico.ts) and the MCP facade (mcp_serve.ts). */
export function vaultVerb(argv: string[]): VerbResult {
  const sub = argv[0];
  const rest = argv.slice(1);
  if (sub === "query") return vaultQuery(rest);
  if (sub === "status") return vaultStatus(rest);
  if (sub === "resolve") return vaultResolve(rest);
  return {
    json: {
      verb: "vault",
      error: `unknown subcommand ${sub ? `"${sub}"` : "(none)"}`,
      usage:
        'amico vault query --q "<query>" [--type insight|experiment] [--platform <p>] [--kind <g>] [--limit <n>] [--mount <id>]  |  amico vault status [--json]  |  amico vault resolve <relpath>',
    },
    code: 64,
  };
}
