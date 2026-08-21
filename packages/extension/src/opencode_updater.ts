// AMICODE (#451, M4): the canonical-opencode runtime updater.
//
// Manages a canonical `anomalyco/opencode` install at
// ~/.amico/opencode/canonical/ (env-redirectable for tests):
//
//   canonical/
//     versions/<v>/opencode      — one dir per adopted release
//     current -> versions/<v>    — atomically swapped symlink (the managed binary)
//     probe-plugin.ts            — the adopt-gate plugin-registration probe
//     .probe-stamp.json          — written by the plugin's module load (the assert)
//
// THE ADOPT GATE (spec invariants — a candidate failing ANY stage is never
// adopted; last-known-good is never deleted):
//   1. sha256 of the downloaded asset vs the GitHub release-asset `digest`
//      (digest ABSENCE refuses adoption — never verify-less).
//   2. `--version` prints the candidate version.
//   3. boot smoke: `serve` on an ephemeral loopback port, isolated HOME +
//      OPENCODE_DB + OPENCODE_CONFIG_DIR, health-polled with the per-boot
//      password — AND the plugin-registration assert rides the same boot:
//      OPENCODE_CONFIG_CONTENT registers the stamp plugin, and the gate
//      waits for the stamp file (module-load proof on a STOCK binary — the
//      M0 probe validated this mechanism against real v1.18.19).
//   4. DB-compat probe (when a live DB path is given): a consistent copy via
//      the sqlite backup API (never a mid-write file copy — spec), then the
//      same boot smoke against the copy. A schema the candidate cannot open
//      fails the gate.
//   5. Atomic adoption: version dir installed via same-fs rename; `current`
//      re-pointed via symlink + rename (atomic on POSIX). Old versions pruned
//      to the newest TWO (current + rollback) — LKG always survives.
//
// vscode-free on purpose; fetch/clock/spawn seams are injectable for tests.
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readlinkSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";

export const CANONICAL_REPO = "anomalyco/opencode";

export function managedRoot(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.AMICODE_MANAGED_OPENCODE_DIR;
  if (override && override.trim() !== "") return override;
  return path.join(homedir(), ".amico", "opencode", "canonical");
}

export interface ReleaseCandidate {
  version: string;
  tag: string;
  assetName: string;
  assetUrl: string;
  /** `sha256:<hex>` from the GitHub API — absent digests REFUSE adoption. */
  digest?: string;
  size?: number;
}

export interface CheckResult {
  kind: "current" | "update";
  current?: string;
  candidate?: ReleaseCandidate;
}

export type FetchLike = (url: string, init?: { headers?: Record<string, string> }) => Promise<{
  ok: boolean;
  status: number;
  json?: () => Promise<unknown>;
  arrayBuffer?: () => Promise<ArrayBuffer>;
}>;

/** a.b.c compare; tag prefixes (v) ignored. Returns true when a > b. */
export function isNewer(a: string, b: string): boolean {
  const norm = (v: string) =>
    v
      .replace(/^v/i, "")
      .split(/[.\-+]/)
      .map((s) => Number.parseInt(s, 10));
  const av = norm(a);
  const bv = norm(b);
  for (let i = 0; i < Math.max(av.length, bv.length); i++) {
    const d = (av[i] ?? 0) - (bv[i] ?? 0);
    if (d !== 0) return d > 0;
  }
  return false;
}

function platformAsset(): { name: string; platforms: readonly string[] } {
  const key = `${process.platform}-${process.arch}`;
  const byPlatform: Record<string, { name: string; platforms: readonly string[] }> = {
    "darwin-arm64": { name: "opencode-darwin-arm64.zip", platforms: ["darwin-arm64"] },
    "linux-x64": { name: "opencode-linux-x64.tar.gz", platforms: ["linux-x64"] },
    "linux-arm64": { name: "opencode-linux-arm64.tar.gz", platforms: ["linux-arm64"] },
  };
  const hit = byPlatform[key];
  if (!hit) throw new Error(`updater: no canonical asset mapping for ${key}`);
  return hit;
}

/** The version the `current` symlink resolves to, or undefined. */
export function currentVersion(root: string = managedRoot()): string | undefined {
  try {
    const link = readlinkSync(path.join(root, "current"));
    return path.basename(link);
  } catch {
    return undefined;
  }
}

export function managedBinary(root: string = managedRoot()): string | undefined {
  const bin = path.join(root, "current", "opencode");
  return existsSync(bin) ? bin : undefined;
}

/** Check the GitHub releases API. Never throws: fetch errors read as "current"
 *  (stay on last-known-good — silence, never a broken adopt). */
