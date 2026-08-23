// upgrade.ts — `amico upgrade <surface>` (#526, spec-20260823-094507-fleet-dev-tools
// D2): the four upgrade chains as receipt-emitting, idempotent runbooks.
//
//   amico upgrade server-binary [--skip-build <path>] [--ref <rev>] [--kick-command <cmd>]
//                               [--health-command <cmd>] [--no-kick] [--root-server <dir>]
//   amico upgrade extension    [--package-command <cmd>] [--install-command <cmd>]
//                               [--root-vscext <dir>] [--root-repo-amicode <dir>]
//   amico upgrade agents       [--root-config <dir>] [--root-staging <dir>] [--root-repo-amicode <dir>]
//   amico upgrade skills       [--root-staging <dir>] [--root-vscext <dir>]
//
// SHARED CONTRACT (all verbs):
//   - Pre-flight: the doctor v2 probe of the verb's surface(s), composed from
//     the SAME SurfaceContext (surfaces.ts). `current` → exit-0 no-op receipt;
//     `unknown` → aborted-unknown (never upgrade what you cannot judge);
//     `stale` / `integrity-failure` → proceed (integrity-failure IS the fix case).
//   - Lock: single-operator, flock semantics — O_EXCL lockfile carrying the
//     holder PID; a dead holder's lock is stolen (crash-release: an abandoned
//     lock dies with its process). A live holder → aborted-locked. The lock
//     lives at <root-receipts>/.lock.
//   - Receipts: append-only JSONL at <root-receipts>/upgrade-receipts.jsonl —
//     verb, timestamp, pre/post surface records, source digests, verification,
//     outcome ∈ upgraded | no-op | restored | restore-failed | aborted-<reason>.
//     Default root-receipts derives from --root-server (live:
//     ~/.amico/server/upgrade-receipts), so fixture roots are hermetic by
//     construction; --root-receipts overrides it outright.
//   - Verification: never a self-reported flag — the post record comes from a
//     fresh doctor probe, and the fixture suite re-runs doctor independently
//     and matches it field-for-field.
//
// STUB COMMAND CONTRACT (the hermetic seams; tokens + env, both available):
//   {frozen} {running} {prev} {server} {version} {vsix} {repo}   (path tokens)
//   AMICO_UPGRADE_FROZEN_BIN / _RUNNING_BIN / _PREV_BIN / _ROOT_SERVER /
//   AMICO_UPGRADE_ROOT_VSCEXT / _TARGET_VERSION / _REPO_AMICODE / _VSIX /
//   AMICO_UPGRADE_PHASE ∈ kick | verify | verify-retry | restore-kick | restore
//
//   The KICK STUB's contract (spec D2): make the health command succeed AND
//   make the running-binary evidence match the frozen artifact — e.g.
//     --kick-command 'cp "$AMICO_UPGRADE_FROZEN_BIN" "$AMICO_UPGRADE_RUNNING_BIN"'
//   The HEALTH STUB shapes the verify phase: exit 0 = healthy; the phase env
//   lets a stub fail the upgrade's verify while passing the restore's.
//
// LIVE DISPATCH PROOF — the exact commands for the real server-binary upgrade
// on the mini, and what the receipt must show, live in
// docs/upgrade-live-dispatch.md (this slice does NOT run the live upgrade).
import { execFile } from "node:child_process";
import { mkdir, open, readFile, rm, copyFile, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  surfaceInventory,
  newestExtensionDir,
  dirDigest,
  type SurfaceContext,
  type SurfaceRecord,
  type SurfaceName,
} from "./surfaces.js";
import type { VerbResult } from "./verbs.js";

export type UpgradeSurface = "server-binary" | "extension" | "agents" | "skills";

export type UpgradeOutcome =
  | "upgraded"
  | "no-op"
  | "restored"
  | "restore-failed"
  | `aborted-${string}`;

export interface UpgradeReceipt {
  receipt_version: 1;
  verb: UpgradeSurface;
  timestamp: string;
  outcome: UpgradeOutcome;
  /** pre-flight doctor record(s) for the verb's surface(s); null when the verb
   *  refused before probing (aborted-locked, usage) */
  pre: SurfaceRecord[] | null;
  /** post-execution doctor record(s); null when nothing executed (aborts) */
  post: SurfaceRecord[] | null;
  source_digests: Record<string, string | null>;
  /** true | false | "deferred" (server-binary --no-kick); null when aborted */
  verification: boolean | "deferred" | null;
  /** step traces + failure reasons — the human story behind the outcome */
  detail: string[];
}

