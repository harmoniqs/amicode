// `amico fleet status --projection` (#1068, fleet rearchitect P3b-1) — the
// fleet-AUTHORITY status: the entitlement-gated read of amicissimo's
// published, provenance-stamped projection (spec spec-20260913-114814 §3 D1,
// countermeasure row 1). The session-registry `status --session <id>` keeps
// its pinned contract; `--projection` routes here.
//
// The three properties this module exists to enforce:
//   1. ONE PARSER PATH. The projection is validated + rendered by
//      @amicode/schema's fleet_projection reader (contract v1) — this verb
//      never parses topology/health/locks itself. A stale/future/absent
//      contract version surfaces the reader's LOUD rejection verbatim
//      (invariant 5: one path, versioned — the hub rejects stale contract
//      versions loudly, and so does the client read).
//   2. THE INVOCATION SEAM. The publisher is a SUBPROCESS BOUNDARY:
//      `python3 -m fleet_authority publish --out <path>` with cwd = the
//      resolved amicissimo checkout (amicissimo#414, the companion entry
//      point — possibly unmerged at the time this lands, so the seam is a
//      typed, injectable interface; the default impl spawns exactly the
//      pinned command line and the tests mock it with fixture projections).
//   3. THE BOOTSTRAP EXCEPTION. Absent entitlement or absent checkout is
//      base-standalone HONESTLY STATED with a pointer to the grant path,
//      exiting FLEET_BOOTSTRAP_EXIT (75) — distinct from success (a silent
//      no), from usage (64, the user's mistake), and from a stack trace
//      (never). The mode field is untouched: stating base-standalone is a
//      floor report, never a mode-machine write (spec invariant 7).
//
// Entitlement + checkout resolution follow `amico premium`'s machinery
// precedent (src/premium.ts — PREMIUM_CODE "amicissimo", the AMICISSIMO_ROOT
// ladder): the same codes file, the same ladder, the same funnel invariant —
// a not-granted machine loses nothing, it is told what it is.
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import * as path from "node:path";
import {
  FleetContractVersionError,
  freshnessAdvisory,
  freshnessBetween,
  readProjection,
  renderFleetStatus,
  fleetProjectionCachePath,
  fleetTopologyPath,
  buildBaseProjection,
  parseFleetTopology,
  type FleetProjection,
} from "@amicode/schema";
import { PREMIUM_CODE, readCodes } from "./premium.js";
import type { VerbResult } from "./verbs.js";

/** The bootstrap exception's exit code. 75: deliberately distinct from 0
 *  (success — a silent no would lie), 64 (usage — this is not the user's
 *  mistake), and 1 (an unexpected failure — this is an expected, honest
 *  state). The P3b-2 consumers (installer, guard) branch on it. */
export const FLEET_BOOTSTRAP_EXIT = 75;

/** The subprocess boundary's typed record — what the default impl spawns and
 *  what the tests mock. `program` + `args` is the full command line; `cwd` is
 *  the resolved amicissimo checkout (so `-m fleet_authority` resolves against
 *  the checkout's package); `outPath` is where the projection must land. */
export interface PublisherInvocation {
  program: string;
  args: string[];
  cwd: string;
  outPath: string;
}

export interface PublisherResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface FleetProjectionDeps {
  checkDir?: (p: string) => boolean;
  readFile?: (p: string) => string | null;
  /** THE invocation seam (injectable): the publisher subprocess call. */
  runPublisher?: (inv: PublisherInvocation) => PublisherResult;
  /** #1106 (P3b-2): where the validated projection is cached for the
   *  consumers. Default: the stable convention path
   *  (`~/.amico/ops/fleet/projection.json` — the live-layout precedent). */
  cachePath?: string;
  /** #1194: the machine's fleet topology file — the publisher's --topology
   *  source. Default: the live-layout convention
   *  (`~/.amico/ops/fleet/fleet.json`). Absent file = no flag (the honest
   *  base-default standalone for unenrolled machines). */
  topologyPath?: string;
  /** #1194: the topology-file existence check (injectable, hermetic tests). */
  checkFile?: (p: string) => boolean;
  /** #1106: the cache write (injectable). Default: mkdir -p + atomic
   *  tmp+rename, mirroring the extension's writeFleetConfig discipline. */
  writeCache?: (p: string, content: string) => void;
  /** ADR 0023 (base tier): the STABLE per-machine epoch source. Default:
   *  read-or-mint `~/.amico/ops/fleet/base_epoch`. Injected in tests. */
  baseEpoch?: () => string;
  /** ADR 0023: the monotonic publish counter. Default: a persisted counter
   *  seeded from the publish wall-second. */
  baseCounter?: () => number;
  /** ADR 0023: the ISO publish stamp (provenance only). Default: now. */
  nowIso?: () => string;
}

