// Live adopt drill (#451, M4) — the REAL gate against the REAL release:
// network download, sha256 vs the API digest, extraction, --version probe,
// boot smoke with the stamp plugin (real serve, real health poll), and — when
// a live DB is given — the consistent-copy DB-compat probe. Timings recorded
// for the adopt-lag accounting.
//
//   node scripts/updater_live_drill.mts [--db <live.db>] [--root <managed-root>]
//
// Defaults: root = a fresh temp dir (the drill never touches the real managed
// install), db = the real chat DB when it exists. Exit 0 = gate passed and
// adopted; nonzero = refused (the error IS the finding).
import { mkdtempSync, rmSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { adoptRelease, checkForUpdate, currentVersion } from "../src/opencode_updater.ts";

const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};

const log = {
  appendLine(l: string) {
    console.log(l);
  },
};

const t0 = Date.now();
const mark = (label: string) => console.log(`[drill] ${label} at +${((Date.now() - t0) / 1000).toFixed(1)}s`);

const root = flag("root") ?? mkdtempSync(join(tmpdir(), "updater-drill-"));
const dbArg = flag("db");
const defaultDb = join(process.env.HOME ?? "", ".local", "share", "opencode", "opencode.db");
const liveDb = dbArg === "none" ? undefined : dbArg ?? (existsSync(defaultDb) ? defaultDb : undefined);

mark(`start (root=${root}, liveDb=${liveDb ? `${(statSync(liveDb).size / 1e6).toFixed(0)}MB` : "none"})`);

const check = await checkForUpdate({ root });
mark(`check: ${check.kind}${check.candidate ? ` → ${check.candidate.version} (${check.candidate.digest})` : ` (current=${check.current ?? "none"})`}`);
if (check.kind !== "update") {
  console.log(`[drill] nothing to adopt (current=${check.current ?? "none"}) — adopting anyway to exercise the gate`);
  if (!check.current) {
    console.error("[drill] no current install and no candidate — aborting");
    process.exit(1);
  }
}

const candidate = check.candidate ?? {
  version: currentVersion(root) ?? "0.0.0",
  tag: "drill",
  assetName: "opencode-darwin-arm64.zip",
  assetUrl: `https://github.com/anomalyco/opencode/releases/download/v${currentVersion(root)}/opencode-darwin-arm64.zip`,
  digest: undefined as unknown as string,
};
// Re-check to get a real candidate when the install root already held it.
const recheck = await checkForUpdate({ root, current: "0.0.0" });
const real = recheck.kind === "update" ? recheck.candidate! : candidate;

mark(`downloading ${real.assetUrl}`);
const result = await adoptRelease({ candidate: real, root, log, liveDbPath: liveDb });
mark(`gate finished: ${result.ok ? `ADOPTED ${result.version}` : `REFUSED — ${result.error}`}`);

if (liveDb) mark(`db-copy probe used the real ${liveDb}`);
if (!flag("root")) rmSync(root, { recursive: true, force: true });
console.log(`[drill] total wall: ${((Date.now() - t0) / 1000).toFixed(1)}s`);
process.exit(result.ok ? 0 : 2);
