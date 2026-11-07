// `amico vault status` — sync-sidecar health (amicode#2033; amicissimo#357 mechanism M3).
//
// The sync loop (scripts/armonia-sync-once) writes one JSON record per mount under
// $AMICO_OPS_ROOT/sync-status/<resolved-path-key>.json. These tests seed such records
// directly (the writer's schema is the contract) and drive the BUILT bundle, like the
// status test in vault_verb.test.ts. The founding incident: a mount sat 565 cycles
// failing while `vault status` printed `warnings: []`.
import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const BUNDLE = join(__dirname, "..", "dist", "amico.js");
beforeAll(() => {
  execFileSync("node", [join(__dirname, "..", "esbuild.config.mjs")], { cwd: join(__dirname, "..") });
});

let root: string; // AMICO_VAULTS_ROOT
let ops: string; // AMICO_OPS_ROOT
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "amico-sync-vaults-"));
  ops = mkdtempSync(join(tmpdir(), "amico-sync-ops-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(ops, { recursive: true, force: true });
});

type Mount = { id: string; kind: string; writable: boolean; warnings: string[]; sync?: Record<string, unknown> };

function status(): Mount[] {
  const stdout = execFileSync("node", [BUNDLE, "vault", "status", "--json"], {
    encoding: "utf8",
    env: { ...process.env, AMICO_VAULTS_ROOT: root, AMICO_OPS_ROOT: ops, AMICO_MOUNTS_TOML: join(root, "no-such.toml"), AMICO_VAULT_DIR: "" },
  });
  return JSON.parse(stdout).mounts;
}

/** A git-backed mount with a marker. `git init` only — no remote needed. */
function seedMount(name: string, kind: string): string {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, ".amico-vault.toml"), `kind = "${kind}"\nname = "${name}"\n`);
  execFileSync("git", ["-C", dir, "init", "-q"]);
  return dir;
}