export async function checkForUpdate(
  opts: { current?: string; repo?: string; fetchImpl?: FetchLike; root?: string } = {},
): Promise<CheckResult> {
  const repo = opts.repo ?? CANONICAL_REPO;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const current = opts.current ?? currentVersion(opts.root ?? managedRoot());
  try {
    const r = await fetchImpl(`https://api.github.com/repos/${repo}/releases/latest`, {
      headers: { Accept: "application/vnd.github+json" },
    });
    if (!r.ok || !r.json) return { kind: "current", current };
    const rel = (await r.json()) as {
      tag_name?: string;
      assets?: { name: string; digest?: string; size?: number; browser_download_url?: string }[];
    };
    const tag = rel.tag_name ?? "";
    const version = tag.replace(/^v/, "");
    if (!version) return { kind: "current", current };
    if (current && !isNewer(version, current)) return { kind: "current", current };
    const want = platformAsset().name;
    const asset = (rel.assets ?? []).find((a) => a.name === want);
    if (!asset) return { kind: "current", current };
    return {
      kind: "update",
      current,
      candidate: {
        version,
        tag,
        assetName: asset.name,
        assetUrl: asset.browser_download_url ?? `https://github.com/${repo}/releases/download/${tag}/${asset.name}`,
        digest: asset.digest,
        size: asset.size,
      },
    };
  } catch {
    return { kind: "current", current };
  }
}

const sha256 = (buf: Buffer) => createHash("sha256").update(buf).digest("hex");

const STAMP_PLUGIN = `// amicode updater adopt-gate probe (#451): module-load proof on a stock
// canonical binary. Written by the updater; its stamp file is the assert.
import * as fs from "node:fs";
try { fs.writeFileSync(STAMP_PATH, JSON.stringify({ at: new Date().toISOString() })); } catch {}
export default () => ({ tools: {} });
`;

function writeStampPlugin(root: string): { pluginPath: string; stampPath: string } {
  const pluginPath = path.join(root, "probe-plugin.ts");
  const stampPath = path.join(root, ".probe-stamp.json");
  writeFileSync(pluginPath, STAMP_PLUGIN.replace("STAMP_PATH", JSON.stringify(stampPath)));
  return { pluginPath, stampPath };
}

export interface AdoptOptions {
  candidate: ReleaseCandidate;
  root?: string;
  fetchImpl?: FetchLike;
  log?: { appendLine(line: string): void };
  /** Live chat DB for the compat probe; when given, a consistent copy (sqlite
   *  backup API) is booted against as the gate's final stage. */
  liveDbPath?: string;
  /** Injectable boot prober for tests (default: real serve + health poll +
   *  plugin-stamp assert + optional DB-copy boot). */
  probeBoot?: (bin: string, env: Record<string, string>) => Promise<void>;
  /** Gate stage timeouts (default 30s boot health, 10s stamp). */
  bootTimeoutMs?: number;
}

export interface AdoptResult {
  ok: boolean;
  version?: string;
  binary?: string;
  error?: string;
}

/**
 * Download, verify, gate, and atomically adopt a release candidate. Returns
 * {ok:false, error} on any gate failure — `current` is untouched and
 * last-known-good survives by construction.
 */
