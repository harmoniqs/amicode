// `amico catalog` — the real spine bookkeeping verb (issue #111, slice B2). Two
// subcommands, both deterministic filesystem work callable via bash by either
// runtime, by the harness, or by cron/CI:
//
//   amico catalog query  --platform <p> --kind <g>
//       → the incumbent pulse metadata for (platform, gate), plus the ranked
//         candidate list, read from the repertoire (metadata.toml records). This
//         is the warm-start lookup the interview does before authoring a solve.
//
//   amico catalog ingest --platform <p> --kind <g> [--from-run <dir>]
//                        [--artifact <file.jld2>] [--fidelity <f>] [--agree true|false] …
//       → the PROMOTION path. Gated on verification.agree (matching the existing
//         semantics: a free-tier run is promotable only when the independent
//         re-rollout agreed — verification.toml `agree = true`). When gated open,
//         it promotes iff the candidate BEATS the incumbent (amico-catalog Version
//         rule), writing a new `{platform}-{kind}-v{N+1}` entry (metadata.toml +
//         copied pulse.jld2) with `warm_start` lineage back to the incumbent.
//
// FLAG NAMES (S31 guard): the gate discriminator is `--kind` (issue #111's
// acceptance surface) and maps onto the repertoire's `gate` field (e.g. X | CZ).
// The pulse-artifact path is `--artifact`. test/s31.test.ts bans the physics-knob
// double-dash flags (gate/pulse/system) anywhere in src/; a pulse-file PATH is not
// a physics knob — same category as the spec / from-run file paths — so it takes a
// non-colliding name. (`--kind` here is also a DIFFERENT axis from `amico resolve
// --kind`, where kind = problem-kind such as gate_synthesis.)
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { parse as parseToml, stringify as stringifyToml } from "smol-toml";
import {
  beats,
  catalogPulsesDir,
  loadRepertoire,
  nextVersionId,
  queryIncumbent,
  type PulseRecord,
} from "./repertoire.js";
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

/** Present a record for JSON output: the persisted fields + the resolved absolute
 *  pulse path (dropping the internal `dir`). */
function present(rec: PulseRecord): Record<string, unknown> {
  const { dir, ...rest } = rec;
  const pulse = join(dir, "pulse.jld2");
  return { ...rest, dir, pulse_path: existsSync(pulse) ? pulse : null };
}

// ── query ──────────────────────────────────────────────────────────────────
export function catalogQuery(argv: string[]): VerbResult {
  const platform = flagValue(argv, "--platform");
  const gate = flagValue(argv, "--kind");
  if (!platform || !gate) {
    return {
      json: { verb: "catalog", subcommand: "query", error: "--platform and --kind are required" },
      code: 64,
    };
  }
  const pulsesDir = catalogPulsesDir();
  const { incumbent, candidates } = queryIncumbent(loadRepertoire(pulsesDir), platform, gate);
  return {
    json: {
      verb: "catalog",
      subcommand: "query",
      catalog: pulsesDir,
      platform,
      gate,
      count: candidates.length,
      incumbent: incumbent ? present(incumbent) : null,
      candidates: candidates.map(present),
    },
    code: 0,
  };
}

// ── ingest ─────────────────────────────────────────────────────────────────
/** Parse the verification gate: explicit `--agree` wins; else the run dir's
 *  verification.toml `agree`; else undefined (no evidence → not verified). */
function resolveAgree(argv: string[], runDir: string | undefined): { agree?: boolean; error?: string } {
  const explicit = flagValue(argv, "--agree");
  if (explicit !== undefined) {
    if (explicit === "true") return { agree: true };
    if (explicit === "false") return { agree: false };
    return { error: `--agree must be true or false (got "${explicit}")` };
  }
  if (runDir) {
    const v = readTomlSafe(join(runDir, "verification.toml"));
    if (v && typeof v.agree === "boolean") return { agree: v.agree };
    return {}; // run dir given but no readable verification → undefined (blocked)
  }
  return {};
}

