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
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkPeerForwards } from "../src/fleet_health";

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

/** #1261 (AC4): shadow `uname` on the child PATH so the installer's per-OS
 *  branches (the settings path, the darwin-only tunnel) can be exercised
 *  deterministically regardless of the test runner's real OS. */
function fakeUname(os: string): void {
  const bin = join(tmp, "fakebin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, "uname"), `#!/usr/bin/env bash\necho ${os}\n`);
  chmodSync(join(bin, "uname"), 0o755);
}

/** #1258: shadow launchctl + systemctl on the child PATH with no-op shims so
 *  the installer's best-effort load/enable of the hub-service unit NEVER
 *  touches the real OS service manager. The test asserts the WRITTEN unit, not
 *  the OS loader (per #1258: "don't fake OS-level launchctl/systemctl calls in
 *  a unit test") — this keeps the server write-path hermetic, exactly as
 *  fakeUname/fakeAmico shadow their binaries. */
function fakeLoaders(): void {
  const bin = join(tmp, "fakebin");
  mkdirSync(bin, { recursive: true });
  for (const name of ["launchctl", "systemctl"]) {
    writeFileSync(join(bin, name), "#!/usr/bin/env bash\nexit 0\n");
    chmodSync(join(bin, name), 0o755);
  }
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

/** #1775: NO run in this file may reach the real OS service manager — the
 *  installer writes launch agents and (re)loads them, and a real `launchctl
 *  load` of a fabricated plist would start a real ssh agent on the test host.
 *  Every run gets TWO recording stubs:
 *   - the SEAM: `$AMICO_FLEET_LAUNCHCTL` → `<tmp>/stubs/launchctl` (OFF the
 *     PATH), appending one argv line per call to `<tmp>/launchctl.argv`;
 *   - the BACKSTOP: a `launchctl` + `systemctl` FIRST on the child PATH that
 *     append to `<tmp>/launchctl-path.argv` — reached only if the installer
 *     ever bypasses its seam (a test asserts it never does).
 *  `launchctl getenv <VAR>` prints `<tmp>/stubs/getenv-<VAR>` when present. */
function writeLoaderStubs(): void {
  const stubs = join(tmp, "stubs");
  const bin = join(tmp, "fakebin");
  mkdirSync(stubs, { recursive: true });
  mkdirSync(bin, { recursive: true });
  const recorder = (log: string): string => [
    "#!/usr/bin/env bash",
    `printf '%s\\n' "$*" >> "${log}"`,
    `if [[ "\${1:-}" == "getenv" && -f "${stubs}/getenv-\${2:-}" ]]; then cat "${stubs}/getenv-\${2:-}"; fi`,
    "exit 0",
    "",
  ].join("\n");
  writeFileSync(join(stubs, "launchctl"), recorder(join(tmp, "launchctl.argv")));
  chmodSync(join(stubs, "launchctl"), 0o755);
  for (const name of ["launchctl", "systemctl"]) {
    writeFileSync(join(bin, name), recorder(join(tmp, "launchctl-path.argv")));
    chmodSync(join(bin, name), 0o755);
  }
}

/** The seam stub's recorded argv lines (empty when it was never called). */
function launchctlCalls(): string[] {
  const log = join(tmp, "launchctl.argv");
  return existsSync(log) ? readFileSync(log, "utf8").split("\n").filter((l) => l !== "") : [];
}

/** Calls that bypassed the seam and hit the PATH backstop (must stay empty). */
function backstopCalls(): string[] {
  const log = join(tmp, "launchctl-path.argv");
  return existsSync(log) ? readFileSync(log, "utf8").split("\n").filter((l) => l !== "") : [];
}

function runScript(script: string, args: string[], opts: { path?: string } = {}): { code: number; out: string } {
  writeLoaderStubs();
  const env: Record<string, string> = {
    HOME: tmp,
    PATH: opts.path ?? `${join(tmp, "fakebin")}:/usr/bin:/bin`,
    AMICO_FLEET_LAUNCHCTL: join(tmp, "stubs", "launchctl"),
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
    // #1261 (AC4): the guard backstop is cross-platform now — a client with no
    // installed guard fails --check on EVERY OS (was: "host check skipped" on
    // non-darwin). Unified: exit 1, "guard not installed".
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/guard not installed/);
    expect(r.out).not.toMatch(/host check skipped/);
  });

  it("verb exit 0 + role server (no sshAlias) → guard+settings, NO tunnel, never dies on the missing alias (ADR 0023)", () => {
    // A base-tier server projection carries role=server + canonical WITHOUT an
    // sshAlias (a hub is the tunnel's destination, not its client). The installer
    // must NOT die demanding an alias, and must install no self-tunnel.
    fakeAmico({ code: 0, stdout: verbJson("server", { host: "user@100.64.0.1", port: 4096 }) });
    fakeLoaders(); // #1258: the server write-path now provisions a hub service — shadow the OS loaders
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

// ── #1261 AC4: enrollment writes the platform-correct VS Code settings path ───
describe("the installer writes the platform-correct settings path (#1261 AC4)", () => {
  const installEnv = (): { path: string } => ({
    path: `${join(tmp, "fakebin")}:${process.env.PATH ?? ""}`,
  });

  it("on LINUX, enrollment writes ~/.config/Code/User/settings.json with the guard binary + port", () => {
    fakeAmico({ code: 0, stdout: verbJson("client", { host: "hq", port: 4096, sshAlias: "hq" }) });
    fakeUname("Linux"); // exercise the linux branch regardless of the runner's OS
    const r = runScript(INSTALL, [], installEnv()); // write mode
    expect(r.code).toBe(0);
    const settingsPath = join(tmp, ".config", "Code", "User", "settings.json");
    expect(existsSync(settingsPath)).toBe(true);
    const j = JSON.parse(readFileSync(settingsPath, "utf8")) as Record<string, unknown>;
    expect(String(j["amicode.opencodeBinary"])).toMatch(/amico-opencode-fleet-guard$/);
    expect(j["amicode.opencodePort"]).toBe(4096);
    // the darwin Application Support path is NOT used on linux
    expect(existsSync(join(tmp, "Library", "Application Support", "Code", "User", "settings.json"))).toBe(false);
  });

  it("on LINUX with a VS Code server present, ALSO writes the Remote-WSL server-side Machine settings", () => {
    fakeAmico({ code: 0, stdout: verbJson("client", { host: "hq", port: 4096, sshAlias: "hq" }) });
    fakeUname("Linux");
    mkdirSync(join(tmp, ".vscode-server"), { recursive: true }); // a Remote-WSL/SSH server is present
    const r = runScript(INSTALL, [], installEnv());
    expect(r.code).toBe(0);
    expect(existsSync(join(tmp, ".config", "Code", "User", "settings.json"))).toBe(true);
    expect(existsSync(join(tmp, ".vscode-server", "data", "Machine", "settings.json"))).toBe(true);
  });

  it("on macOS, enrollment writes the Application Support path (unchanged)", () => {
    fakeAmico({ code: 0, stdout: verbJson("client", { host: "hq", port: 4096, sshAlias: "hq" }) });
    fakeUname("Darwin");
    const r = runScript(INSTALL, [], installEnv());
    expect(r.code).toBe(0);
    expect(existsSync(join(tmp, "Library", "Application Support", "Code", "User", "settings.json"))).toBe(true);
    // #1775: the tunnel (re)load went through the launchctl SEAM — never the
    // PATH's launchctl (on a real host that would start a real ssh agent).
    const tunnel = join(tmp, "Library", "LaunchAgents", "co.harmoniqs.amico-tunnel.plist");
    expect(launchctlCalls()).toContain(`load ${tunnel}`);
    expect(backstopCalls()).toEqual([]);
  });

  it("--check on LINUX catches settings drift (the check twin runs cross-platform, never 'skipped (not darwin)')", () => {
    // Guard installed + in sync, but the settings are missing → --check must FAIL.
    fakeAmico({ code: 0, stdout: verbJson("client", { host: "hq", port: 4096, sshAlias: "hq" }) });
    fakeUname("Linux");
    // install the guard so the guard check passes and we reach the settings check
    mkdirSync(join(tmp, ".local", "bin"), { recursive: true });
    writeFileSync(join(tmp, ".local", "bin", "amico-opencode-fleet-guard"), readFileSync(GUARD, "utf8"));
    chmodSync(join(tmp, ".local", "bin", "amico-opencode-fleet-guard"), 0o755);
    const r = runScript(INSTALL, ["--check"], installEnv());
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/settings.*(missing|not set)|opencodeBinary/i);
    expect(r.out).not.toMatch(/skipped \(not darwin\)/);
  });
});

// ── #1258: the canonical hub gets a reboot-surviving service unit (server only) ──
// The Studio's canonical hub must survive a REBOOT with NO editor opened.
// Today the hub is the extension-spawned detached server (ADR 0020) — survives
// a window close, dies on reboot. The installer provisions the EXISTING #955
// headless runner (bin/dist/amicode-service-runner.mjs) under launchd (macOS) /
// systemd-user (Linux) with RunAtLoad+KeepAlive — NOT a bespoke `opencode serve`
// wrapper. One canonical DB / ONE writer (ADR 0005): the unit runs the SAME
// runner the editor adopts, pinned to the canonical OPENCODE_DB. A CLIENT never
// gets it (never-fork). The role gate rides the ONE topology reader (ADR 0023):
// the SAME parsed projection role that decides guard/settings/tunnel decides this.
const HUB_RUNNER_BUNDLE = join(REPO, "packages", "extension", "bin", "dist", "amicode-service-runner.mjs");
describe.skipIf(!existsSync(HUB_RUNNER_BUNDLE))("#1258 the installer provisions the canonical hub service (reboot-survival)", () => {
  const installEnv = (): { path: string } => ({
    path: `${join(tmp, "fakebin")}:${process.env.PATH ?? ""}`,
  });

  it("on macOS, a SERVER gets the launchd hub-service unit — RunAtLoad+KeepAlive, runs the #955 runner (never `opencode serve`), pins OPENCODE_DB", () => {
    fakeAmico({ code: 0, stdout: verbJson("server", { host: "hq", port: 4096 }) });
    fakeUname("Darwin");
    fakeLoaders();
    const r = runScript(INSTALL, [], installEnv());
    expect(r.code).toBe(0);
    // the decision rode the ONE topology reader (ADR 0023): parsed role=server.
    expect(r.out).toMatch(/fleet role: server/);
    const plist = join(tmp, "Library", "LaunchAgents", "co.harmoniqs.amico-hub.plist");
    expect(existsSync(plist)).toBe(true);
    const content = readFileSync(plist, "utf8");
    expect(content).toMatch(/<key>RunAtLoad<\/key>\s*<true\/>/); // boots on reboot, no editor needed
    expect(content).toMatch(/<key>KeepAlive<\/key>\s*<true\/>/); // stays up (auto-restart)
    expect(content).toContain("amicode-service-runner.mjs"); // the #955 runner…
    expect(content).not.toContain("opencode serve"); // …NOT the withdrawn bespoke wrapper
    expect(content).toContain("<key>OPENCODE_DB</key>"); // one writer (ADR 0005)
    expect(content).toContain("/.amico/server/session.db");
    expect(content).toContain("<key>AMICODE_SERVICE_PORT</key>");
    expect(content).toContain("<string>4096</string>"); // the canonical fleet port
  });

  it("on LINUX, a SERVER gets the systemd-user hub-service unit — WantedBy+Restart=always, ExecStart runs the #955 runner, pins OPENCODE_DB", () => {
    fakeAmico({ code: 0, stdout: verbJson("server", { host: "hq", port: 4096 }) });
    fakeUname("Linux");
    fakeLoaders();
    const r = runScript(INSTALL, [], installEnv());
    expect(r.code).toBe(0);
    const unit = join(tmp, ".config", "systemd", "user", "amico-hub.service");
    expect(existsSync(unit)).toBe(true);
    const content = readFileSync(unit, "utf8");
    expect(content).toMatch(/WantedBy=/); // enable → start at boot (RunAtLoad ≙)
    expect(content).toContain("Restart=always"); // KeepAlive ≙
    expect(content).toMatch(/ExecStart=.*amicode-service-runner\.mjs/); // the #955 runner…
    expect(content).not.toContain("opencode serve"); // …NOT the withdrawn bespoke wrapper
    expect(content).toContain("Environment=OPENCODE_DB="); // one writer (ADR 0005)
    expect(content).toContain("/.amico/server/session.db");
    expect(content).toContain("Environment=AMICODE_SERVICE_PORT=4096");
    // #1354 follow-up: the hub engine is pinned off the extension engine and runs
    // unarmed so open-auth /global/health works through the tunnel.
    expect(content).toContain("Environment=AMICODE_ENGINE_PORT=4093");
    expect(content).toContain("Environment=AMICODE_ENGINE_UNARMED=1");
  });

  it("never-fork: a CLIENT gets NO hub-service unit — this is the HUB's provisioning, not a client's (role-gated, ADR 0005)", () => {
    fakeAmico({ code: 0, stdout: verbJson("client", { host: "hq", port: 4096, sshAlias: "hq" }) });
    fakeUname("Linux"); // a linux client wires no darwin tunnel + no hub service — hermetic
    fakeLoaders();
    const r = runScript(INSTALL, [], installEnv());
    expect(r.code).toBe(0);
    expect(existsSync(join(tmp, ".config", "systemd", "user", "amico-hub.service"))).toBe(false);
    expect(existsSync(join(tmp, "Library", "LaunchAgents", "co.harmoniqs.amico-hub.plist"))).toBe(false);
  });

  it("--check on a SERVER catches a missing/absent hub-service unit (the reboot-survival drift twin)", () => {
    fakeAmico({ code: 0, stdout: verbJson("server", { host: "hq", port: 4096 }) });
    fakeUname("Darwin");
    fakeLoaders();
    // guard installed + in sync AND settings correct so --check reaches the hub-service check
    const guardDst = join(tmp, ".local", "bin", "amico-opencode-fleet-guard");
    mkdirSync(join(tmp, ".local", "bin"), { recursive: true });
    writeFileSync(guardDst, readFileSync(GUARD, "utf8"));
    chmodSync(guardDst, 0o755);
    const settings = join(tmp, "Library", "Application Support", "Code", "User", "settings.json");
    mkdirSync(join(tmp, "Library", "Application Support", "Code", "User"), { recursive: true });
    // #1354 follow-up: server role uses FLEET_PORT - 2 for the engine port (app
    // shelf gets FLEET_PORT - 1, hub service keeps FLEET_PORT) and no guard binary
    writeFileSync(settings, JSON.stringify({ "amicode.opencodePort": 4094 }, null, 2));
    const r = runScript(INSTALL, ["--check"], installEnv());
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/hub service/i);
  });
});

// ── both copies ship byte-identical (the VSIX's packaged copy is the installer users run) ──
describe("the packaged fleet scripts stay in sync with the repo copies", () => {
  it("guard + installer + launchd templates: packages/extension/tools/fleet copies are byte-identical", () => {
    for (const f of ["amico-opencode-fleet-guard", "install.sh", "co.harmoniqs.amico-tunnel.plist", "co.harmoniqs.amico-peer-forward.plist"]) {
      const pkg = join(REPO, "packages", "extension", "tools", "fleet", f);
      expect(existsSync(pkg)).toBe(true);
      expect(readFileSync(pkg, "utf8")).toBe(readFileSync(join(REPO, "tools", "fleet", f), "utf8"));
    }
  });
});

// ── #1775: installer-managed per-peer SSH forwards ─────────────────────────────
// The SSH forward a machine uses to reach a PEER's hub was a hand-installed
// launch agent with stale 30/3 keepalives. The installer now generates one
// agent per attached peer — label from the peer's machine id, local port from
// the peer token store's loopback base URL, remote port = the fleet's canonical
// hub port, ssh destination = the peer's roster sshAlias (else its machine id).
// Every run is hermetic: temp HOME, the launchctl seam stub, the PATH backstop.
const PEER_STORE_REL = [".amico", "fleet-peer-tokens-reader.json"];
const peerForwardPlist = (id: string): string => join(tmp, "Library", "LaunchAgents", `co.harmoniqs.amico-peer-${id}-forward.plist`);

/** The reader peer-token store (#1438) — { store_version, peers: { id: { base_url, token } } }. */
function writePeerStore(peers: Record<string, string>): void {
  mkdirSync(join(tmp, ".amico"), { recursive: true });
  const doc = { store_version: 1, peers: Object.fromEntries(Object.entries(peers).map(([id, baseUrl]) => [id, { base_url: baseUrl, token: `tok-${id}` }])) };
  writeFileSync(join(tmp, ...PEER_STORE_REL), JSON.stringify(doc, null, 2));
}

/** The fleet roster cache — the peer's sshAlias lives on its row. */
function writeRoster(rows: Array<{ machine_id: string; sshAlias: string }>): void {
  const dir = join(tmp, ".amico", "ops", "fleet");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "roster.json"), JSON.stringify({ schema_version: 1, rows: rows.map((r) => ({ ...r, transport: "ssh", server_mode: "server" })) }, null, 2));
}