function flagValue(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined;
}

/** Parse the projection-status flags: `--projection` (the routing marker,
 *  tolerated wherever it appears), `--checkout <dir>`, `--config <file>`,
 *  `--previous <projection.json>`. Anything else is a usage error naming the
 *  offender — never silently ignored. */
function parseFlags(argv: string[]): { ok: true; flags: { checkout?: string; config?: string; previous?: string } } | { ok: false; errors: string[] } {
  const flags: { checkout?: string; config?: string; previous?: string } = {};
  const takesValue = new Set(["--checkout", "--config", "--previous"]);
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (tok === "--projection") continue;
    if (tok.startsWith("--")) {
      if (!takesValue.has(tok)) return { ok: false, errors: [`unknown flag ${tok} — the projection status accepts --checkout, --config, --previous (and the routing marker --projection)`] };
      const v = argv[i + 1];
      if (v === undefined) return { ok: false, errors: [`${tok} requires a value`] };
      flags[tok.slice(2) as "checkout" | "config" | "previous"] = v;
      i++;
      continue;
    }
    return { ok: false, errors: [`unexpected positional argument ${tok}`] };
  }
  return { ok: true, flags };
}

/** The default publisher subprocess — THE invocation seam's production impl.
 *  Exactly the pinned command line, nothing else: `python3 -m fleet_authority
 *  publish --out <path>` in the checkout's cwd (the #414 entry point). */
