// surfaces.ts — doctor v2's surface inventory (#525, spec-20260823-094507 D1):
// FIVE physical fleet surfaces, SIX records (agent cards are global + staging
// deployments of one source). Every record carries surface, installed/running
// version, source-of-truth version, verdict, evidence.
//
// Invariants (spec D1 + the 2026-08-08 mtime-race lesson):
//   - NO staleness judgment ever reads an mtime — version strings or content
//     digests, always. "Newest" always means version-sorted.
//   - Probes degrade INDIVIDUALLY: one unreachable source of truth degrades
//     that surface to `unknown`, never fails the report. Local hard facts
//     (sidecar mismatch, absent process, running≠frozen) outrank `unknown`;
//     `unknown` means "source of truth unreachable, nothing local to say".
//   - Read-only w.r.t. the fleet surfaces. Doctor's `git fetch` is a
//     source-of-truth refresh (remote-tracking refs + tags in the SOURCE
//     repos), explicitly not a surface mutation. No working tree is touched.
//   - Absent SURFACE (e.g. no process, no staged dir) → `stale` with absence
//     evidence — the repairable state. Absent SOURCE OF TRUTH → `unknown`.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseReleaseIndex, compareReleaseToIndex, type ReleaseIndex } from "@amicode/schema";
import { probeModeRegistry, machineReleaseTag, type ModeComponentRecord, type ModeProbeState } from "./mode_probe.js";

export type Verdict = "current" | "stale" | "integrity-failure" | "unknown";

export const SURFACE_ORDER = [
  "server-binary",
  "extension",
  "vendored-binary",
  "staged-skills",
  "agent-cards-global",
  "agent-cards-staging",
] as const;

export type SurfaceName = (typeof SURFACE_ORDER)[number];

export interface SurfaceRecord {
  surface: SurfaceName;
  /** installed/running version (or set digest for digest-identified surfaces) */
  version: string | null;
  /** source-of-truth version (or set digest) */
  source_version: string | null;
  verdict: Verdict;
  /** digests, version strings, reason codes — at least one line, always */
  evidence: string[];
  /** #804: component-level verdicts riding the agent-cards records (the
   *  doctor extends, never mints): per-mode bundle components judged against
   *  the machine's release tag + registry-level rows (release-compare,
   *  staging-lock, deploy-receipt). Absent on the other surfaces. */
  components?: ModeComponentRecord[];
}

export interface SurfacesReport {
  /** The report contract's version (#804 schema v2) — every report is
   *  stamped; consumers are tolerate-then-warn across the bump. */
  schema_version: "2";
  surfaces: SurfaceRecord[];
}

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Injectable process runner. Never throws — failures are {code != 0}. */
export type Exec = (file: string, args: string[]) => Promise<ExecResult>;

export interface SurfaceContext {
  /** server dir holding bin/opencode + bin/opencode.sha256 (default ~/.amico/server) */
  rootServer: string;
  /** VS Code extensions dir (default ~/.vscode/extensions) */
  rootVscext: string;
  /** opencode config root; global cards at <root>/agents (default ~/.config/opencode) */
  rootConfig: string;
  /** amicode repo checkout (default ~/armonia/repos/amicode) */
  rootRepoAmicode: string;
  /** opencode fork checkout, branch local/amicode (default ~/armonia/repos/opencode) */
  rootRepoFork: string;
  /** staged opencode-project dir (default <rootServer>/opencode-project-staging/opencode-project) */
  rootStaging: string;
  /** running-process evidence stub; null = discover via ps */
  runningBinary: string | null;
  /** vendor platform dir name, e.g. "darwin-arm64" */
  platform: string;
  run: Exec;
  discoverRunning: () => Promise<string | null>;
}

const GIT_TIMEOUT_MS = 30_000;