/** Mirror of the sync loop's record key: realpath, strip leading "/", "/" → "_". */
function recordKey(dir: string): string {
  return realpathSync(dir).replace(/^\/+|\/+$/g, "").replace(/\//g, "_");
}

function ago(minutes: number): string {
  const d = new Date(Date.now() - minutes * 60_000);
  const p = (n: number) => String(n).padStart(2, "0");
  // the writer's format: %Y-%m-%dT%H:%M:%S%z  → local-time, "+0000"-style offset
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? "+" : "-";
  const tz = `${sign}${p(Math.floor(Math.abs(off) / 60))}${p(Math.abs(off) % 60)}`;
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}${tz}`;
}

function writeRecord(dir: string, over: Record<string, unknown> = {}): void {
  mkdirSync(join(ops, "sync-status"), { recursive: true });
  const rec = {
    display_name: dir.split("/").pop(),
    kind: "team",
    path: realpathSync(dir),
    last_success: ago(2),
    last_failure: null,
    failure_reason: null,
    consecutive_failures: 0,
    behind_count: 0,
    fetch_blocked: false,
    threshold: 50,
    cadence_minutes: 15,
    updated: ago(2),
    ...over,
  };
  writeFileSync(join(ops, "sync-status", `${recordKey(dir)}.json`), JSON.stringify(rec));
}

const byId = (ms: Mount[], id: string): Mount => ms.find((m) => m.id === id)!;

describe("amico vault status — sync-sidecar health (#2033)", () => {
  it("consecutive failures → STALE, with reason/failures/behind exposed and a matching warning", () => {
    const d = seedMount("armonissima", "team");
    writeRecord(d, { last_success: ago(8000), last_failure: ago(1), failure_reason: "You are not currently on a branch.", consecutive_failures: 565, behind_count: 32 });
    const m = byId(status(), "armonissima");
    expect(m.sync).toMatchObject({ state: "STALE", consecutive_failures: 565, behind_count: 32, failure_reason: "You are not currently on a branch." });
    expect(m.warnings.join(" ")).toMatch(/STALE/);
    expect(m.warnings.join(" ")).toMatch(/565/);
    expect(m.warnings.join(" ")).toMatch(/not currently on a branch/);
  });

  it("behind past the record's threshold, or a blocked fetch, is STALE even with zero failures", () => {
    const a = seedMount("far-behind", "team");
    writeRecord(a, { behind_count: 51 });
    const b = seedMount("fetch-blocked", "team");
    writeRecord(b, { fetch_blocked: true, behind_count: null });
    const ms = status();
    expect(byId(ms, "far-behind").sync).toMatchObject({ state: "STALE" });
    expect(byId(ms, "fetch-blocked").sync).toMatchObject({ state: "STALE" });
    expect(byId(ms, "fetch-blocked").warnings.join(" ")).toMatch(/STALE/);
  });

  it("a git-backed mount with NO record is UNKNOWN (silence is reportable); a non-git mount has no sync state", () => {
    seedMount("never-synced", "team");
    const plain = join(root, "plain");
    mkdirSync(plain, { recursive: true });
    writeFileSync(join(plain, ".amico-vault.toml"), 'kind = "team"\nname = "plain"\n');
    const ms = status();
    expect(byId(ms, "never-synced").sync).toMatchObject({ state: "UNKNOWN" });
    expect(byId(ms, "never-synced").warnings.join(" ")).toMatch(/UNKNOWN/);
    expect(byId(ms, "plain").sync).toBeUndefined();
    expect(byId(ms, "plain").warnings).toEqual([]);
  });

  it("a record older than 3× cadence is ZOMBIE even when its last round succeeded", () => {
    const d = seedMount("dead-scheduler", "team");
    writeRecord(d, { last_success: ago(3 * 15 + 30), consecutive_failures: 0 });
    const m = byId(status(), "dead-scheduler");
    expect(m.sync).toMatchObject({ state: "ZOMBIE" });
    expect(m.warnings.join(" ")).toMatch(/ZOMBIE/);
  });

  it("a non-writable personal mount that is failing is ro-by-policy (muted) while a failing writable mount in the SAME run is STALE", () => {
    if (process.getuid && process.getuid() === 0) return; // root ignores mode bits; the mute is untestable as root
    const ro = seedMount("served-ro", "personal");
    writeRecord(ro, { kind: "personal", consecutive_failures: 3, failure_reason: "push rejected", last_failure: ago(1) });
    chmodSync(ro, 0o555);
    const rw = seedMount("really-broken", "personal");
    writeRecord(rw, { kind: "personal", consecutive_failures: 3, failure_reason: "pull conflict", last_failure: ago(1) });
    try {
      const ms = status();
      expect(byId(ms, "served-ro").sync).toMatchObject({ state: "ro-by-policy" });
      expect(byId(ms, "served-ro").warnings).toEqual([]); // muted: expected, non-actionable
      expect(byId(ms, "really-broken").sync).toMatchObject({ state: "STALE" }); // the mute must not swallow real staleness
      expect(byId(ms, "really-broken").warnings.join(" ")).toMatch(/STALE/);
    } finally {
      chmodSync(ro, 0o755); // let afterEach remove it
    }
  });

  it("matches records by RESOLVED path: a symlinked vaults root still finds its record", () => {
    const real = mkdtempSync(join(tmpdir(), "amico-sync-real-"));
    try {
      const d = join(real, "linked");
      mkdirSync(d, { recursive: true });
      writeFileSync(join(d, ".amico-vault.toml"), 'kind = "team"\nname = "linked"\n');
      execFileSync("git", ["-C", d, "init", "-q"]);
      writeRecord(d, { consecutive_failures: 7, failure_reason: "boom", last_failure: ago(1) });
      symlinkSync(d, join(root, "linked")); // root/linked -> real/linked (record key is the RESOLVED path)
      const ms = status();
      const m = byId(ms, "linked");
      expect(m.sync).toMatchObject({ state: "STALE", consecutive_failures: 7 });
      expect(ms.filter((x) => x.id === "linked")).toHaveLength(1);
    } finally {
      rmSync(real, { recursive: true, force: true });
    }
  });

  it("a healthy mount is OK with unchanged warnings; every pre-existing field keeps its shape", () => {
    const d = seedMount("healthy", "team");
    writeRecord(d);
    const m = byId(status(), "healthy");
    expect(m.sync).toMatchObject({ state: "OK", consecutive_failures: 0 });
    expect(m.warnings).toEqual([]);
    expect(Object.keys(m).sort()).toEqual(["id", "kind", "last_sync", "path", "sync", "warnings", "writable"]);
  });

  it("absent / empty / malformed records never throw: exit 0, git mounts degrade to UNKNOWN", () => {
    const d = seedMount("corrupt-rec", "team");
    mkdirSync(join(ops, "sync-status"), { recursive: true });
    writeFileSync(join(ops, "sync-status", `${recordKey(d)}.json`), "{not json");
    writeFileSync(join(ops, "sync-status", "garbage.json"), "");
    expect(() => status()).not.toThrow();
    expect(byId(status(), "corrupt-rec").sync).toMatchObject({ state: "UNKNOWN" });

    rmSync(join(ops, "sync-status"), { recursive: true, force: true }); // directory entirely absent
    expect(() => status()).not.toThrow();
    expect(byId(status(), "corrupt-rec").sync).toMatchObject({ state: "UNKNOWN" });
  });
});
