// fleet_scripts_projection.test.ts — #1106 (P3b-2, spec §8 F1's installer +
// guard legs): the two bash consumers of fleet topology read the PROJECTION
// (the verb-refreshed cache / the verb's machine-parseable output) — never the
// raw fleet config. These tests exec the REAL scripts with a fabricated
// $HOME and a fake `amico` CLI on the child PATH, replaying the same
// absent / broken / bootstrap / client / standalone topology cases the
// extension's fleet_topology tests drive — the triple-consumer replay's
// script legs.
//
// The fake `amico` faithfully emulates the verb contract (#1106): exit 0 →
// print the JSON line AND refresh the cache at $HOME/.amico/ops/fleet/
// projection.json; exit 75 → bootstrap, cache untouched; any other exit →
// failure, cache untouched.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO = join(__dirname, "..", "..", "..");
const GUARD = join(REPO, "tools", "fleet", "amico-opencode-fleet-guard");
const INSTALL = join(REPO, "tools", "fleet", "install.sh");

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "fleet-scripts-"));
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

const EPOCH_A = "44444444-4444-4444-8444-444444444444";

/** A full lawful client projection — the committed fixture's shape. */
const CLIENT_PROJECTION = JSON.stringify({
  schema_version: 1,
  contract_version: 1,
  publisher: { identity: "fleet_authority", published_at: "2026-09-13T12:00:00Z" },
  freshness: { counter: 4, hub_epoch: EPOCH_A },
  sections: {
    mode: { value: "fleet", provenance: { source: "fleet config", parsed_from: "role='client' (vocabulary mapping)" } },
    posture: { value: "ok", provenance: { source: "fleet-status.json" } },
    topology: {
      value: {
        role: "client",
        canonical: { host: "hq-hub-01.example.internal", port: 4096, sshAlias: "hq-hub-01" },
      },
      provenance: { source: "fleet config", parsed_from: "topology schema v1 fields" },
    },
  },
}, null, 2);

/** A lawful standalone projection — no topology section (the base default). */
const STANDALONE_PROJECTION = JSON.stringify({
  schema_version: 1,
  contract_version: 1,
  publisher: { identity: "fleet_authority", published_at: "2026-09-13T12:00:00Z" },
  freshness: { counter: 1, hub_epoch: EPOCH_A },
  sections: { mode: { value: "standalone", provenance: { source: "base default" } } },
}, null, 2);

/** A future-contract projection — unusable to a v1 consumer. */
const FUTURE_PROJECTION = JSON.stringify({
  schema_version: 1,
  contract_version: 2,
  sections: {},
}, null, 2);

/** A server-role projection (the hub machine itself spawns). */
const SERVER_PROJECTION = JSON.stringify({
  schema_version: 1,
  contract_version: 1,
  publisher: { identity: "fleet_authority", published_at: "2026-09-13T12:00:00Z" },
  freshness: { counter: 2, hub_epoch: EPOCH_A },
  sections: {
    mode: { value: "fleet", provenance: { source: "fleet config", parsed_from: "role='server' (vocabulary mapping)" } },
    topology: {
      value: { role: "server", canonical: { host: "hq-hub-01", port: 4096, sshAlias: "hq-hub-01" } },
      provenance: { source: "fleet config" },
    },
  },
}, null, 2);

/** The verb's machine-parseable JSON stdout (commit 1's additive fields). */
function verbJson(role?: string, canonical?: Record<string, unknown>): string {
  return JSON.stringify({
    verb: "fleet", subcommand: "status", projection: true, ok: true,
    mode: role === "client" ? "fleet" : "standalone",
    posture: "ok",
    ...(role === undefined ? {} : { role }),
    ...(canonical === undefined ? {} : { canonical }),
    cache_path: `${tmp}/.amico/ops/fleet/projection.json`,
  });
}

/** The fake `amico` — emulates the #1106 verb contract on the child PATH. */
function fakeAmico(behavior: { code: number; stdout: string; cacheContent?: string }): void {
  const bin = join(tmp, "fakebin");
  mkdirSync(bin, { recursive: true });
  const lines = ["#!/usr/bin/env bash", "set -u"];
  if (behavior.cacheContent !== undefined) {
    lines.push(
      `mkdir -p "$HOME/.amico/ops/fleet"`,
      `cat > "$HOME/.amico/ops/fleet/projection.json" << 'AMICO_FAKE_EOF'`,
      behavior.cacheContent,
      "AMICO_FAKE_EOF",
    );
  }
  lines.push(`cat << 'AMICO_STDOUT_EOF'`, behavior.stdout, "AMICO_STDOUT_EOF", `exit ${behavior.code}`);
  writeFileSync(join(bin, "amico"), lines.join("\n") + "\n");
  chmodSync(join(bin, "amico"), 0o755);
}

function writeCache(content: string): void {
  const dir = join(tmp, ".amico", "ops", "fleet");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "projection.json"), content);
}

/** A fake frozen opencode binary the guard can exec. */
function fakeFrozenBinary(): void {
  const dir = join(tmp, ".amico", "server", "bin");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "opencode"), "#!/usr/bin/env bash\necho FROZEN-EXEC \"$@\"\n");
  chmodSync(join(dir, "opencode"), 0o755);
}