const USAGE =
  "amico upgrade <server-binary | extension | agents | skills> [--root-…] " +
  "[--skip-build <p>] [--ref <rev>] [--kick-command <c>] [--health-command <c>] [--no-kick] " +
  "[--package-command <c>] [--install-command <c>] [--root-receipts <dir>]";

const SURFACES: readonly UpgradeSurface[] = ["server-binary", "extension", "agents", "skills"];

const HEALTH_TIMEOUT_DEFAULT_MS = 120_000;

// ── the single-operator lock (flock semantics via O_EXCL + PID liveness) ─────

export interface UpgradeLock {
  acquired: boolean;
  reason?: string;
  release: () => Promise<void>;
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM = exists but owned by another user (single-operator assumption:
    // same launchd user — defensive) → treat as alive
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Acquire the upgrade lock. macOS has no flock(1) — the same semantics come
 *  from an O_EXCL lockfile carrying the holder's PID: a live holder blocks
 *  (aborted-locked), a dead holder's file is stolen (crash-release is free). */
export async function acquireUpgradeLock(receiptsDir: string): Promise<UpgradeLock> {
  await mkdir(receiptsDir, { recursive: true });
  const lockPath = join(receiptsDir, ".lock");
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const fh = await open(lockPath, "wx");
      await fh.writeFile(`${process.pid}\n`, "utf8");
      await fh.close();
      return { acquired: true, release: () => rm(lockPath, { force: true }) };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      const raw = await readFile(lockPath, "utf8").catch(() => null);
      const pid = raw ? Number(raw.trim()) : NaN;
      if (Number.isInteger(pid) && pid > 0 && pidAlive(pid)) {
        return {
          acquired: false,
          reason: `another upgrade holds the lock (pid ${pid}): ${lockPath}`,
          release: () => Promise.resolve(),
        };
      }
      // stale (crashed holder, or empty/unparseable) — steal and retry.
      // Two racers stealing: both unlink (ENOENT tolerated), then only one
      // wins the next O_EXCL create; the loser loops and re-checks.
      await rm(lockPath, { force: true });
    }
  }
  return {
    acquired: false,
    reason: `could not acquire the upgrade lock after stealing a stale one: ${lockPath}`,
    release: () => Promise.resolve(),
  };
}

// ── receipts (append-only JSONL) ─────────────────────────────────────────────

async function appendReceipt(receiptsDir: string, receipt: UpgradeReceipt): Promise<void> {
  await mkdir(receiptsDir, { recursive: true });
  const { appendFile } = await import("node:fs/promises");
  await appendFile(join(receiptsDir, "upgrade-receipts.jsonl"), `${JSON.stringify(receipt)}\n`, "utf8");
}

// ── shell runner for stub/live commands (tokens + env contract) ──────────────

interface ShellOpts {
  env?: Record<string, string>;
  cwd?: string;
  timeoutMs?: number;
}