function defaultRunPublisher(inv: PublisherInvocation): PublisherResult {
  const r = spawnSync(inv.program, inv.args, { cwd: inv.cwd, encoding: "utf8" });
  return { code: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

function fail(errors: string[], extra: Record<string, unknown> = {}): VerbResult {
  return { json: { verb: "fleet", subcommand: "status", projection: true, ok: false, errors, ...extra }, code: 64 };
}

/** The bootstrap exception — base-standalone honestly stated, never a mode
 *  write, never a crash, exit FLEET_BOOTSTRAP_EXIT. */
function bootstrap(reason: "entitlement" | "checkout", rendered: string, extra: Record<string, unknown> = {}): VerbResult {
  return {
    json: {
      verb: "fleet",
      subcommand: "status",
      projection: true,
      ok: false,
      bootstrap: true,
      reason,
      mode: "standalone",
      rendered,
      note: "bootstrap exception — base-standalone stated, not written: the mode field is untouched (spec invariant 7); grant the entitlement + provide the checkout to light the fleet surfaces",
      ...extra,
    },
    code: FLEET_BOOTSTRAP_EXIT,
  };
}

/** The default atomic cache writer — mkdir -p + tmp+rename. Shared by the
 *  amicissimo success path and the base-tier producer. */
function defaultWriteCache(p: string, content: string): void {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmpFile = `${p}.${process.pid}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(tmpFile, content);
    fs.renameSync(tmpFile, p);
  } finally {
    fs.rmSync(tmpFile, { force: true });
  }
}

/** The base-tier epoch file — a stable per-machine UUID, minted once and reused
 *  so freshness comparisons stay within one epoch (ADR 0023). */
function baseEpochPath(): string {
  return path.join(homedir(), ".amico", "ops", "fleet", "base_epoch");
}

/** Read-or-mint the stable base-tier epoch (production default; tests inject
 *  deps.baseEpoch). Exclusive creation makes concurrent first publishes agree
 *  on the one epoch that was actually persisted. */
function defaultBaseEpoch(): string {
  const p = baseEpochPath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const epoch = randomUUID();
  try {
    fs.writeFileSync(p, epoch, { encoding: "utf8", flag: "wx" });
    return epoch;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    const existing = fs.readFileSync(p, "utf8").trim();
    if (existing.length === 0) throw new Error(`base-tier epoch file is empty: ${p}`);
    return existing;
  }
}

function baseCounterPath(): string {
  return path.join(homedir(), ".amico", "ops", "fleet", "base_counter.json");
}

interface BaseCounterLease {
  counter: number;
  release: () => void;
}

/** Hold the counter lock through projection publication, so concurrent callers
 *  cannot publish a lower reserved counter after a higher one. */
function acquireBaseCounterLock(lockPath: string): () => void {
  const token = `${process.pid}:${randomUUID()}`;
  const deadline = process.hrtime.bigint() + 5_000_000_000n;
  for (;;) {
    try {
      fs.writeFileSync(lockPath, token, { encoding: "utf8", flag: "wx" });
      return () => {
        if (fs.readFileSync(lockPath, "utf8") === token) fs.rmSync(lockPath, { force: true });
      };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      if (process.hrtime.bigint() >= deadline) {
        throw new Error(`timed out acquiring base-tier counter lock: ${lockPath}`);
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
  }
}

/** Persist and reserve the next counter for this epoch. The returned lease is
 *  released only after the projection cache has been published. */
function defaultBaseCounter(epoch: string): BaseCounterLease {
  const p = baseCounterPath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const release = acquireBaseCounterLock(`${p}.lock`);
  try {
    let last: number | undefined;
    try {
      const state = JSON.parse(fs.readFileSync(p, "utf8")) as { epoch?: unknown; counter?: unknown };
      if (state.epoch !== epoch) {
        last = undefined;
      } else if (Number.isSafeInteger(state.counter) && (state.counter as number) >= 0) {
        last = state.counter as number;
      } else {
        throw new Error(`base-tier counter file is invalid: ${p}`);
      }
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
    const wallSecond = Math.floor(Date.now() / 1000);
    const counter = last === undefined ? wallSecond : Math.max(wallSecond, last + 1);
    if (!Number.isSafeInteger(counter)) throw new Error(`base-tier counter exhausted: ${p}`);
    defaultWriteCache(p, JSON.stringify({ epoch, counter }) + "\n");
    return { counter, release };
  } catch (e) {
    release();
    throw e;
  }
}

/** ADR 0023 — the base-tier producer. When the amicissimo authority is
 *  unavailable (no entitlement / no checkout) but the machine carries a
 *  fleet.json declaring a real role (client/server), render + cache a minimal
 *  contract-v1 projection from that membership file and return success, so the
 *  base product still gets an enforced client. Returns null when there is no
 *  usable enrolled role — the caller then keeps the honest bootstrap (exit 75).
 *  This is a PRODUCER: consumers still read the cached projection through the
 *  ONE reader, unchanged. */
function tryBaseTierProjection(
  deps: FleetProjectionDeps,
  reason: "entitlement" | "checkout",
): VerbResult | null {
  const topologyPath = deps.topologyPath ?? fleetTopologyPath();
  const read = deps.readFile ?? ((p: string) => (fs.existsSync(p) ? fs.readFileSync(p, "utf8") : null));
  const raw = read(topologyPath);
  if (raw === null) return null;
  const topo = parseFleetTopology(raw);
  if (topo === null) return null;
  // Only an ENROLLED role produces a base projection; standalone/unknown keeps
  // the existing bootstrap-75 behavior verbatim (minimal blast radius).
  if (topo.role !== "client" && topo.role !== "server") return null;

  const epoch = (deps.baseEpoch ?? defaultBaseEpoch)();
  const lease = deps.baseCounter === undefined
    ? defaultBaseCounter(epoch)
    : { counter: deps.baseCounter(), release: () => {} };
  try {
    const publishedAt = (deps.nowIso ?? (() => new Date().toISOString()))();
    const proj = buildBaseProjection(topo, { epoch, counter: lease.counter, publishedAt });
    const published = JSON.stringify(proj, null, 2);

    const cachePath = deps.cachePath ?? fleetProjectionCachePath();
    const writeCache = deps.writeCache ?? defaultWriteCache;
    writeCache(cachePath, published);

    const topology = objectValue(proj, "topology");
    const canonical = objectField(topology, "canonical");
    return {
      json: {
        verb: "fleet",
        subcommand: "status",
        projection: true,
        ok: true,
        base_tier: true,
        reason,
        mode: scalarOrBase(proj, "mode", "standalone"),
        posture: scalarOrBase(proj, "posture", "ok"),
        ...(topology === undefined ? {} : { role: topology.role }),
        ...(canonical === undefined ? {} : { canonical }),
        cache_path: cachePath,
        publisher: proj.publisher ?? {},
        sections: proj.sections ?? {},
        freshness: { counter: proj.freshness?.counter, hub_epoch: proj.freshness?.hub_epoch },
        summary: renderFleetStatus(proj),
        note:
          "base-tier projection (ADR 0023) — the amicissimo authority is unavailable ("
          + reason
          + "); this projection was rendered from the machine's fleet.json by the amicode base-tier producer (a public floor, not the authority). amicissimo stays canonical when present; every consumer reads this through the ONE reader, unchanged. Cached at "
          + cachePath,
      },
      code: 0,
    };
  } finally {
    lease.release();
  }
}

/** A section's carried value, with the base default applied when the section
 * is absent (mode absent = standalone, posture absent = ok — the projection
 * contract's additive-optional discipline; the base default is applied, not
 * invented: the reader's render states it in provenance). */
function scalarOrBase(proj: FleetProjection, section: string, base: string): unknown {
  const s = proj.sections?.[section];
  return s?.value === undefined ? base : s.value;
}

/** A section's carried value when it is an object (topology), else undefined —
 * absent stays absent, never an invented {} (#1106 machine fields). */
function objectValue(proj: FleetProjection, section: string): Record<string, unknown> | undefined {
  const v = proj.sections?.[section]?.value;
  if (v === null || typeof v !== "object" || Array.isArray(v)) return undefined;
  return v as Record<string, unknown>;
}

/** A named object field of a carried value (topology.canonical), tolerantly. */
function objectField(obj: Record<string, unknown> | undefined, field: string): Record<string, unknown> | undefined {
  if (obj === undefined) return undefined;
  const v = obj[field];
  if (v === null || typeof v !== "object" || Array.isArray(v)) return undefined;
  return v as Record<string, unknown>;
}

/** `amico fleet status --projection` — resolve the checkout (the premium
 *  ladder), gate on the entitlement, invoke the publisher at the subprocess
 *  seam, read the result through the ONE fleet projection reader, and print
 *  the provenance-rendered status summary. Backs the CLI (amico.ts) and the
 *  MCP facade through the same fleetVerb router as the registry verbs. */
export function fleetProjectionStatus(argv: string[], deps: FleetProjectionDeps = {}): VerbResult {
  const parsed = parseFlags(argv);
  if (!parsed.ok) return fail(parsed.errors);

  const configFile =
    parsed.flags.config ?? path.join(homedir(), ".amico", "amicode", "entitlements.toml");
  const checkout =
    parsed.flags.checkout ?? process.env.AMICISSIMO_ROOT ?? path.join(homedir(), "harmoniqs", "amicissimo");

  // ── the entitlement gate (the premium machinery precedent) ──
  const codes = readCodes(configFile, { readFile: deps.readFile });
  if (!codes.includes(PREMIUM_CODE)) {
    const rendered = [
      `fleet status: base-standalone (bootstrap exception) — this install does not hold the \`${PREMIUM_CODE}\` entitlement code,`,
      "so the fleet-authority surfaces are not staged for it (the base product works fully standalone).",
      "",
      "Grant path: repo access to harmoniqs/amicissimo + the code in:",
      `  ${configFile}`,
      "",
      "(bootstrap exception, exit 75 — distinct from success and from usage; see `amico premium`)",
    ].join("\n");
    // ADR 0023: an enrolled machine without amicissimo still gets an honest
    // base-tier projection from its fleet.json (so the guard enforces client).
    // Only standalone/unenrolled falls through to the bootstrap exception.
    const baseTier = tryBaseTierProjection(deps, "entitlement");
    if (baseTier !== null) return baseTier;
    return bootstrap("entitlement", rendered, { config: configFile });
  }

  // ── the checkout ladder (AMICISSIMO_ROOT → org-home default) ──
  const existsDir =
    deps.checkDir ?? ((p: string) => fs.existsSync(p) && fs.statSync(p).isDirectory());
  if (!existsDir(checkout)) {
    const rendered = [
      `fleet status: base-standalone (bootstrap exception) — the \`${PREMIUM_CODE}\` entitlement is granted, but no amicissimo checkout is present at:`,
      `  ${checkout}`,
      "",
      "Clone harmoniqs/amicissimo there, or set AMICISSIMO_ROOT, or pass --checkout <dir>.",
      "",
      "(bootstrap exception, exit 75 — distinct from success and from usage)",
    ].join("\n");
    // ADR 0023: entitled but no checkout — the authority still can't run, so an
    // enrolled machine gets the base-tier floor from fleet.json all the same.
    const baseTier = tryBaseTierProjection(deps, "checkout");
    if (baseTier !== null) return baseTier;
    return bootstrap("checkout", rendered, { checkout });
  }

  // ── the invocation seam: publish, then read ──
  // #1194: the publish needs the topology SOURCE — a topology-less publish
  // renders the mode from its base default (standalone) and, once validated,
  // clobbers an enrolled machine's cached projection on every run. The
  // machine's fleet.json (the human-confirmed membership record) is the
  // source whenever it exists; absent = unenrolled, and the publish stays
  // flag-less (the honest base-default standalone, unchanged).
  const topologyPath = deps.topologyPath ?? fleetTopologyPath();
  const fileExists = deps.checkFile ?? ((p: string) => fs.existsSync(p));
  const topologyArgs = fileExists(topologyPath) ? ["--topology", topologyPath] : [];
  const outDir = mkdtempSync(path.join(tmpdir(), "fleet-projection-"));
  try {
    const inv: PublisherInvocation = {
      program: "python3",
      args: ["-m", "fleet_authority", "publish", "--out", path.join(outDir, "projection.json"), ...topologyArgs],
      cwd: checkout,
      outPath: path.join(outDir, "projection.json"),
    };
    const result = deps.runPublisher ? deps.runPublisher(inv) : defaultRunPublisher(inv);
    if (result.code !== 0) {
      return fail(
        [
          `the fleet-authority publisher failed (exit ${result.code}): ${result.stderr.trim() || "(no stderr)"}`,
          `invoked \`${inv.program} ${inv.args.join(" ")}\` in ${checkout} — the amicissimo#414 entry point (python3 -m fleet_authority) may be absent from this checkout; nothing was read or rendered`,
        ],
        { checkout, out_path: inv.outPath },
      );
    }

    let previous: FleetProjection | null = null;
    if (parsed.flags.previous !== undefined) {
      try {
        previous = readProjection(parsed.flags.previous);
      } catch (e) {
        return fail([`--previous ${parsed.flags.previous}: ${(e as Error).message}`], { checkout });
      }
    }

    let proj: FleetProjection;
    let published: string;
    try {
      proj = readProjection(inv.outPath);
      published = fs.readFileSync(inv.outPath, "utf8");
    } catch (e) {
      // The reader's LOUD rejection surfaces verbatim — a versioned contract
      // refuses both directions, naming both versions (invariant 5).
      const message =
        e instanceof FleetContractVersionError
          ? `${e.message} (projection published to ${inv.outPath} speaks a contract this CLI does not)`
          : `the published projection at ${inv.outPath} failed the contract read: ${(e as Error).message}`;
      return fail([message], { checkout, out_path: inv.outPath });
    }

    // ── the stable projection-cache refresh (#1106, P3b-2) ──
    // ONLY a projection the reader validated reaches the cache — a rejected
    // contract version never clobbers the consumers' artifact. The cached
    // bytes are the publisher's own output, verbatim.
    const cachePath = deps.cachePath ?? fleetProjectionCachePath();
    const writeCache = deps.writeCache ?? defaultWriteCache;
    writeCache(cachePath, published);

    // ── the additive machine fields for script consumers (#1106) ──
    // The installer (and any bash consumer) reads `role` + `canonical` from
    // this JSON line instead of grepping the raw fleet.json; absent topology
    // renders absent, never invented.
    const topology = objectValue(proj, "topology");
    const canonical = objectField(topology, "canonical");

    const verdict = previous === null ? null : freshnessBetween(previous, proj);
    const advisory = verdict === null ? "" : freshnessAdvisory(verdict);
    const fresh = proj.freshness ?? {};
    return {
      json: {
        verb: "fleet",
        subcommand: "status",
        projection: true,
        ok: true,
        checkout,
        mode: scalarOrBase(proj, "mode", "standalone"),
        posture: scalarOrBase(proj, "posture", "ok"),
        ...(topology === undefined ? {} : { role: topology.role }),
        ...(canonical === undefined ? {} : { canonical }),
        cache_path: cachePath,
        publisher: proj.publisher ?? {},
        sections: proj.sections ?? {},
        freshness: {
          counter: fresh.counter,
          hub_epoch: fresh.hub_epoch,
          ...(verdict === null ? {} : { verdict, advisory: advisory === "" ? undefined : advisory }),
        },
        summary: renderFleetStatus(proj, previous),
        note: "read through the ONE fleet projection reader (@amicode/schema fleet_projection, contract v"
          + String(proj.contract_version) + ") — amicissimo parses and publishes, amicode consumes (spec §3 D1); provenance renders beside the data, never merged; the validated projection is cached for the P3b-2 consumers at "
          + cachePath,
      },
      code: 0,
    };
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
}