function runScript(script: string, args: string[], opts: { path?: string } = {}): { code: number; out: string } {
  const env: Record<string, string> = {
    HOME: tmp,
    PATH: opts.path ?? `${join(tmp, "fakebin")}:/usr/bin:/bin`,
  };
  // The guard/installer must never find the REAL machine's amico or node-installed fleet state.
  delete env.AMICISSIMO_ROOT;
  const r = spawnSync("bash", [script, ...args], { env, encoding: "utf8", timeout: 60_000 });
  return { code: r.status ?? -1, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

/** A launcher-less fake repo — the CLI-absent branch is only reachable when
 *  the repo's own launchers are absent too (the dev checkout ships them). */
function fakeRepoInstall(): string {
  const repo = join(tmp, "fake-repo");
  mkdirSync(join(repo, "tools", "fleet"), { recursive: true });
  for (const f of ["install.sh", "amico-opencode-fleet-guard", "co.harmoniqs.amico-tunnel.plist"]) {
    writeFileSync(join(repo, "tools", "fleet", f), readFileSync(join(REPO, "tools", "fleet", f), "utf8"));
  }
  return join(repo, "tools", "fleet", "install.sh");
}

// ── the guard: projection cache first, verb refresh on absent/unusable ─────────

describe("the guard reads the projection cache (never the raw file)", () => {
  it("client projection → exit 1, refusing to spawn (the silent-fork countermeasure holds)", () => {
    writeCache(CLIENT_PROJECTION);
    const r = runScript(GUARD, []);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/refusing to spawn/);
  });

  it("server projection → spawns (execs the frozen binary)", () => {
    writeCache(SERVER_PROJECTION);
    fakeFrozenBinary();
    const r = runScript(GUARD, []);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/FROZEN-EXEC/);
  });

  it("standalone projection (no topology section) → spawns — the base default is honestly carried", () => {
    writeCache(STANDALONE_PROJECTION);
    fakeFrozenBinary();
    const r = runScript(GUARD, []);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/FROZEN-EXEC/);
  });

  it("stale-but-lawful projection (same counter re-published) still refuses on client — staleness never flips the role", () => {
    writeCache(CLIENT_PROJECTION);
    fakeFrozenBinary();
    const r = runScript(GUARD, []);
    expect(r.code).toBe(1);
  });

  it("absent cache + verb exit 0 (refreshes the cache) → the refreshed role refuses on client", () => {
    fakeAmico({ code: 0, stdout: verbJson("client", { host: "hq", port: 4096, sshAlias: "hq" }), cacheContent: CLIENT_PROJECTION });
    const r = runScript(GUARD, []);
    expect(existsSync(join(tmp, ".amico", "ops", "fleet", "projection.json"))).toBe(true); // the verb refreshed it
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/refusing to spawn/);
  });

  it("absent cache + verb exit 75 → the bootstrap exception: base-standalone STATED with the grant pointer, then spawns", () => {
    fakeAmico({ code: 75, stdout: "fleet status: base-standalone (bootstrap exception) — grant path: ~/.amico/amicode/entitlements.toml" });
    fakeFrozenBinary();
    const r = runScript(GUARD, []);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/FROZEN-EXEC/); // base-standalone spawns locally
    expect(r.out).toMatch(/base-standalone \(bootstrap exception/);
    expect(r.out).toMatch(/entitlements\.toml|amicissimo/); // the pointer
  });

  it("absent cache + CLI absent → the IDENTICAL bootstrap branch (stated + pointer, then spawns)", () => {
    fakeFrozenBinary();
    const r = runScript(GUARD, [], { path: "/usr/bin:/bin" }); // no fakebin — no amico anywhere
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/FROZEN-EXEC/);
    expect(r.out).toMatch(/base-standalone \(bootstrap exception/);
    expect(r.out).toMatch(/amico CLI is absent/);
  });

  it("unusable cache (future contract) + verb failure → FAILS CLOSED with the honest repair message — never a silent fork", () => {
    writeCache(FUTURE_PROJECTION);
    fakeAmico({ code: 64, stdout: "the publisher failed" });
    fakeFrozenBinary();
    const r = runScript(GUARD, []);
    expect(r.code).toBe(1); // fail closed — a client must never fork on an unreadable topology
    expect(r.out).not.toMatch(/FROZEN-EXEC/);
    expect(r.out).toMatch(/cannot be trusted/);
    expect(r.out).toMatch(/amico fleet status --projection/);
  });

  it("verb exit 0 but the cache it wrote is unusable → fails closed (never trusts an unparseable artifact)", () => {
    fakeAmico({ code: 0, stdout: "{}", cacheContent: "{ corrupt" });
    fakeFrozenBinary();
    const r = runScript(GUARD, []);
    expect(r.code).toBe(1);
    expect(r.out).not.toMatch(/FROZEN-EXEC/);
  });

  it("no projection, no CLI, no opencode binary → the honest no-binary failure (unchanged base behavior)", () => {
    const r = runScript(GUARD, [], { path: "/usr/bin:/bin" });
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/no opencode binary found/);
  });
});