export async function adoptRelease(opts: AdoptOptions): Promise<AdoptResult> {
  const root = opts.root ?? managedRoot();
  const fetchImpl = opts.fetchImpl ?? fetch;
  const log = opts.log ?? { appendLine: () => undefined };
  const fail = (error: string): AdoptResult => {
    log.appendLine(`[updater] adopt REFUSED (${opts.candidate.version}): ${error}`);
    return { ok: false, error };
  };

  // Stage 0 — the digest itself is a gate (spec: absence refuses adoption).
  const digest = opts.candidate.digest;
  if (!digest || !/^sha256:[0-9a-f]{64}$/i.test(digest)) {
    return fail(`release asset carries no sha256 digest (${opts.candidate.assetName}) — refusing verify-less adoption`);
  }
  const want = digest.replace(/^sha256:/i, "").toLowerCase();

  // Stage 1 — download + verify.
  let bytes: Buffer;
  try {
    const r = await fetchImpl(opts.candidate.assetUrl);
    if (!r.ok || !r.arrayBuffer) throw new Error(`HTTP ${r.status}`);
    bytes = Buffer.from(await r.arrayBuffer());
  } catch (e) {
    return fail(`download failed: ${e instanceof Error ? e.message : String(e)}`);
  }
  const got = sha256(bytes);
  if (got !== want) {
    // Supply-chain signal: no retry, no override.
    return fail(`sha256 mismatch: expected ${want}, got ${got}`);
  }

  // Stage 2 — extract into a staging dir on the same fs.
  mkdirSync(path.join(root, "versions"), { recursive: true });
  const versionDir = path.join(root, "versions", opts.candidate.version);
  if (existsSync(versionDir)) rmSync(versionDir, { recursive: true, force: true });
  const stage = mkdtempSync(path.join(root, "versions", `.stage-`));
  try {
    const archive = path.join(stage, opts.candidate.assetName);
    writeFileSync(archive, bytes);
    if (archive.endsWith(".zip")) spawnSync("unzip", ["-oq", archive, "-d", stage]);
    else spawnSync("tar", ["-xzf", archive, "-C", stage]);
    const bin = findBinary(stage);
    if (!bin) return fail(`archive contains no opencode binary`);
    chmodSync(bin, 0o755);
    renameSync(bin, path.join(stage, "opencode"));

    const stagedBin = path.join(stage, "opencode");

    // Stage 3 — `--version` prints the candidate version.
    const ver = spawnSync(stagedBin, ["--version"], { encoding: "utf8" });
    if (ver.status !== 0 || !ver.stdout.trim().includes(opts.candidate.version)) {
      return fail(`--version probe: ${JSON.stringify(ver.stdout.trim().slice(0, 120))}`);
    }

    // Stage 4 — boot smoke + plugin-registration assert, then (when a live DB
    // is given) the DB-compat probe against a CONSISTENT COPY of it.
    const { pluginPath, stampPath } = writeStampPlugin(root);
    try {
      rmSync(stampPath, { force: true });
    } catch {
      /* absent stamp is the normal case */
    }
    const isolatedHome = mkdtempSync(path.join(tmpdir(), "updater-probe-"));
    const bootTimeoutMs = opts.bootTimeoutMs ?? 30_000;
    const runProbe = async (dbPath?: string): Promise<void> => {
      const env: Record<string, string> = {
        AMICODE_UPDATER_PROBE_HOME: isolatedHome,
        AMICODE_UPDATER_PROBE_PLUGIN: pluginPath,
        ...(dbPath ? { AMICODE_UPDATER_PROBE_DB: dbPath } : {}),
      };
      // Fresh assert per probe: the DB-copy boot must prove ITS plugin load,
      // not ride on the fresh boot's stamp.
      try {
        rmSync(stampPath, { force: true });
      } catch {
        /* absent is fine */
      }
      if (opts.probeBoot) {
        await opts.probeBoot(stagedBin, env);
        return;
      }
      await defaultProbeBoot(stagedBin, env, { stampPath, bootTimeoutMs, log, dbPath });
    };
    try {
      await runProbe(); // fresh-DB boot smoke + plugin assert
      if (opts.liveDbPath && existsSync(opts.liveDbPath)) {
        const copy = consistentDbCopy(opts.liveDbPath, isolatedHome);
        if (copy) {
          await runProbe(copy); // same gate, against the live DB's copy
        } else {
          log.appendLine(
            "[updater] DB probe SKIPPED: sqlite3 unavailable for a consistent copy (boot smoke still ran)",
          );
        }
      }
    } finally {
      rmSync(isolatedHome, { recursive: true, force: true });
    }

    // Stage 5 — atomic adopt: rename staged dir into versions/<v>, swap the
    // symlink (symlink to temp name + rename over the old link = atomic).
    renameSync(stage, versionDir);
    const linkTmp = path.join(root, `.current-${randomBytes(4).toString("hex")}`);
    symlinkSync(path.join("versions", opts.candidate.version), linkTmp);
    renameSync(linkTmp, path.join(root, "current"));
    pruneVersions(root, log);
    const binary = path.join(root, "current", "opencode");
    log.appendLine(`[updater] adopted ${opts.candidate.version} → ${binary}`);
    return { ok: true, version: opts.candidate.version, binary };
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e));
  } finally {
    rmSync(stage, { recursive: true, force: true }); // no-op after successful rename
  }
}

function findBinary(dir: string): string | undefined {
  // Archives may nest (opencode-darwin-arm64/opencode) — depth-first search.
  const entries = readdirSync(dir, { withFileTypes: true });
  for (const e of entries) {
    if (e.name.startsWith(".")) continue;
    const p = path.join(dir, e.name);
    if (e.isFile() && e.name === "opencode") return p;
    if (e.isDirectory()) {
      const nested = findBinary(p);
      if (nested) return nested;
    }
  }
  return undefined;
}

/** Real boot smoke: serve on an ephemeral port with the per-boot password, the
 *  stamp plugin registered, isolated HOME/DB/config dir; poll `/` (authed) for
 *  health, then wait for the plugin stamp (the registration assert). Throws on
 *  any miss — the caller refuses adoption. */