/** A launchd plist's Label + ProgramArguments, read straight from the XML. */
function readAgent(file: string): { label: string; args: string[] } {
  const xml = readFileSync(file, "utf8");
  const label = /<key>Label<\/key>\s*<string>([^<]*)<\/string>/.exec(xml)?.[1] ?? "";
  const array = /<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(xml)?.[1] ?? "";
  const args = [...array.matchAll(/<string>([^<]*)<\/string>/g)].map((m) => m[1]);
  return { label, args };
}

/** The standard forward argv (fleet_transport's options) for one peer. */
const standardForward = (localPort: number, remotePort: number, alias: string): string[] => [
  "/usr/bin/ssh", "-N",
  "-o", "ExitOnForwardFailure=yes",
  "-o", "ServerAliveInterval=15",
  "-o", "ServerAliveCountMax=2",
  "-o", "TCPKeepAlive=yes",
  "-o", "BatchMode=yes",
  "-L", `127.0.0.1:${localPort}:127.0.0.1:${remotePort}`,
  alias,
];

describe("#1775 the installer generates one SSH forward agent per attached peer", () => {
  const installEnv = (): { path: string } => ({
    path: `${join(tmp, "fakebin")}:${process.env.PATH ?? ""}`,
  });
  const verbFor = (role: string): string =>
    role === "standalone" ? verbJson() : verbJson(role, { host: "hq", port: 4096, sshAlias: "hq" });

  it.each(["server", "client", "standalone"])(
    "a %s attached to a peer gets that peer's forward agent — 15 s keepalive, 2 misses, TCPKeepAlive, ExitOnForwardFailure, the store's local port; a re-run is idempotent",
    (role) => {
      fakeAmico({ code: 0, stdout: verbFor(role) });
      fakeUname("Darwin");
      writePeerStore({ "jjs-mac-studio": "http://127.0.0.1:45096" });
      writeRoster([{ machine_id: "jjs-mac-studio", sshAlias: "studio-ssh" }]);

      const r = runScript(INSTALL, [], installEnv());
      expect(r.code, r.out).toBe(0);
      const plist = peerForwardPlist("jjs-mac-studio");
      expect(existsSync(plist), r.out).toBe(true);
      const agent = readAgent(plist);
      expect(agent.label).toBe("co.harmoniqs.amico-peer-jjs-mac-studio-forward");
      expect(agent.args).toEqual(standardForward(45096, 4096, "studio-ssh"));
      expect(readFileSync(plist, "utf8")).toMatch(/<key>KeepAlive<\/key>\s*<true\/>/);
      expect(launchctlCalls()).toContain(`load ${plist}`);

      // Re-run: byte-identical agent, no reload, still exactly one forward agent.
      const first = readFileSync(plist, "utf8");
      rmSync(join(tmp, "launchctl.argv"), { force: true });
      const again = runScript(INSTALL, [], installEnv());
      expect(again.code, again.out).toBe(0);
      expect(readFileSync(plist, "utf8")).toBe(first);
      expect(launchctlCalls().filter((l) => l.includes(plist))).toEqual([]);
      expect(again.out).toMatch(/peer forward co\.harmoniqs\.amico-peer-jjs-mac-studio-forward unchanged/);
      expect(readdirSync(join(tmp, "Library", "LaunchAgents")).filter((f) => f.endsWith("-forward.plist"))).toEqual([
        "co.harmoniqs.amico-peer-jjs-mac-studio-forward.plist",
      ]);
      expect(backstopCalls()).toEqual([]);
    },
  );

  it("the ssh destination falls back to the peer's machine id when the roster has no row for it", () => {
    fakeAmico({ code: 0, stdout: verbFor("server") });
    fakeUname("Darwin");
    writePeerStore({ "jjs-mac-studio": "http://127.0.0.1:45096" });
    const r = runScript(INSTALL, [], installEnv());
    expect(r.code, r.out).toBe(0);
    expect(readAgent(peerForwardPlist("jjs-mac-studio")).args).toEqual(standardForward(45096, 4096, "jjs-mac-studio"));
  });

  it("one agent per peer: each loopback peer gets its own label + port; a peer reached over https (tailscale/direct) gets no ssh forward", () => {
    fakeAmico({ code: 0, stdout: verbFor("server") });
    fakeUname("Darwin");
    writePeerStore({
      "jjs-mac-studio": "http://127.0.0.1:45096",
      "lab-box": "http://127.0.0.1:45097",
      "far-node": "https://far-node.tailnet-1234.ts.net",
    });
    writeRoster([{ machine_id: "lab-box", sshAlias: "lab" }]);
    const r = runScript(INSTALL, [], installEnv());
    expect(r.code, r.out).toBe(0);
    expect(readAgent(peerForwardPlist("jjs-mac-studio")).args).toEqual(standardForward(45096, 4096, "jjs-mac-studio"));
    expect(readAgent(peerForwardPlist("lab-box")).args).toEqual(standardForward(45097, 4096, "lab"));
    expect(existsSync(peerForwardPlist("far-node"))).toBe(false);
    expect(r.out).toMatch(/far-node.*no SSH forward/);
  });

  it("Fleet — Repair runs the PACKAGED installer copy — it generates the same agent from the packaged template", () => {
    fakeAmico({ code: 0, stdout: verbFor("server") });
    fakeUname("Darwin");
    writePeerStore({ "jjs-mac-studio": "http://127.0.0.1:45096" });
    const packaged = join(REPO, "packages", "extension", "tools", "fleet", "install.sh");
    const r = runScript(packaged, [], installEnv());
    expect(r.code, r.out).toBe(0);
    expect(readAgent(peerForwardPlist("jjs-mac-studio")).args).toEqual(standardForward(45096, 4096, "jjs-mac-studio"));
    expect(backstopCalls()).toEqual([]);
  });
});