export const realExec: Exec = (file, args) =>
  new Promise((resolve) => {
    execFile(file, args, { timeout: GIT_TIMEOUT_MS }, (err, stdout, stderr) => {
      const code = err && typeof (err as { code?: number }).code === "number" ? (err as { code: number }).code : err ? 1 : 0;
      resolve({ code, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
    });
  });

/** ps-based live discovery of the running server binary (default; hermetic
 *  fixtures inject --running-binary or their own discoverRunning). */
async function defaultDiscoverRunning(): Promise<string | null> {
  const r = await realExec("ps", ["-axo", "command="]);
  if (r.code !== 0) return null;
  for (const line of r.stdout.split("\n")) {
    if (!/\bopencode serve\b/.test(line)) continue;
    const bin = line.trim().split(/\s+/)[0] ?? "";
    if (bin.includes("opencode")) return bin;
  }
  return null;
}

export function defaultSurfaceContext(): SurfaceContext {
  const rootServer = process.env.AMICO_SERVER_DIR ?? join(homedir(), ".amico", "server");
  return {
    rootServer,
    rootVscext: join(homedir(), ".vscode", "extensions"),
    rootConfig: join(homedir(), ".config", "opencode"),
    rootRepoAmicode: join(homedir(), "armonia", "repos", "amicode"),
    rootRepoFork: join(homedir(), "armonia", "repos", "opencode"),
    rootStaging: join(rootServer, "opencode-project-staging", "opencode-project"),
    runningBinary: null,
    platform: `${process.platform}-${process.arch}`,
    run: realExec,
    discoverRunning: defaultDiscoverRunning,
  };
}

// ── small helpers ────────────────────────────────────────────────────────────

const sha256hex = (buf: Buffer): string => createHash("sha256").update(buf).digest("hex");

async function readFileSafe(p: string): Promise<string | null> {
  try {
    return await readFile(p, "utf8");
  } catch {
    return null;
  }
}

/** sha256 (hex) of a file's bytes, or null when unreadable. Exported for the
 *  upgrade verbs (#526) — they digest the same evidence doctor reads. */
export async function fileSha(p: string): Promise<string | null> {
  try {
    return sha256hex(await readFile(p));
  } catch {
    return null;
  }
}

/** Natural version compare (digits numerically, runs otherwise lexicographically).
 *  Returns <0, 0, >0. Handles "0.2.6", "1.18.10-amicode.15", "v1.18.12". */
export function compareVersions(a: string, b: string): number {
  const tok = (s: string) => s.match(/\d+|[^\d]+/g) ?? [];
  const ta = tok(a);
  const tb = tok(b);
  const n = Math.max(ta.length, tb.length);
  for (let i = 0; i < n; i++) {
    const xa = ta[i];
    const xb = tb[i];
    if (xa === undefined) return -1;
    if (xb === undefined) return 1;
    const da = /^\d+$/.test(xa);
    const db = /^\d+$/.test(xb);
    if (da && db) {
      const va = Number(xa);
      const vb = Number(xb);
      if (va !== vb) return va < vb ? -1 : 1;
    } else if (da !== db) {
      return da ? -1 : 1; // numeric chunks sort before alpha chunks
    } else {
      if (xa !== xb) return xa < xb ? -1 : 1;
    }
  }
  return 0;
}

/** The leading numeric version of a string: "0.2.4-darwin-arm64" → "0.2.4". */
export function versionPrefix(s: string): string {
  return s.match(/\d+(?:\.\d+)*/)?.[0] ?? "";
}

/** Build date embedded in a frozen-binary version string, e.g.
 *  "0.0.0-local/amicode-202608231309" → Date(2026-08-23T13:09Z). Null if absent. */
export function parseBuildDate(version: string): Date | null {
  const m = version.match(/(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(?=\D|$)/);
  if (!m) return null;
  const [y, mo, d, h, mi] = m.slice(1).map(Number);
  if (y < 2000) return null; // a 12-digit run from a year we never built in
  const t = Date.UTC(y, mo - 1, d, h, mi);
  return Number.isNaN(t) ? null : new Date(t);
}

/** Deterministic content digest of a directory: sha256 over the sorted
 *  relative-path + file-bytes pairs. mtime-free by construction. Exported for
 *  the upgrade verbs + their idempotence harness (#526). */
export async function dirDigest(dir: string): Promise<string | null> {
  const files: string[] = [];
  const walk = async (rel: string) => {
    let entries: import("node:fs").Dirent[];
    try {
      entries = await readdir(join(dir, rel), { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const child = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) await walk(child);
      else if (e.isFile()) files.push(child);
    }
  };
  await walk("");
  if (files.length === 0) return null;
  const parts: string[] = [];
  for (const f of files) {
    const bytes = await readFileSafeBuffer(join(dir, f));
    if (bytes === null) return null;
    parts.push(`${f}\0`);
    parts.push(bytes.toString("binary"));
  }
  return sha256hex(Buffer.from(parts.join("\u0001"), "binary"));
}

async function readFileSafeBuffer(p: string): Promise<Buffer | null> {
  try {
    return await readFile(p);
  } catch {
    return null;
  }
}

async function listSubdirs(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return [];
  }
}

async function listFiles(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries.filter((e) => e.isFile()).map((e) => e.name);
  } catch {
    return [];
  }
}

/** Set digest over a name→digest map (sorted names) — the identity of a
 *  digest-identified surface (staged skills, agent cards). */
function setDigest(items: Map<string, string>): string {
  const parts = [...items.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([name, digest]) => `${name}\0${digest}`);
  return sha256hex(Buffer.from(parts.join("\u0001"), "binary"));
}

const firstErrLine = (s: string, max = 200): string =>
  s.split("\n").map((l) => l.trim()).filter(Boolean).join(" ").slice(0, max);

// ── shared source-of-truth refresh ──────────────────────────────────────────

export interface FetchOutcome {
  ok: boolean;
  error?: string;
}

/** `git fetch` in a SOURCE repo — writes remote-tracking refs (+ tags when
 *  asked) only; never touches a working tree. The vendored probe needs tags
 *  (release tags may live off-branch), so the fork fetch passes --tags. */
async function fetchOrigin(run: Exec, repo: string, tags: boolean): Promise<FetchOutcome> {
  const args = ["-C", repo, "fetch", "origin"];
  if (tags) args.push("--tags");
  const r = await run("git", args);
  return r.code === 0
    ? { ok: true }
    : { ok: false, error: firstErrLine(r.stderr || r.stdout) || `exit ${r.code}` };
}

async function gitOutput(run: Exec, repo: string, args: string[]): Promise<string | null> {
  const r = await run("git", ["-C", repo, ...args]);
  return r.code === 0 ? r.stdout : null;
}

// ── extension-dir selection (version-sorted, never mtime) ──────────────────

export interface NewestExtension {
  dir: string;
  /** raw suffix after "harmoniqs.amicode-", e.g. "0.2.4-darwin-arm64" */
  suffix: string;
  /** numeric version prefix, e.g. "0.2.4" */
  version: string;
}

export async function newestExtensionDir(rootVscext: string): Promise<NewestExtension | null> {
  const dirs = await listSubdirs(rootVscext);
  const exts = dirs.filter((d) => /^harmoniqs\.amicode-/.test(d));
  if (exts.length === 0) return null;
  exts.sort((a, b) => {
    const va = versionPrefix(a.replace(/^harmoniqs\.amicode-/, ""));
    const vb = versionPrefix(b.replace(/^harmoniqs\.amicode-/, ""));
    const byVersion = compareVersions(va, vb);
    if (byVersion !== 0) return byVersion;
    return compareVersions(a, b);
  });
  const newest = exts[exts.length - 1];
  const suffix = newest.replace(/^harmoniqs\.amicode-/, "");
  return { dir: join(rootVscext, newest), suffix, version: versionPrefix(suffix) || suffix };
}

// ── the six probes ───────────────────────────────────────────────────────────

async function probeServerBinary(ctx: SurfaceContext, forkFetch: FetchOutcome): Promise<SurfaceRecord> {
  const surface: SurfaceName = "server-binary";
  const frozen = join(ctx.rootServer, "bin", "opencode");
  const sidecarPath = `${frozen}.sha256`;

  const frozenSha = await fileSha(frozen);
  if (frozenSha === null) {
    return { surface, version: null, source_version: null, verdict: "stale", evidence: [`frozen binary missing: ${frozen}`] };
  }

  // integrity: the freeze contract is binary + sidecar pair
  const sidecarText = await readFileSafe(sidecarPath);
  if (sidecarText === null) {
    return { surface, version: null, source_version: null, verdict: "integrity-failure", evidence: [`sidecar missing: ${sidecarPath}`, `frozen sha256 ${frozenSha}`] };
  }
  const sidecarSha = sidecarText.match(/[0-9a-f]{64}/i)?.[0]?.toLowerCase() ?? null;
  if (sidecarSha === null) {
    return { surface, version: null, source_version: null, verdict: "integrity-failure", evidence: [`sidecar unreadable (no sha256 digest found): ${sidecarPath}`, `frozen sha256 ${frozenSha}`] };
  }
  if (sidecarSha !== frozenSha) {
    return { surface, version: null, source_version: null, verdict: "integrity-failure", evidence: [`frozen sha256 ${frozenSha} ≠ sidecar ${sidecarSha} (tampered binary or stale sidecar)`, `sidecar ${sidecarPath}`] };
  }

  const versionRun = await ctx.run(frozen, ["--version"]);
  if (versionRun.code !== 0) {
    return { surface, version: null, source_version: null, verdict: "integrity-failure", evidence: [`frozen binary --version failed (exit ${versionRun.code}): ${firstErrLine(versionRun.stderr)}`, `frozen sha256 ${frozenSha} = sidecar`] };
  }
  const version = versionRun.stdout.trim().split("\n").pop() ?? "";

  // running process (local facts)
  const running = ctx.runningBinary ?? (await ctx.discoverRunning());
  if (!running) {
    return { surface, version, source_version: null, verdict: "stale", evidence: ["server-down: no running opencode serve process found", `frozen ${version} sha256 ${frozenSha} = sidecar`] };
  }
  const runningSha = await fileSha(running);
  if (runningSha === null) {
    return { surface, version, source_version: null, verdict: "stale", evidence: [`running binary unreadable: ${running}`, `frozen ${version} sha256 ${frozenSha} = sidecar`] };
  }
  if (runningSha !== frozenSha) {
    return { surface, version, source_version: null, verdict: "stale", evidence: [`running ${running} sha256 ${runningSha} ≠ frozen sha256 ${frozenSha} (restart pending)`, `frozen ${version} sha256 ${frozenSha} = sidecar`] };
  }

  // version staleness vs the fetched fork HEAD
  if (!forkFetch.ok) {
    return { surface, version, source_version: null, verdict: "unknown", evidence: [`fork fetch failed (source of truth unreachable): ${forkFetch.error}`, `local checks pass: frozen sha = sidecar, running sha = frozen sha`] };
  }
  const headDateRaw = await gitOutput(ctx.run, ctx.rootRepoFork, ["log", "-1", "--format=%cI", "origin/local/amicode"]);
  if (headDateRaw === null) {
    return { surface, version, source_version: null, verdict: "unknown", evidence: ["fetched, but origin/local/amicode not found in the fork", `frozen ${version} sha256 ${frozenSha} = sidecar`] };
  }
  const headDate = new Date(headDateRaw.trim());
  const headSha = (await gitOutput(ctx.run, ctx.rootRepoFork, ["rev-parse", "--short", "origin/local/amicode"]))?.trim() ?? "";
  const buildDate = parseBuildDate(version);
  if (buildDate !== null && headDate.getTime() > 0 && buildDate.getTime() < headDate.getTime()) {
    return {
      surface,
      version,
      source_version: headDateRaw.trim(),
      verdict: "stale",
      evidence: [
        `build date ${buildDate.toISOString()} < HEAD commit date ${headDate.toISOString()} (origin/local/amicode ${headSha})`,
        `frozen ${version} sha256 ${frozenSha} = sidecar; running sha = frozen sha`,
      ],
    };
  }
  return {
    surface,
    version,
    source_version: headDateRaw.trim(),
    verdict: "current",
    evidence: [
      `frozen ${version} sha256 ${frozenSha} = sidecar`,
      `running ${running} sha256 = frozen sha256`,
      `build date ${buildDate ? buildDate.toISOString() : "unparseable"} ≥ HEAD commit date ${headDate.toISOString()} (origin/local/amicode ${headSha})`,
    ],
  };
}

async function probeExtension(ctx: SurfaceContext, amicodeFetch: FetchOutcome): Promise<SurfaceRecord> {
  const surface: SurfaceName = "extension";
  if (!amicodeFetch.ok) {
    return { surface, version: null, source_version: null, verdict: "unknown", evidence: [`amicode fetch failed (source of truth unreachable): ${amicodeFetch.error}`] };
  }
  const pkgRaw = await gitOutput(ctx.run, ctx.rootRepoAmicode, ["show", "origin/main:packages/extension/package.json"]);
  let sourceVersion: string | null = null;
  if (pkgRaw !== null) {
    try {
      sourceVersion = (JSON.parse(pkgRaw) as { version?: string }).version ?? null;
    } catch {
      sourceVersion = null;
    }
  }
  if (pkgRaw === null || sourceVersion === null) {
    return { surface, version: null, source_version: null, verdict: "unknown", evidence: ["origin/main packages/extension/package.json unreadable or has no version"] };
  }
  const newest = await newestExtensionDir(ctx.rootVscext);
  if (newest === null) {
    return { surface, version: null, source_version: sourceVersion, verdict: "stale", evidence: [`no installed extension dir (harmoniqs.amicode-*) under ${ctx.rootVscext}`, `origin/main version ${sourceVersion}`] };
  }
  const cmp = compareVersions(newest.version, sourceVersion);
  const verdict: Verdict = cmp === 0 ? "current" : "stale";
  const direction =
    cmp === 0
      ? `installed ${newest.version} = origin/main ${sourceVersion}`
      : cmp < 0
        ? `installed ${newest.version} behind origin/main ${sourceVersion}`
        : `installed ${newest.version} ahead of origin/main ${sourceVersion} (source repo behind?)`;
  return {
    surface,
    version: newest.suffix,
    source_version: sourceVersion,
    verdict,
    evidence: [`installed ${newest.suffix} — version-sorted newest under ${ctx.rootVscext}`, direction],
  };
}

async function probeVendoredBinary(ctx: SurfaceContext, forkFetch: FetchOutcome): Promise<SurfaceRecord> {
  const surface: SurfaceName = "vendored-binary";
  if (!forkFetch.ok) {
    return { surface, version: null, source_version: null, verdict: "unknown", evidence: [`fork fetch failed (release tags not refreshable): ${forkFetch.error}`] };
  }
  const tagsRaw = await gitOutput(ctx.run, ctx.rootRepoFork, ["tag", "--list"]);
  const releaseTags = (tagsRaw ?? "").split("\n").map((t) => t.trim()).filter(Boolean).filter((t) => /^v\d+\.\d+\.\d+-amicode\.\d+$/.test(t));
  if (releaseTags.length === 0) {
    return { surface, version: null, source_version: null, verdict: "unknown", evidence: ["no fork release tags (v<base>-amicode.<n>) in the fetched fork"] };
  }
  releaseTags.sort((a, b) => compareVersions(a.replace(/^v/, ""), b.replace(/^v/, "")));
  const newestTag = releaseTags[releaseTags.length - 1];
  const baseVersion = newestTag.replace(/^v(\d+\.\d+\.\d+)-amicode\.\d+$/, "$1");

  const bin = join(ctx.rootRepoAmicode, "packages", "extension", "vendor", "opencode", ctx.platform, "opencode");
  const binSha = await fileSha(bin);
  if (binSha === null) {
    return { surface, version: null, source_version: baseVersion, verdict: "stale", evidence: [`vendored binary missing: ${bin}`, `latest fork release tag ${newestTag} (base ${baseVersion})`] };
  }
  const vr = await ctx.run(bin, ["--version"]);
  if (vr.code !== 0) {
    return { surface, version: null, source_version: baseVersion, verdict: "stale", evidence: [`vendored binary --version failed (exit ${vr.code}): ${firstErrLine(vr.stderr)}`, `latest fork release tag ${newestTag} (base ${baseVersion})`] };
  }
  const printed = vr.stdout.trim().split("\n").pop() ?? "";
  const cmp = compareVersions(printed, baseVersion);
  return {
    surface,
    version: printed,
    source_version: baseVersion,
    verdict: cmp === 0 ? "current" : "stale",
    evidence: [
      `vendored ${bin} --version ${printed}`,
      `latest fork release tag ${newestTag} (base ${baseVersion})`,
      cmp === 0 ? `version = release tag base` : cmp < 0 ? `version behind release tag base ${baseVersion}` : `version ahead of release tag base ${baseVersion}`,
    ],
  };
}

async function probeStagedSkills(ctx: SurfaceContext): Promise<SurfaceRecord> {
  const surface: SurfaceName = "staged-skills";
  const newest = await newestExtensionDir(ctx.rootVscext);
  const sourceSkillsDir = newest ? join(newest.dir, "skills") : null;
  const sourceSkills = sourceSkillsDir ? await listSubdirs(sourceSkillsDir) : [];
  if (newest === null || sourceSkills.length === 0) {
    return { surface, version: null, source_version: null, verdict: "unknown", evidence: [`missing local source: no VSIX skills set (no harmoniqs.amicode-* dir with skills/ under ${ctx.rootVscext})`] };
  }
  const stagedDir = join(ctx.rootStaging, "skills");
  const stagedSkills = await listSubdirs(stagedDir);
  if (stagedSkills.length === 0) {
    return { surface, version: null, source_version: null, verdict: "stale", evidence: [`staged skills dir missing or empty: ${stagedDir}`, `source: VSIX ${newest.suffix} skills set (${sourceSkills.length} skills)`] };
  }
  const sourceDigests = new Map<string, string>();
  const stagedDigests = new Map<string, string>();
  const diffs: string[] = [];
  for (const skill of sourceSkills) {
    const src = await dirDigest(join(sourceSkillsDir!, skill));
    const dst = await dirDigest(join(stagedDir, skill));
    if (src === null) continue; // unreadable source skill: not the staged surface's verdict
    sourceDigests.set(skill, src);
    if (dst === null) diffs.push(`skill ${skill} missing from staged set`);
    else {
      stagedDigests.set(skill, dst);
      if (dst !== src) diffs.push(`skill ${skill} changed (staged ${dst.slice(0, 12)} ≠ VSIX ${src.slice(0, 12)})`);
    }
  }
  // reverse direction (reviewer pass 2026-08-23): a skill staged but absent
  // from the VSIX set is drift too — a leftover an older deployment dropped.
  // Extras count toward the staged set digest, so version ≠ source when drifted.
  for (const skill of stagedSkills) {
    if (sourceSkills.includes(skill)) continue;
    const dst = await dirDigest(join(stagedDir, skill));
    if (dst !== null) stagedDigests.set(skill, dst);
    diffs.push(`skill ${skill} extra in staged set (absent from VSIX source set)`);
  }
  const sourceSet = setDigest(sourceDigests);
  const stagedSet = setDigest(stagedDigests);
  if (diffs.length > 0) {
    return { surface, version: `sha256:${stagedSet}`, source_version: `sha256:${sourceSet}`, verdict: "stale", evidence: [...diffs, `source: VSIX ${newest.suffix} skills set`] };
  }
  return {
    surface,
    version: `sha256:${stagedSet}`,
    source_version: `sha256:${sourceSet}`,
    verdict: "current",
    evidence: [`all ${sourceDigests.size} staged skills byte-match the VSIX ${newest.suffix} skills set`, `set digest sha256:${stagedSet}`],
  };
}

async function probeAgentCards(
  ctx: SurfaceContext,
  deployedDir: string,
  surface: "agent-cards-global" | "agent-cards-staging",
  modeProbe?: { state: ModeProbeState; deployedModesDir: string },
): Promise<SurfaceRecord> {
  const srcDir = join(ctx.rootRepoAmicode, "packages", "extension", "agents");
  const sourceCards = (await listFiles(srcDir)).filter((f) => f.endsWith(".md"));
  if (sourceCards.length === 0) {
    return { surface, version: null, source_version: null, verdict: "unknown", evidence: [`missing local source: ${srcDir} absent or has no cards`] };
  }
  const sourceDigests = new Map<string, string>();
  for (const card of sourceCards) {
    const sha = await fileSha(join(srcDir, card));
    if (sha !== null) sourceDigests.set(card, sha);
  }
  const sourceSet = setDigest(sourceDigests);

  const deployedCards = (await listFiles(deployedDir)).filter((f) => f.endsWith(".md"));
  if (deployedCards.length === 0) {
    return { surface, version: null, source_version: `sha256:${sourceSet}`, verdict: "stale", evidence: [`deployed dir missing or empty: ${deployedDir}`, `source: ${sourceDigests.size} cards in ${srcDir}`] };
  }
  const deployedDigests = new Map<string, string>();
  const diffs: string[] = [];
  for (const [card, srcSha] of sourceDigests) {
    const dstSha = await fileSha(join(deployedDir, card));
    if (dstSha === null) diffs.push(`card ${card} missing from ${deployedDir}`);
    else {
      deployedDigests.set(card, dstSha);
      if (dstSha !== srcSha) diffs.push(`card ${card} changed (deployed ${dstSha.slice(0, 12)} ≠ source ${srcSha.slice(0, 12)})`);
    }
  }
  // reverse direction (reviewer pass 2026-08-23): a deployed card absent from
  // the sources is drift — a leftover the next deploy would never refresh.
  // Extras count toward the deployed set digest, so version ≠ source when drifted.
  for (const card of deployedCards) {
    if (sourceCards.includes(card)) continue;
    const dstSha = await fileSha(join(deployedDir, card));
    if (dstSha !== null) deployedDigests.set(card, dstSha);
    diffs.push(`card ${card} extra in deployed set (absent from sources)`);
  }
  const deployedSet = setDigest(deployedDigests);

  // receipt — secondary evidence: the digest diff governs; a missing/lying
  // receipt is itself staleness (no auditable current deployment)
  if (diffs.length > 0) {
    return { surface, version: `sha256:${deployedSet}`, source_version: `sha256:${sourceSet}`, verdict: "stale", evidence: [...diffs, `source: ${srcDir}`] };
  }
  const receiptRaw = await readFileSafe(join(srcDir, ".deploy-receipt.json"));
  if (receiptRaw === null) {
    return { surface, version: `sha256:${deployedSet}`, source_version: `sha256:${sourceSet}`, verdict: "stale", evidence: ["deploy receipt missing (.deploy-receipt.json) — deployment not auditable", `all ${sourceDigests.size} cards byte-match sources`] };
  }
  let receipt: { sources?: { card?: string; sha256?: string }[] } | null = null;
  try {
    receipt = JSON.parse(receiptRaw);
  } catch {
    receipt = null;
  }
  const receiptEntries = receipt?.sources ?? [];
  if (receipt === null || receiptEntries.length === 0) {
    return { surface, version: `sha256:${deployedSet}`, source_version: `sha256:${sourceSet}`, verdict: "stale", evidence: ["deploy receipt unparseable or empty — deployment not auditable", `all ${sourceDigests.size} cards byte-match sources`] };
  }
  const receiptMismatches: string[] = [];
  for (const entry of receiptEntries) {
    if (!entry.card) continue;
    const claimed = (entry.sha256 ?? "").replace(/^sha256:/, "").toLowerCase();
    const actual = sourceDigests.get(entry.card);
    if (actual === undefined) receiptMismatches.push(`receipt names card ${entry.card} absent from sources`);
    else if (claimed !== actual) receiptMismatches.push(`receipt source digest for ${entry.card} ≠ current source (${claimed.slice(0, 12)} ≠ ${actual.slice(0, 12)})`);
  }
  if (receiptMismatches.length > 0) {
    return { surface, version: `sha256:${deployedSet}`, source_version: `sha256:${sourceSet}`, verdict: "stale", evidence: [...receiptMismatches, `all cards byte-match sources, but the receipt records different sources`] };
  }
  const record: SurfaceRecord = {
    surface,
    version: `sha256:${deployedSet}`,
    source_version: `sha256:${sourceSet}`,
    verdict: "current",
    evidence: [`all ${sourceDigests.size} cards byte-match sources (${deployedDir})`, `deploy receipt source digests match current sources`, `set digest sha256:${deployedSet}`],
  };
  // #804 — the mode-bundle component probe EXTENDS this record: the deployed
  // bundles are judged against the machine's RELEASE TAG (never this
  // checkout, never origin HEAD), the release compare against the fetched
  // index. Component verdicts only ever constrain the record DOWNWARD
  // (current → unknown/stale); a record already stale/integrity-failed on
  // card digests keeps its stronger local fact.
  if (modeProbe !== undefined) {
    const probe = await probeModeRegistry(modeProbe.state, modeProbe.deployedModesDir);
    record.components = probe.components;
    record.evidence.push(...probe.evidence);
    if (probe.recordVerdict === "unknown") {
      if (record.verdict === "current") record.verdict = "unknown";
    } else if (probe.recordVerdict === "stale") {
      if (record.verdict === "current" || record.verdict === "unknown") record.verdict = "stale";
    }
  }
  return record;
}

// ── the inventory ────────────────────────────────────────────────────────────

async function guarded(name: SurfaceName, fn: () => Promise<SurfaceRecord>): Promise<SurfaceRecord> {
  try {
    return await fn();
  } catch (e) {
    // probes degrade individually — never a failed report
    return { surface: name, version: null, source_version: null, verdict: "unknown", evidence: [`probe error: ${e instanceof Error ? e.message : String(e)}`] };
  }
}

export async function surfaceInventory(partial: Partial<SurfaceContext> = {}): Promise<SurfacesReport> {
  const ctx: SurfaceContext = { ...defaultSurfaceContext(), ...partial };
  // source-of-truth refresh: one fetch per source repo, shared by its probes.
  // #804: the amicode fetch now carries TAGS — the mode-registry byte
  // authority is the machine's RELEASE TAG (never origin HEAD), and the
  // release index is read at origin/main.
  const forkFetch = await fetchOrigin(ctx.run, ctx.rootRepoFork, true); // tags: release tags
  const amicodeFetch = await fetchOrigin(ctx.run, ctx.rootRepoAmicode, true);
  const surfaces: SurfaceRecord[] = [];
  surfaces.push(await guarded("server-binary", () => probeServerBinary(ctx, forkFetch)));
  surfaces.push(await guarded("extension", () => probeExtension(ctx, amicodeFetch)));
  surfaces.push(await guarded("vendored-binary", () => probeVendoredBinary(ctx, forkFetch)));
  surfaces.push(await guarded("staged-skills", () => probeStagedSkills(ctx)));

  // #804: the mode-registry probe state, resolved ONCE and shared by both
  // agent-cards records — the machine's release tag (from its newest
  // installed extension dir) and the fetched release index. A fetch failure
  // or an unreadable index is a NAMED unknown, never a verdict.
  const newest = await newestExtensionDir(ctx.rootVscext);
  const installedVersion = newest?.version ?? null;
  const machineTag = machineReleaseTag(installedVersion);
  let release: ModeProbeState["release"];
  if (!amicodeFetch.ok) {
    release = { status: "unknown", render: `amicode fetch failed — release index not refreshable: ${amicodeFetch.error}` };
  } else {
    const raw = await gitOutput(ctx.run, ctx.rootRepoAmicode, ["show", "origin/main:packages/extension/modes/release-index.toml"]);
    if (raw === null) {
      release = { status: "unknown", render: "no release index at origin/main (packages/extension/modes/release-index.toml) — registry revision unknown" };
    } else {
      try {
        const index: ReleaseIndex = parseReleaseIndex(raw);
        release = compareReleaseToIndex(installedVersion ?? "", index);
      } catch (e) {
        release = { status: "unknown", render: `release index unparseable — registry revision unknown: ${(e as Error).message}` };
      }
    }
  }
  const modeState: ModeProbeState = {
    machineTag,
    installedVersion,
    release,
    run: ctx.run,
    rootRepoAmicode: ctx.rootRepoAmicode,
    tagBytes: new Map<string, string | null>(),
  };
  surfaces.push(await guarded("agent-cards-global", () => probeAgentCards(ctx, join(ctx.rootConfig, "agents"), "agent-cards-global", { state: modeState, deployedModesDir: join(ctx.rootConfig, "modes") })));
  surfaces.push(await guarded("agent-cards-staging", () => probeAgentCards(ctx, join(ctx.rootStaging, ".opencode", "agents"), "agent-cards-staging", { state: modeState, deployedModesDir: join(ctx.rootStaging, ".opencode", "modes") })));
  return { schema_version: "2", surfaces };
}

// ── rendering + canonical JSON ───────────────────────────────────────────────

/** Canonical JSON: deep-sorted keys, 2-space indent, trailing newline — the
 *  same contract as the vault-card slice's canonicalJson. */
export function canonicalJson(value: unknown): string {
  return `${JSON.stringify(sortDeep(value), null, 2)}\n`;
}

function sortDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .sort()
        .map((k) => [k, sortDeep((value as Record<string, unknown>)[k])]),
    );
  }
  return value;
}

/** The human table appended to doctor v1's binding report. */
export function renderSurfacesTable(surfaces: SurfaceRecord[]): string {
  const width = Math.max(...surfaces.map((s) => s.surface.length));
  const lines = surfaces.map((s) => {
    const v = s.version ?? "—";
    const sv = s.source_version ?? "—";
    return `  ${s.surface.padEnd(width)}  ${String(v).padEnd(44)}  ${String(sv).padEnd(44)}  ${s.verdict}`;
  });
  return `surfaces:\n${lines.join("\n")}`;
}