// ── the installer: the verb's machine-parseable output ─────────────────────────

describe("the installer consumes the verb (never greps the raw file)", () => {
  // The installer's settings section needs node; reuse the ambient PATH but
  // with the fake amico FIRST (it shadows any real one).
  const installEnv = (): { path: string } => ({
    path: `${join(tmp, "fakebin")}:${process.env.PATH ?? ""}`,
  });

  it("verb exit 0 + role standalone → the standalone branch: checks skipped, exit 0", () => {
    fakeAmico({ code: 0, stdout: verbJson() }); // no role field → the base default
    const r = runScript(INSTALL, ["--check"], installEnv());
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/standalone/);
    expect(r.out).toMatch(/fleet checks skipped|nothing to install/);
  });

  it("verb exit 0 + role client → the fleet branch with the parsed port (proceeds past the topology gate)", () => {
    fakeAmico({ code: 0, stdout: verbJson("client", { host: "hq", port: 4096, sshAlias: "hq" }) });
    const r = runScript(INSTALL, ["--check"], installEnv());
    // The BRANCH proof: the parsed role + port flowed through — never the standalone skip.
    expect(r.out).toMatch(/fleet role: client \(port: 4096\)/);
    expect(r.out).not.toMatch(/fleet checks skipped|nothing to install/);
    // The terminal outcome is platform-specific BY DESIGN: on darwin, --check
    // fails on the missing installed guard; on non-darwin the installer skips
    // the host check ("the fleet is a darwin fleet") and completes green.
    if (process.platform === "darwin") {
      expect(r.code).toBe(1);
      expect(r.out).toMatch(/guard not installed/);
    } else {
      expect(r.code).toBe(0);
      expect(r.out).toMatch(/host check skipped/);
    }
  });

  it("verb exit 0 + role server (no sshAlias) → guard+settings, NO tunnel, never dies on the missing alias (ADR 0023)", () => {
    // A base-tier server projection carries role=server + canonical WITHOUT an
    // sshAlias (a hub is the tunnel's destination, not its client). The installer
    // must NOT die demanding an alias, and must install no self-tunnel.
    fakeAmico({ code: 0, stdout: verbJson("server", { host: "jj@100.77.141.50", port: 4096 }) });
    const r = runScript(INSTALL, [], installEnv()); // install mode (not --check)
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/fleet role: server \(port: 4096\)/);
    expect(r.out).toMatch(/no managed tunnel/);
    expect(r.out).not.toMatch(/no sshAlias in the fleet topology/); // the die we scoped out
  });

  it("verb exit 75 → the bootstrap exception: base-standalone STATED with the pointer, exit 0 (identical to CLI-absent)", () => {
    fakeAmico({ code: 75, stdout: "fleet status: base-standalone (bootstrap exception)" });
    const r = runScript(INSTALL, ["--check"], installEnv());
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/base-standalone/);
    expect(r.out).toMatch(/entitlements\.toml|amicissimo|grant/i);
  });

  it("CLI absent → the IDENTICAL bootstrap branch (stated, exit 0 — the solo floor is untouched)", () => {
    const r = runScript(fakeRepoInstall(), ["--check"], { path: "/usr/bin:/bin" });
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/base-standalone/);
    expect(r.out).toMatch(/amico CLI is absent/);
  });

  it("verb failure (non-75) → dies honestly, never a silent raw-file fallthrough", () => {
    fakeAmico({ code: 64, stdout: "publisher exploded" });
    const r = runScript(INSTALL, ["--check"], installEnv());
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/fleet-authority verb failed|refusing to guess/);
    expect(r.out).not.toMatch(/standalone mode — nothing to install/); // not the standalone branch
  });

  it("the verb's stdout is unparseable JSON → dies honestly (machine-parseable is a contract)", () => {
    fakeAmico({ code: 0, stdout: "this is not json" });
    const r = runScript(INSTALL, ["--check"], installEnv());
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/parse|machine|verb/i);
  });

  it("the verb run leaves the projection cache refreshed (the consumers' cache convention is kept warm by the installer)", () => {
    fakeAmico({ code: 0, stdout: verbJson("client", { host: "hq", port: 4096, sshAlias: "hq" }), cacheContent: CLIENT_PROJECTION });
    runScript(INSTALL, ["--check"], installEnv());
    expect(readFileSync(join(tmp, ".amico", "ops", "fleet", "projection.json"), "utf8").trim()).toBe(CLIENT_PROJECTION);
  });
});

// ── both copies ship byte-identical (the VSIX's packaged copy is the installer users run) ──

describe("the packaged fleet scripts stay in sync with the repo copies", () => {
  it("guard + installer: packages/extension/tools/fleet copies are byte-identical", () => {
    for (const f of ["amico-opencode-fleet-guard", "install.sh"]) {
      const pkg = join(REPO, "packages", "extension", "tools", "fleet", f);
      expect(existsSync(pkg)).toBe(true);
      expect(readFileSync(pkg, "utf8")).toBe(readFileSync(join(REPO, "tools", "fleet", f), "utf8"));
    }
  });
});