export function catalogIngest(argv: string[]): VerbResult {
  const fail = (error: string): VerbResult => ({ json: { verb: "catalog", subcommand: "ingest", error }, code: 64 });

  const platform = flagValue(argv, "--platform");
  const gate = flagValue(argv, "--kind");
  if (!platform || !gate) return fail("--platform and --kind are required");

  const runDir = flagValue(argv, "--from-run");
  const result = runDir ? readTomlSafe(join(runDir, "result.toml")) : undefined;

  // Pulse source: explicit --artifact, else <runDir>/pulse.jld2.
  const pulse = flagValue(argv, "--artifact") ?? (runDir ? join(runDir, "pulse.jld2") : undefined);
  if (!pulse) return fail("a pulse source is required: --artifact <file.jld2> or --from-run <runDir>");
  if (!existsSync(pulse)) return fail(`pulse artifact not found: ${pulse}`);

  // Fidelity: explicit --fidelity, else result.toml `fidelity`.
  const fidRaw = flagValue(argv, "--fidelity");
  const fidelity = fidRaw !== undefined ? Number(fidRaw) : num(result?.fidelity);
  if (fidelity === undefined || !Number.isFinite(fidelity)) {
    return fail("a fidelity is required: --fidelity <f> or --from-run <runDir> with a result.toml");
  }

  // ── the promotion GATE: verification.agree must be true ──
  const { agree, error } = resolveAgree(argv, runDir);
  if (error) return fail(error);
  if (agree !== true) {
    return {
      json: {
        verb: "catalog",
        subcommand: "ingest",
        promoted: false,
        blocked: true,
        agree: agree ?? null,
        reason:
          agree === false
            ? "verification disagreed (agree = false) — the run is UNTRUSTED and cannot be promoted"
            : "no verification evidence (agree unknown) — pass --agree true or --from-run <runDir> with a verification.toml",
      },
      code: 64,
    };
  }

  const pulsesDir = catalogPulsesDir();
  const records = loadRepertoire(pulsesDir);
  const { incumbent } = queryIncumbent(records, platform, gate);
  const durRaw = flagValue(argv, "--duration-us");
  const duration_us = durRaw !== undefined ? Number(durRaw) : num(result?.duration_us);

  const candidate: PulseRecord = {
    id: "(candidate)",
    platform,
    gate,
    fidelity,
    duration_us: duration_us !== undefined && Number.isFinite(duration_us) ? duration_us : undefined,
    dir: "",
  };

  // amico-catalog Version rule: promote only when the candidate beats the incumbent.
  if (!beats(candidate, incumbent)) {
    return {
      json: {
        verb: "catalog",
        subcommand: "ingest",
        promoted: false,
        agree: true,
        incumbent: incumbent ? present(incumbent) : null,
        reason: `does not beat the incumbent ${incumbent?.id} (fidelity ${incumbent?.fidelity})`,
      },
      code: 0,
    };
  }

  const id = flagValue(argv, "--id") ?? nextVersionId(records, platform, gate);
  const warmStart = flagValue(argv, "--warm-start") ?? incumbent?.id ?? "";
  const tagsRaw = flagValue(argv, "--tags");
  const tags = tagsRaw
    ? tagsRaw
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean)
    : undefined;

  const dryRun = argv.includes("--dry-run");
  const entryDir = join(pulsesDir, id);
  const relPath = `pulses/${id}/pulse.jld2`;

  // Build the flat metadata record in a stable, human-readable key order.
  const meta: Record<string, unknown> = {
    schema_version: 1,
    id,
    platform,
    gate,
    fidelity,
  };
  if (candidate.duration_us !== undefined) meta.duration_us = candidate.duration_us;
  const pulseType = flagValue(argv, "--type");
  if (pulseType) meta.pulse_type = pulseType;
  const nKnotsRaw = flagValue(argv, "--n-knots");
  if (nKnotsRaw !== undefined && Number.isFinite(Number(nKnotsRaw))) meta.N_knots = Number(nKnotsRaw);
  if (argv.includes("--free-phase")) meta.free_phase = true;
  meta.path = relPath;
  meta.branch = flagValue(argv, "--branch") ?? "main";
  meta.warm_start = warmStart;
  if (tags) meta.tags = tags;
  meta.date = new Date().toISOString().slice(0, 10);
  // W4.1: content hash of pulse.jld2 for verifiable warm-start provenance
  try {
    const data = readFileSync(pulse);
    meta.pulse_hash = "sha256:" + createHash("sha256").update(data).digest("hex");
  } catch {
    // if pulse unreadable, omit hash (honest gap)
  }

  if (dryRun) {
    return {
      json: {
        verb: "catalog",
        subcommand: "ingest",
        promoted: false,
        dry_run: true,
        agree: true,
        would_write: { id, dir: entryDir, metadata: meta },
        incumbent: incumbent ? present(incumbent) : null,
      },
      code: 0,
    };
  }

  if (existsSync(entryDir)) {
    return fail(`catalog entry already exists: ${entryDir} (pass --id to override the version)`);
  }

  try {
    mkdirSync(entryDir, { recursive: true });
    copyFileSync(pulse, join(entryDir, "pulse.jld2"));
    writeFileSync(join(entryDir, "metadata.toml"), stringifyToml(meta) + "\n");
  } catch (e) {
    return fail(`failed to write catalog entry: ${e instanceof Error ? e.message : String(e)}`);
  }

  return {
    json: {
      verb: "catalog",
      subcommand: "ingest",
      promoted: true,
      agree: true,
      id,
      dir: entryDir,
      path: relPath,
      pulse_path: join(entryDir, "pulse.jld2"),
      fidelity,
      warm_start: warmStart,
      previous_incumbent: incumbent ? { id: incumbent.id, fidelity: incumbent.fidelity } : null,
    },
    code: 0,
  };
}

function num(v: unknown): number | undefined {
  return typeof v === "number" ? v : undefined;
}

// ── dispatch ─────────────────────────────────────────────────────────────────
/** The `catalog` verb body: dispatch on the subcommand. Backs BOTH the CLI
 *  (amico.ts) and the MCP facade (mcp_serve.ts) — one impl, two transports. */
export function catalogVerb(argv: string[]): VerbResult {
  const sub = argv[0];
  const rest = argv.slice(1);
  if (sub === "query") return catalogQuery(rest);
  if (sub === "ingest") return catalogIngest(rest);
  return {
    json: {
      verb: "catalog",
      error: `unknown subcommand ${sub ? `"${sub}"` : "(none)"}`,
      usage: "amico catalog query --platform <p> --kind <g>  |  amico catalog ingest --platform <p> --kind <g> …",
    },
    code: 64,
  };
}