async function defaultProbeBoot(
  bin: string,
  env: Record<string, string>,
  opts: { stampPath: string; bootTimeoutMs: number; log: { appendLine(l: string): void }; dbPath?: string },
): Promise<void> {
  const password = randomBytes(24).toString("base64url");
  const home = env.AMICODE_UPDATER_PROBE_HOME;
  const plugin = env.AMICODE_UPDATER_PROBE_PLUGIN;
  const port = 4800 + Math.floor(Math.random() * 400);
  const child = spawn(bin, ["serve", "--port", String(port), "--hostname", "127.0.0.1"], {
    env: {
      ...process.env,
      HOME: home,
      OPENCODE_DB: opts.dbPath ?? path.join(home, "probe.db"),
      OPENCODE_CONFIG_DIR: path.join(home, "config"),
      OPENCODE_SERVER_PASSWORD: password,
      OPENCODE_CONFIG_CONTENT: JSON.stringify({ plugin: [plugin] }),
    },
    stdio: ["ignore", "ignore", "ignore"],
  });
  const auth = "Basic " + Buffer.from(`opencode:${password}`).toString("base64");
  try {
    const deadline = Date.now() + opts.bootTimeoutMs;
    let healthy = false;
    while (Date.now() < deadline && !healthy) {
      if (child.exitCode !== null) throw new Error(`probe server exited early (code ${child.exitCode})`);
      try {
        const r = await fetch(`http://127.0.0.1:${port}/`, { headers: { Authorization: auth } });
        if (r.status === 200) healthy = true;
      } catch {
        await new Promise((r) => setTimeout(r, 250));
      }
    }
    if (!healthy) throw new Error(`probe server did not become healthy within ${opts.bootTimeoutMs}ms`);
    // Force instance bootstrap: in this build `serve` starts the HTTP layer
    // eagerly but creates the instance (and therefore loads config plugins)
    // lazily, on the first instance-bearing request. /config is the lightest
    // trigger — without it the stamp never appears (found via the live drill).
    const cfgDeadline = Date.now() + opts.bootTimeoutMs;
    let booted = false;
    while (Date.now() < cfgDeadline && !booted) {
      try {
        const r = await fetch(`http://127.0.0.1:${port}/config`, { headers: { Authorization: auth } });
        if (r.status === 200) booted = true;
      } catch {
        await new Promise((r) => setTimeout(r, 250));
      }
    }
    if (!booted) throw new Error("probe server never served /config (instance bootstrap stalled)");
    // plugin-registration assert: the stamp appears at plugin module load — the
    // first boot may bun-install plugin deps into the config dir (~8s observed
    // on the live drill), so the window is the full boot timeout.
    const stampDeadline = Date.now() + opts.bootTimeoutMs;
    while (Date.now() < stampDeadline && !existsSync(opts.stampPath)) {
      await new Promise((r) => setTimeout(r, 200));
    }
    if (!existsSync(opts.stampPath)) throw new Error("plugin-registration assert failed (stamp never appeared)");
  } finally {
    child.kill("SIGTERM");
  }
}

/** Consistent copy via the sqlite backup API — NEVER a mid-write file copy
 *  (spec invariant). Returns undefined when sqlite3 is unavailable (probe
 *  degrades with a logged note, never silently verifies-less on the OTHER
 *  stages). */
export function consistentDbCopy(src: string, destDir: string): string | undefined {
  try {
    const dest = path.join(destDir, `db-copy-${Date.now()}.db`);
    const r = spawnSync("sqlite3", [src, `.backup '${dest}'`], { encoding: "utf8" });
    if (r.status !== 0 || !existsSync(dest)) return undefined;
    return dest;
  } catch {
    return undefined;
  }
}

/** Keep the newest two version dirs (current + rollback); older ones go. */
function pruneVersions(root: string, log: { appendLine(l: string): void }): void {
  const dir = path.join(root, "versions");
  let entries: string[];
  try {
    entries = readdirSync(dir).filter((e) => !e.startsWith("."));
  } catch {
    return;
  }
  if (entries.length <= 2) return;
  const withMtime = entries.map((e) => ({ e, m: statMs(path.join(dir, e)) })).sort((a, b) => b.m - a.m);
  for (const { e } of withMtime.slice(2)) {
    rmSync(path.join(dir, e), { recursive: true, force: true });
    log.appendLine(`[updater] pruned old version ${e}`);
  }
}

function statMs(p: string): number {
  try {
    return statSync(p).mtimeMs;
  } catch {
    return 0;
  }
}