/** A hand-installed forward in the legacy `co.harmoniqs.amico-<name>-forward`
 *  shape — byte-for-byte the agent found on a real fleet laptop (stale 30/3,
 *  unbound `-L <port>:127.0.0.1:<remote>`, BatchMode + accept-new). */
function legacyForwardPlist(name: string, localPort: number, host: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key>
	<string>co.harmoniqs.amico-${name}-forward</string>
	<key>ProgramArguments</key>
	<array>
		<string>/usr/bin/ssh</string>
		<string>-N</string>
		<string>-L</string>
		<string>${localPort}:127.0.0.1:4096</string>
		<string>-o</string>
		<string>ExitOnForwardFailure=yes</string>
		<string>-o</string>
		<string>ServerAliveInterval=30</string>
		<string>-o</string>
		<string>ServerAliveCountMax=3</string>
		<string>-o</string>
		<string>BatchMode=yes</string>
		<string>-o</string>
		<string>StrictHostKeyChecking=accept-new</string>
		<string>${host}</string>
	</array>
	<key>RunAtLoad</key>
	<true/>
	<key>KeepAlive</key>
	<true/>
	<key>StandardOutPath</key>
	<string>/tmp/amico-${name}-forward.log</string>
	<key>StandardErrorPath</key>
	<string>/tmp/amico-${name}-forward.log</string>
	<key>ThrottleInterval</key>
	<integer>10</integer>
</dict>
</plist>
`;
}

describe("#1775 a hand-installed forward for the same peer is replaced — a backup is kept, never a silent delete", () => {
  const installEnv = (): { path: string } => ({
    path: `${join(tmp, "fakebin")}:${process.env.PATH ?? ""}`,
  });
  const launchAgents = (): string => join(tmp, "Library", "LaunchAgents");
  const backupDir = (): string => join(tmp, ".amico", "ops", "fleet", "launchagents-backup");
  const placeLegacy = (name: string, localPort: number, host: string): { file: string; content: string } => {
    mkdirSync(launchAgents(), { recursive: true });
    const file = join(launchAgents(), `co.harmoniqs.amico-${name}-forward.plist`);
    const content = legacyForwardPlist(name, localPort, host);
    writeFileSync(file, content);
    return { file, content };
  };

  it.each([
    ["it binds the same local port", 45096, "jjs-mac-studio"],
    ["it targets the same ssh destination", 47001, "jjs-mac-studio"],
  ])("recognized because %s: unloaded, moved byte-for-byte to the backup dir, and the managed agent takes its place; a re-run makes no second backup", (_why, legacyPort, legacyHost) => {
    fakeAmico({ code: 0, stdout: verbJson("server", { host: "hq", port: 4096 }) });
    fakeUname("Darwin");
    writePeerStore({ "jjs-mac-studio": "http://127.0.0.1:45096" });
    const legacy = placeLegacy("studio", legacyPort, legacyHost);

    const r = runScript(INSTALL, [], installEnv());
    expect(r.code, r.out).toBe(0);
    expect(existsSync(legacy.file)).toBe(false);
    const backups = readdirSync(backupDir());
    expect(backups).toHaveLength(1);
    expect(backups[0].startsWith("co.harmoniqs.amico-studio-forward.plist.")).toBe(true);
    expect(readFileSync(join(backupDir(), backups[0]), "utf8")).toBe(legacy.content);
    expect(r.out).toMatch(/replaced hand-installed peer forward .*co\.harmoniqs\.amico-studio-forward\.plist.*backup/);

    // The legacy job is unloaded BEFORE the managed one loads (they bind the same port).
    const managed = peerForwardPlist("jjs-mac-studio");
    const calls = launchctlCalls();
    expect(calls).toContain(`unload ${legacy.file}`);
    expect(calls.indexOf(`unload ${legacy.file}`)).toBeLessThan(calls.indexOf(`load ${managed}`));
    expect(readAgent(managed).args).toEqual(standardForward(45096, 4096, "jjs-mac-studio"));

    const again = runScript(INSTALL, [], installEnv());
    expect(again.code, again.out).toBe(0);
    expect(readdirSync(backupDir())).toEqual(backups);
    expect(backstopCalls()).toEqual([]);
  });

  it("a forward for a DIFFERENT peer (another port, another host) is left exactly as it was — never unloaded, never moved", () => {
    fakeAmico({ code: 0, stdout: verbJson("server", { host: "hq", port: 4096 }) });
    fakeUname("Darwin");
    writePeerStore({ "jjs-mac-studio": "http://127.0.0.1:45096" });
    const other = placeLegacy("lab", 47000, "lab-box");

    const r = runScript(INSTALL, [], installEnv());
    expect(r.code, r.out).toBe(0);
    expect(readFileSync(other.file, "utf8")).toBe(other.content);
    expect(launchctlCalls().filter((l) => l.includes(other.file))).toEqual([]);
    expect(existsSync(backupDir())).toBe(false);
  });
});

// ── #1775: `install.sh --check` is the CLI twin of the peer-forward healthcheck ──
describe("#1775 --check holds every peer forward agent to the standard (the healthcheck's CLI twin)", () => {
  const installEnv = (): { path: string } => ({
    path: `${join(tmp, "fakebin")}:${process.env.PATH ?? ""}`,
  });
  const launchAgents = (): string => join(tmp, "Library", "LaunchAgents");
  const attachStudio = (): void => {
    fakeAmico({ code: 0, stdout: verbJson("client", { host: "hq", port: 4096, sshAlias: "hq" }) });
    fakeUname("Darwin");
    writePeerStore({ "jjs-mac-studio": "http://127.0.0.1:45096" });
  };
  const listing = (): string => readdirSync(launchAgents()).map((f) => `${f}:${readFileSync(join(launchAgents(), f), "utf8").length}`).sort().join("\n");

  it("after an install, --check passes end to end and names the peer forward; --check itself never calls launchctl and writes nothing", () => {
    attachStudio();
    expect(runScript(INSTALL, [], installEnv()).code).toBe(0);
    rmSync(join(tmp, "launchctl.argv"), { force: true });
    const before = listing();
    const r = runScript(INSTALL, ["--check"], installEnv());
    expect(r.code, r.out).toBe(0);
    expect(r.out).toMatch(/ok peer forward co\.harmoniqs\.amico-peer-jjs-mac-studio-forward \(15\/2 \+ TCPKeepAlive, 127\.0\.0\.1:45096 → jjs-mac-studio:4096\)/);
    expect(r.out).toMatch(/fleet check: all ok/);
    expect(launchctlCalls()).toEqual([]);
    expect(backstopCalls()).toEqual([]);
    expect(listing()).toBe(before);
  });

  it("an attached peer with no forward agent fails --check with the fix line", () => {
    attachStudio();
    expect(runScript(INSTALL, [], installEnv()).code).toBe(0);
    rmSync(join(launchAgents(), "co.harmoniqs.amico-peer-jjs-mac-studio-forward.plist"));
    const r = runScript(INSTALL, ["--check"], installEnv());
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/FAIL peer forward co\.harmoniqs\.amico-peer-jjs-mac-studio-forward missing at .*\(run: bash tools\/fleet\/install\.sh\)/);
  });

  it("stale keepalive values fail --check, each value named (the tunnel check's lines)", () => {
    attachStudio();
    expect(runScript(INSTALL, [], installEnv()).code).toBe(0);
    const agent = join(launchAgents(), "co.harmoniqs.amico-peer-jjs-mac-studio-forward.plist");
    writeFileSync(agent, readFileSync(agent, "utf8").replace("ServerAliveInterval=15", "ServerAliveInterval=30").replace("ServerAliveCountMax=2", "ServerAliveCountMax=3"));
    const r = runScript(INSTALL, ["--check"], installEnv());
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/FAIL peer forward co\.harmoniqs\.amico-peer-jjs-mac-studio-forward ServerAliveInterval 15 missing/);
    expect(r.out).toMatch(/FAIL peer forward co\.harmoniqs\.amico-peer-jjs-mac-studio-forward ServerAliveCountMax 2 missing/);
    expect(r.out).not.toMatch(/fleet check: all ok/);
  });

  it("a hand-installed forward for an attached peer fails --check — Fleet — Repair replaces it, keeping a backup", () => {
    attachStudio();
    expect(runScript(INSTALL, [], installEnv()).code).toBe(0);
    writeFileSync(join(launchAgents(), "co.harmoniqs.amico-studio-forward.plist"), legacyForwardPlist("studio", 45096, "jjs-mac-studio"));
    rmSync(join(tmp, "launchctl.argv"), { force: true });
    const r = runScript(INSTALL, ["--check"], installEnv());
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/FAIL hand-installed peer forward .*co\.harmoniqs\.amico-studio-forward\.plist for jjs-mac-studio .*replaces it.*backup/);
    // a check only reports: the legacy agent is neither unloaded nor moved
    expect(launchctlCalls()).toEqual([]);
    expect(existsSync(join(launchAgents(), "co.harmoniqs.amico-studio-forward.plist"))).toBe(true);
  });

  it("the installer and the healthcheck agree: every agent the installer renders passes checkPeerForwards", () => {
    fakeAmico({ code: 0, stdout: verbJson("server", { host: "hq", port: 4096 }) });
    fakeUname("Darwin");
    writePeerStore({ "jjs-mac-studio": "http://127.0.0.1:45096", "lab-box": "http://127.0.0.1:45097" });
    writeRoster([{ machine_id: "lab-box", sshAlias: "lab" }]);
    expect(runScript(INSTALL, [], installEnv()).code).toBe(0);
    const checks = checkPeerForwards({
      launchAgentsDir: launchAgents(),
      peerStoreFile: join(tmp, ...PEER_STORE_REL),
      platform: "darwin",
      topology: {
        kind: "ok", role: "server", canonical: { host: "hq", port: 4096 }, mode: "fleet", posture: "ok",
        freshness: {}, provenanceSource: "fleet.json", projection: { schema_version: 1, contract_version: 1, sections: {} },
      },
    });
    expect(checks.map((c) => [c.name, c.ok])).toEqual([
      ["Fleet peer forward (jjs-mac-studio)", true],
      ["Fleet peer forward (lab-box)", true],
    ]);
  });
});