async function runShell(cmd: string, opts: ShellOpts = {}): Promise<{ code: number; stdout: string; stderr: string }> {
  const script = cmd.replace(/\{(\w+)\}/g, (m, tok: string) =>
    Object.prototype.hasOwnProperty.call(opts.env ?? {}, `AMICO_UPGRADE_${tok.toUpperCase()}`)
      ? (opts.env![`AMICO_UPGRADE_${tok.toUpperCase()}`] as string)
      : m,
  );
  return new Promise((resolve) => {
    execFile(
      "sh",
      ["-c", script],
      { timeout: opts.timeoutMs ?? 300_000, cwd: opts.cwd, env: { ...process.env, ...opts.env } },
      (err, stdout, stderr) => {
        const code = err && typeof (err as { code?: number }).code === "number" ? (err as { code: number }).code : err ? 1 : 0;
        resolve({ code, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
      },
    );
  });
}

async function runGit(repo: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile("git", ["-C", repo, ...args], { timeout: 60_000 }, (err, stdout, stderr) => {
      const code = err && typeof (err as { code?: number }).code === "number" ? (err as { code: number }).code : err ? 1 : 0;
      resolve({ code, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
    });
  });
}

// ── argument parsing (mirrors doctor's root flags — keep the names in sync) ──

const ROOT_FLAGS: Record<string, keyof SurfaceContext> = {
  "--root-server": "rootServer",
  "--root-vscext": "rootVscext",
  "--root-config": "rootConfig",
  "--root-repo-amicode": "rootRepoAmicode",
  "--root-repo-fork": "rootRepoFork",
  "--root-staging": "rootStaging",
};

interface ParsedVerbArgs {
  surface: UpgradeSurface;
  roots: Partial<SurfaceContext>;
  runningBinary: string | null;
  rootReceipts: string | null;
  flags: Record<string, string>;
  bools: Set<string>;
}

export function parseUpgradeArgs(argv: string[]): { ok: true; args: ParsedVerbArgs } | { ok: false; message: string } {
  const surface = argv[0];
  if (!surface || surface.startsWith("--")) return { ok: false, message: `usage: ${USAGE}` };
  if (!SURFACES.includes(surface as UpgradeSurface)) {
    return { ok: false, message: `unknown surface "${surface}" — ${USAGE}` };
  }
  const VALUE_FLAGS = new Set([
    "--skip-build",
    "--ref",
    "--kick-command",
    "--health-command",
    "--verify-timeout-ms",
    "--package-command",
    "--install-command",
    "--root-receipts",
    ...Object.keys(ROOT_FLAGS),
    "--running-binary",
  ]);
  const BOOL_FLAGS = new Set(["--no-kick"]);
  const roots: Partial<SurfaceContext> = {};
  const flags: Record<string, string> = {};
  const bools = new Set<string>();
  let runningBinary: string | null = null;
  let rootReceipts: string | null = null;
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (BOOL_FLAGS.has(a)) {
      bools.add(a);
    } else if (ROOT_FLAGS[a]) {
      const v = argv[++i];
      if (!v) return { ok: false, message: `${a} requires a path` };
      (roots as Record<string, unknown>)[ROOT_FLAGS[a]] = v;
    } else if (a === "--running-binary") {
      const v = argv[++i];
      if (!v) return { ok: false, message: "--running-binary requires a path" };
      runningBinary = v;
    } else if (a === "--root-receipts") {
      const v = argv[++i];
      if (!v) return { ok: false, message: "--root-receipts requires a path" };
      rootReceipts = v;
    } else if (VALUE_FLAGS.has(a)) {
      const v = argv[++i];
      if (!v) return { ok: false, message: `${a} requires a value` };
      flags[a] = v;
    } else {
      return { ok: false, message: `unknown upgrade flag: ${a} — ${USAGE}` };
    }
  }
  if (runningBinary !== null) roots.runningBinary = runningBinary;
  return { ok: true, args: { surface: surface as UpgradeSurface, roots, runningBinary, rootReceipts, flags, bools } };
}

// ── shared verb scaffolding ──────────────────────────────────────────────────

interface VerbCtx {
  args: ParsedVerbArgs;
  roots: Partial<SurfaceContext>;
  receiptsDir: string;
  detail: string[];
  log: (line: string) => void;
}

function defaultRootServer(): string {
  return process.env.AMICO_SERVER_DIR ?? join(homedir(), ".amico", "server");
}

function exitCodeFor(receipt: UpgradeReceipt): number {
  if (receipt.outcome === "upgraded" || receipt.outcome === "no-op") {
    return receipt.verification === false ? 1 : 0;
  }
  return 1; // restored, restore-failed, aborted-*
}

function baseReceipt(verb: UpgradeSurface, detail: string[]): UpgradeReceipt {
  return {
    receipt_version: 1,
    verb,
    timestamp: new Date().toISOString(),
    outcome: "aborted-error",
    pre: null,
    post: null,
    source_digests: {},
    verification: null,
    detail,
  };
}

/** The doctor probe, composed over the same injected context (the verbs'
 *  pre-flight and verification both run through surfaceInventory). */
function probe(ctx: VerbCtx): Promise<{ surfaces: SurfaceRecord[] }> {
  return surfaceInventory(ctx.roots);
}

/** Pre-flight gate shared by every verb: current → no-op; any unknown → abort;
 *  stale/integrity-failure → proceed. Returns the gate decision + records. */
function gatePreflight(records: SurfaceRecord[]): { decision: "proceed" } | { decision: "no-op" } | { decision: "abort"; reason: string } {
  if (records.some((r) => r.verdict === "unknown")) {
    const unk = records.find((r) => r.verdict === "unknown")!;
    return { decision: "abort", reason: `aborted-unknown` };
  }
  if (records.every((r) => r.verdict === "current")) return { decision: "no-op" };
  return { decision: "proceed" };
}

async function finish(ctx: VerbCtx, receipt: UpgradeReceipt): Promise<VerbResult> {
  await appendReceipt(ctx.receiptsDir, receipt).catch((e) => {
    ctx.log(`receipt append failed (${e instanceof Error ? e.message : String(e)}) — the JSON below is the record`);
  });
  return { json: receipt, code: exitCodeFor(receipt) };
}

// ── the verbs ────────────────────────────────────────────────────────────────

interface VerbBodyResult {
  outcome: UpgradeOutcome;
  verification: boolean | "deferred";
  post: SurfaceRecord[];
  sourceDigests: Record<string, string | null>;
}

type VerbBody = (ctx: VerbCtx) => Promise<VerbBodyResult>;

async function runVerb(
  surface: UpgradeSurface,
  argv: string[],
  ownedSurfaces: SurfaceName[],
  body: VerbBody,
): Promise<VerbResult> {
  const parsed = parseUpgradeArgs(argv);
  if (!parsed.ok) return { json: { verb: surface, ok: false, errors: [parsed.message] }, code: 64 };
  const detail: string[] = [];
  const log = (line: string) => {
    detail.push(line);
    console.error(`amico upgrade ${surface}: ${line}`); // progress → stderr; stdout is the receipt
  };
  const rootServer = (parsed.args.roots.rootServer as string | undefined) ?? defaultRootServer();
  const receiptsDir = parsed.args.rootReceipts ?? join(rootServer, "upgrade-receipts");
  const ctx: VerbCtx = { args: parsed.args, roots: parsed.args.roots, receiptsDir, detail, log };

  const receipt = baseReceipt(surface, detail);

  // 1. the single-operator lock — before anything else touches the machine
  const lock = await acquireUpgradeLock(receiptsDir);
  if (!lock.acquired) {
    receipt.outcome = "aborted-locked";
    receipt.detail.push(lock.reason ?? "lock refused");
    return finish(ctx, receipt);
  }
  try {
    // 2. pre-flight: the doctor probe of THIS verb's surface(s)
    log(`pre-flight: probing ${ownedSurfaces.join(", ")}`);
    const pre = await probe(ctx);
    const preRecords = ownedSurfaces.map((s) => pre.surfaces.find((r) => r.surface === s)!);
    receipt.pre = preRecords;
    const gate = gatePreflight(preRecords);
    if (gate.decision === "abort") {
      receipt.outcome = gate.reason as UpgradeOutcome;
      log(`pre-flight ${gate.reason}: never upgrade what you cannot judge`);
      return finish(ctx, receipt);
    }
    if (gate.decision === "no-op") {
      receipt.outcome = "no-op";
      receipt.verification = true;
      receipt.post = preRecords; // nothing mutated — the pre state IS the post state
      log("pre-flight current — nothing to do");
      return finish(ctx, receipt);
    }

    // 3. execute + verify
    const result = await body(ctx);
    receipt.outcome = result.outcome;
    receipt.verification = result.verification;
    receipt.post = result.post;
    receipt.source_digests = result.sourceDigests;
    return finish(ctx, receipt);
  } catch (e) {
    receipt.outcome = "aborted-error";
    receipt.detail.push(`unexpected error: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
    return finish(ctx, receipt);
  } finally {
    await lock.release();
  }
}

// ── skills: the staging re-stage (the server script's re-stage step, as a verb)

const skillsVerb = (argv: string[]): Promise<VerbResult> =>
  runVerb("skills", argv, ["staged-skills"], async (ctx) => {
    const { rootVscext, rootStaging } = {
      rootVscext: ctx.roots.rootVscext!,
      rootStaging: ctx.roots.rootStaging!,
    };
    const newest = await newestExtensionDir(rootVscext);
    if (newest === null) {
      throw new Error(`no VSIX skills source (no harmoniqs.amicode-* dir under ${rootVscext})`);
    }
    const sourceSkillsDir = join(newest.dir, "skills");
    const stagedDir = join(rootStaging, "skills");
    const sourceSkills = (await readdir(sourceSkillsDir, { withFileTypes: true }))
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();

    // digest the shareable set before + the source set (the receipt's evidence)
    const digestSet = async (dir: string): Promise<Map<string, string>> => {
      const m = new Map<string, string>();
      for (const s of sourceSkills) {
        const d = await dirDigest(join(dir, s));
        if (d !== null) m.set(s, d);
      }
      return m;
    };
    const before = await digestSet(stagedDir);
    const sources = await digestSet(sourceSkillsDir);
    const setDigestOf = (m: Map<string, string>): string | null =>
      m.size === 0 ? null : `sha256:${[...m.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([n, d]) => `${n}:${d}`).join("|")}`;

    // the re-stage: per-skill exact replacement (rm + copy), SET-LEVEL NO
    // DELETE — internal-only staged skills the VSIX never ships are the
    // server's deliberate design (stage-internal-skills.sh) and are preserved.
    // Per-skill replacement (not overlay-rsync) is required for "verify
    // per-skill digests match the VSIX set" to be reachable at all.
    ctx.log(`re-staging ${sourceSkills.length} skills from VSIX ${newest.suffix} → ${stagedDir}`);
    const changed: string[] = [];
    for (const skill of sourceSkills) {
      const src = join(sourceSkillsDir, skill);
      const dst = join(stagedDir, skill);
      const srcDigest = sources.get(skill)!;
      const dstDigest = before.get(skill);
      if (dstDigest === srcDigest) continue; // already converged — untouched
      changed.push(skill);
      await rm(dst, { recursive: true, force: true });
      await mkdir(dst, { recursive: true });
      await copyTree(src, dst);
    }

    // verify: every VSIX-set skill's staged digest matches the source
    const after = await digestSet(stagedDir);
    const mismatches = sourceSkills.filter((s) => after.get(s) !== sources.get(s));
    const verification = mismatches.length === 0;
    if (!verification) ctx.log(`verification FAILED: skills not converged: ${mismatches.join(", ")}`);
    else ctx.log(`verified: all ${sourceSkills.length} VSIX-set skills byte-match the staged set`);

    // the post record from a FRESH doctor probe (never self-reported)
    const post = await probe(ctx);
    const outcome: UpgradeOutcome = changed.length > 0 ? "upgraded" : "no-op";
    return {
      outcome,
      verification,
      post: [post.surfaces.find((r) => r.surface === "staged-skills")!],
      sourceDigests: {
        vsix_set: setDigestOf(sources),
        staged_before: setDigestOf(before),
        staged_after: setDigestOf(after),
      },
    };
  });

async function copyTree(src: string, dst: string): Promise<void> {
  const entries = await readdir(src, { withFileTypes: true });
  for (const e of entries) {
    const s = join(src, e.name);
    const d = join(dst, e.name);
    if (e.isDirectory()) {
      await mkdir(d, { recursive: true });
      await copyTree(s, d);
    } else if (e.isFile()) {
      await copyFile(s, d);
    }
  }
}

// ── the remaining verbs land in their own cycles; the router rejects them
// honestly until then (never a silent no-op) ─────────────────────────────────

const notYetImplemented = (surface: UpgradeSurface) => (argv: string[]): Promise<VerbResult> =>
  runVerb(surface, argv, [], async () => {
    throw new Error(`${surface} verb body not yet implemented`);
  });

const serverBinaryVerb = notYetImplemented("server-binary");
const extensionVerb = notYetImplemented("extension");
const agentsVerb = notYetImplemented("agents");

// ── the entry ────────────────────────────────────────────────────────────────

export async function upgradeVerb(argv: string[]): Promise<VerbResult> {
  const head = argv[0];
  if (!head || head.startsWith("--")) return { json: { verb: "upgrade", ok: false, errors: [`usage: ${USAGE}`] }, code: 64 };
  switch (head) {
    case "server-binary":
      return serverBinaryVerb(argv);
    case "extension":
      return extensionVerb(argv);
    case "agents":
      return agentsVerb(argv);
    case "skills":
      return skillsVerb(argv);
    default:
      return { json: { verb: "upgrade", ok: false, errors: [`unknown surface "${head}" — ${USAGE}`] }, code: 64 };
  }
}

// re-export for the router's usage line + tests
export const UPGRADE_USAGE = USAGE;
