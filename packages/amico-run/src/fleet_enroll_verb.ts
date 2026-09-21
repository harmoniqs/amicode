// `amico fleet enroll` (#1319) — the FLEET ENROLL PRIMITIVE. A NEW subcommand,
// DISTINCT from the session-registry `amico fleet` verbs (fleet_verb.ts) and
// their "write verbs don't write the record" invariant: enroll writes the
// machine's `fleet.json` membership record + a host-owned roster row, a
// different domain entirely. It is the idempotent, verifiable way to bring one
// machine into a fleet, and the primitive the `/create-a-fleet` orchestrator
// (#1320) drives.
//
// Two paths, the standard server-first join-token pattern (k3s/tailscale/swarm):
//   · `--as-server` — provision the durable hub service (the installer, role
//     server), mint the Fleet token (ADR 0005), and EMIT a join token bundling
//     { canonical{host,port,sshAlias}, fleet_token, transport_hint, pin_version }.
//     The join token is a SECRET, written at 0600, NEVER logged.
//   · client redeem (`--join-token <path>` | `--join-token-json <json>`):
//       1. PIN CHECK first — probe the host version and reject a token whose
//          pin_version disagrees (reusing the pure versionSkewVerdict) BEFORE any
//          file is written (AC4).
//       2. write fleet.json (role + canonical ONLY — capabilities live on the
//          roster row), register the roster row via POST /amicode/roster (#1318),
//          set amicode.fleetTransport (tailscale when this machine's capabilities
//          include `roaming`, else the token's hint), run the installer (which
//          installs the never-fork guard + the client tunnel).
//       3. VERIFY ATTACH — probe the just-set transport (GET /global/health,
//          expecting 200 + a pin matching the host). Success is reported ONLY
//          after verify-attach passes; on failure the specific cause is reported
//          with its fix, the roster row's health reflects the failure, and
//          success is NOT reported (ADR 0024/0025 no-silent-fallback).
//   Re-runnable: a second enroll REPAIRS in place — the roster POST is a
//   single-writer upsert (no duplicate row), the installer + token mint are
//   idempotent (no duplicate tunnel/unit).
//
// Never-fork (ADR 0005): enrolling as a client installs the guard and spawns NO
// engine — this verb has no engine-spawn path at all; the `spawnEngine` dep is a
// tripwire the tests assert is never touched.
//
// Async: the verb does real HTTP (roster POST + health probes). The `fleet` verb
// router (fleet_verb.ts) already returns `VerbResult | Promise<VerbResult>` and
// both callers (amico.ts, mcp_serve.ts) await it.
import * as fs from "node:fs";
import * as path from "node:path";
import { homedir, hostname } from "node:os";
import { randomUUID } from "node:crypto";
import {
  versionSkewVerdict,
  writeFleetConfig as schemaWriteFleetConfig,
  fleetTopologyPath,
  classifyMacModel,
  classifyLinuxChassis,
  normalizeDeviceName,
  isWslKernel,
  type FleetConfig,
  type RosterRow,
  type RosterHealth,
} from "@amicode/schema";
import type { VerbResult } from "./verbs.js";

// ── the join token contract (a secret — 0600, never logged) ───────────────────
export interface JoinTokenCanonical {
  host: string;
  port: number;
  sshAlias: string;
}
export interface JoinToken {
  canonical: JoinTokenCanonical;
  fleet_token: string;
  transport_hint: string;
  pin_version: string;
}

/** Parse a raw join token — tolerant Result (null on malformed), so a bad token
 *  is refused as data before any side effect. */
export function parseJoinToken(raw: string): JoinToken | null {
  let doc: unknown;
  try {
    doc = JSON.parse(raw);
  } catch {
    return null;
  }
  if (doc === null || typeof doc !== "object" || Array.isArray(doc)) return null;
  const o = doc as Record<string, unknown>;
  const c = o.canonical;
  if (c === null || typeof c !== "object" || Array.isArray(c)) return null;
  const cc = c as Record<string, unknown>;
  if (typeof cc.host !== "string" || cc.host.trim() === "") return null;
  if (typeof cc.port !== "number" || !Number.isFinite(cc.port)) return null;
  if (typeof cc.sshAlias !== "string") return null;
  if (typeof o.fleet_token !== "string" || o.fleet_token.trim() === "") return null;
  if (typeof o.transport_hint !== "string" || o.transport_hint.trim() === "") return null;
  if (typeof o.pin_version !== "string" || o.pin_version.trim() === "") return null;
  return {
    canonical: { host: cc.host, port: cc.port, sshAlias: cc.sshAlias },
    fleet_token: o.fleet_token,
    transport_hint: o.transport_hint,
    pin_version: o.pin_version,
  };
}

// ── the enroll-result JSON (the exact shape #1320 consumes) ────────────────────
export interface EnrollVerifyAttach {
  ok: boolean;
  cause?: string;
}
export interface EnrollResult {
  machine_id: string;
  name: string;
  server_mode: string;
  capabilities: string[];
  transport: string;
  verify_attach: EnrollVerifyAttach;
}

// ── the transport→origin resolution for verify-attach ─────────────────────────
export type ProbeOriginResult = { ok: true; origin: string } | { ok: false; cause: string; fix: string };

// ── injectable seams (production defaults do the real thing; tests stub) ───────
export interface FleetEnrollDeps {
  /** This machine's stable id (single-writer roster key). Default: hostname(). */
  machineId?: () => string;
  /** This machine's OS-detected friendly display name — the middle tier of the
   *  name precedence (setting override → THIS → prettified hostname). Default:
   *  the OS detector (scutil ComputerName / hostnamectl --pretty) via the
   *  command-runner, falling back to the prettified hostname. NOTE: this is the
   *  DISPLAY name only — it is deliberately kept OUT of the `canonical.host`
   *  derivation so a friendly name never leaks into the join token (ADR 0028). */
  machineName?: () => string;
  /** This machine's declared capability tags (roaming → tailscale). Default: []. */
  capabilities?: () => string[];
  /** This build's version pin — the enroll-time pin check + the minted token's
   *  pin_version. Default: AMICO_CLIENT_VERSION env, else "dev". */
  clientVersion?: () => string;
  /** ISO stamp for the roster row. Default: now. */
  now?: () => string;
  /** The HTTP impl for the roster POST + health probes. Default: globalThis.fetch. */
  fetchImpl?: typeof fetch;
  /** The fleet.json writer. Default: the hoisted @amicode/schema writeFleetConfig. */
  writeFleetConfig?: (config: FleetConfig, p: string) => void;
  /** Where fleet.json lives. Default: fleetTopologyPath(). */
  fleetConfigPath?: string;
  /** Write the join token at 0600. Default: atomic 0600 write. */
  writeJoinToken?: (p: string, token: JoinToken) => void;
  /** Read a join token file (0600). Default: read-or-null. */
  readJoinTokenFile?: (p: string) => string | null;
  /** Where the minted join token lands (--as-server). Default under ~/.amico. */
  joinTokenOutPath?: string;
  /** Run the fleet installer for a role (guard/tunnel/hub-service; idempotent).
   *  Default: shell tools/fleet/install.sh (honest failure if unlocatable). */
  runInstaller?: (role: string) => { ok: boolean; detail?: string };
  /** Set amicode.fleetTransport. Default: merge into the VS Code User settings.json. */
  setTransport?: (kind: string) => void;
  /** Mint or reuse the Fleet token (0600, idempotent). Default: read-or-mint. */
  mintFleetToken?: () => string;
  /** NEVER called — the never-fork tripwire (a client spawns no engine). */
  spawnEngine?: () => void;
  /** Resolve a transport + canonical to the origin verify-attach probes, or the
   *  sshAlias-unresolved cause. Default: local/tailscale/direct → http host:port;
   *  ssh with an empty alias → sshAlias-unresolved. */
  resolveProbeOrigin?: (transport: string, canonical: JoinTokenCanonical) => ProbeOriginResult;
  /** Retry delays in ms for verify-attach transport-down probes.
   *  Default: [1000, 2000, 4000] — up to 3 retries with exponential backoff.
   *  Only `{ error: "unreachable" }` retries; auth rejections and pin mismatches
   *  fail immediately. Tests inject [0, 0, 0] for instant retries. */
  retryDelayMs?: number[];
  /** The ONE injectable command-runner seam for the impure OS device-identity
   *  detection (macOS `scutil`/`system_profiler`, Linux `hostnamectl` + `/sys`
   *  DMI + `/proc/version`). Default: an execFile-based runner that returns ""
   *  on any failure (detection is best-effort). Tests feed canned command output
   *  through it into the shared @amicode/schema classifiers (#1371 AC6/AC7). */
  commandRunner?: CommandRunner;
  /** This machine's OS-detected device_type (form factor) — the middle tier of
   *  the type precedence (setting override → THIS → undefined). Default: OS
   *  detection via `commandRunner` → the shared schema classifier. `undefined`
   *  is an honest abstain (the sidebar's type pill falls back to server_mode). */
  deviceType?: () => string | undefined;
  /** Read a device-identity setting override (`amicode.device.name` /
   *  `amicode.device.type`) — the SAME namespace the extension self-row reads
   *  (ADR 0028: one override namespace, both producers). Default: read the VS
   *  Code User settings.json (the same path `setTransport` writes). */
  readDeviceSetting?: (key: string) => string | undefined;
}

/** The impure command-runner seam signature: run a command with args and return
 *  its stdout (or "" on failure). ONE per node package (ADR 0028) — the shell
 *  lives here; all judgment is delegated to the shared @amicode/schema pure
 *  classifiers. */
export type CommandRunner = (cmd: string, args: string[]) => string;

// ── flag parsing ──────────────────────────────────────────────────────────────
function flagValue(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined;
}

function fail(errors: string[], extra: Record<string, unknown> = {}, code = 64): VerbResult {
  return { json: { verb: "fleet", subcommand: "enroll", ok: false, errors, ...extra }, code };
}

// ── production defaults ─────────────────────────────────────────────────────
function defaultWriteJoinToken(p: string, token: JoinToken): void {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = `${p}.${process.pid}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(token, null, 2) + "\n", { mode: 0o600 });
    fs.chmodSync(tmp, 0o600);
    fs.renameSync(tmp, p);
    fs.chmodSync(p, 0o600);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

function defaultReadJoinTokenFile(p: string): string | null {
  return fs.existsSync(p) ? fs.readFileSync(p, "utf8") : null;
}

function defaultFleetTokenPath(): string {
  return path.join(homedir(), ".amico", "ops", "fleet", "fleet-token");
}

/** Read-or-mint the Fleet token (0600). Exclusive create so a re-run REUSES the
 *  existing token (idempotent mint, AC5). */
function defaultMintFleetToken(): string {
  const p = defaultFleetTokenPath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const token = randomUUID().replace(/-/g, "");
  try {
    fs.writeFileSync(p, token, { encoding: "utf8", flag: "wx", mode: 0o600 });
    fs.chmodSync(p, 0o600);
    return token;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    const existing = fs.readFileSync(p, "utf8").trim();
    if (existing.length === 0) throw new Error(`fleet-token file is empty: ${p}`);
    return existing;
  }
}

/** Locate + run tools/fleet/install.sh for the role (idempotent by the script's
 *  own design). AMICO_FLEET_INSTALLER overrides the path; an unlocatable script
 *  is an honest failure, never a silent success. */
function defaultRunInstaller(role: string): { ok: boolean; detail?: string } {
  const candidates = [
    process.env.AMICO_FLEET_INSTALLER,
    path.join(homedir(), "harmoniqs", "amicode", "tools", "fleet", "install.sh"),
  ].filter((c): c is string => typeof c === "string" && c.length > 0);
  const script = candidates.find((c) => fs.existsSync(c));
  if (!script) {
    return { ok: false, detail: `fleet installer not found (set AMICO_FLEET_INSTALLER); role=${role} not provisioned` };
  }
  const { spawnSync } = require("node:child_process") as typeof import("node:child_process");
  const r = spawnSync("bash", [script], { encoding: "utf8" });
  return r.status === 0 ? { ok: true } : { ok: false, detail: (r.stderr || "").trim() || `installer exited ${r.status}` };
}

/** VS Code User settings.json path per-OS (mirrors tools/fleet/install.sh). */
function defaultSettingsPath(): string {
  if (process.platform === "darwin") {
    return path.join(homedir(), "Library", "Application Support", "Code", "User", "settings.json");
  }
  return path.join(homedir(), ".config", "Code", "User", "settings.json");
}

/** Merge amicode.fleetTransport into the VS Code User settings.json (the surface
 *  the transport-provider selector reads — amico-run has no VS Code API). */
function defaultSetTransport(kind: string): void {
  const p = defaultSettingsPath();
  let doc: Record<string, unknown> = {};
  try {
    doc = JSON.parse(fs.readFileSync(p, "utf8")) as Record<string, unknown>;
  } catch {
    doc = {};
  }
  doc["amicode.fleetTransport"] = kind;
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(doc, null, 2) + "\n");
}

// ── device identity: the impure detector (ONE command-runner seam) ─────────────
/** The default command runner: execFile the command, return stdout, and swallow
 *  any failure into "" — detection is best-effort (a missing binary, a non-zero
 *  exit, a timeout all read as "nothing detected"). The ONE place amico-run
 *  shells out for device identity; all classification is the shared schema fns. */
function defaultCommandRunner(cmd: string, args: string[]): string {
  try {
    const { execFileSync } = require("node:child_process") as typeof import("node:child_process");
    return execFileSync(cmd, args, { encoding: "utf8", timeout: 2000 }).toString();
  } catch {
    return "";
  }
}

/** Read a device-identity setting override from the VS Code User settings.json
 *  (the same file `setTransport` writes `amicode.fleetTransport` into). Returns
 *  the string value or undefined (absent file / non-string / parse error). */
function defaultReadDeviceSetting(key: string): string | undefined {
  try {
    const doc = JSON.parse(fs.readFileSync(defaultSettingsPath(), "utf8")) as Record<string, unknown>;
    const v = doc[key];
    return typeof v === "string" && v.trim() !== "" ? v : undefined;
  } catch {
    return undefined;
  }
}

/** Map a `/sys/class/dmi/id/chassis_type` NUMERIC code to the device-type
 *  vocabulary (SMBIOS System Enclosure types) — the Linux second source, after
 *  `hostnamectl` chassis and before abstaining. Kept in the node package (this
 *  is platform plumbing over a numeric code, not the string-chassis judgment the
 *  shared `classifyLinuxChassis` owns). */
function dmiChassisType(code: string): string | undefined {
  const n = code.trim();
  if (["8", "9", "10", "11", "12", "14", "30", "31", "32"].includes(n)) return "laptop";
  if (["3", "4", "5", "6", "7", "13", "15", "16", "34", "35", "36"].includes(n)) return "desktop";
  if (["17", "23", "28"].includes(n)) return "server";
  return undefined;
}

/** OS device_type detection through the command-runner seam → the shared schema
 *  classifiers. macOS: `system_profiler` "Model Name" → classifyMacModel. Linux:
 *  WSL abstains (the VM chassis is not the physical machine); else `hostnamectl`
 *  chassis → classifyLinuxChassis FIRST, then `/sys/class/dmi/id/chassis_type`
 *  numeric, then abstain (#1371 AC7 / ADR 0028). Any other platform abstains. */
export function detectDeviceTypeVia(run: CommandRunner, platform: string): string | undefined {
  if (platform === "darwin") {
    const out = run("system_profiler", ["SPHardwareDataType"]) ?? "";
    const m = /Model Name:\s*(.+)/i.exec(out);
    return classifyMacModel((m?.[1] ?? "").trim());
  }
  if (platform === "linux") {
    if (isWslKernel(run("cat", ["/proc/version"]) ?? "")) return undefined; // WSL abstains
    const byChassis = classifyLinuxChassis((run("hostnamectl", ["chassis"]) ?? "").trim());
    if (byChassis) return byChassis;
    const byDmi = dmiChassisType((run("cat", ["/sys/class/dmi/id/chassis_type"]) ?? "").trim());
    if (byDmi) return byDmi;
    return undefined;
  }
  return undefined;
}

/** OS friendly-NAME detection through the command-runner seam. macOS: `scutil
 *  --get ComputerName`. Linux: `hostnamectl --pretty` (the PRETTY_HOSTNAME). Any
 *  empty/failed detection falls back to the prettified raw hostname — never a
 *  fabricated name (#1371 AC7 / ADR 0028). */
export function detectDeviceNameVia(run: CommandRunner, rawHostname: string, platform: string): string {
  if (platform === "darwin") {
    const name = (run("scutil", ["--get", "ComputerName"]) ?? "").trim();
    if (name) return name;
  } else if (platform === "linux") {
    const pretty = (run("hostnamectl", ["--pretty"]) ?? "").trim();
    if (pretty) return pretty;
  }
  return normalizeDeviceName(rawHostname);
}

function defaultResolveProbeOrigin(transport: string, canonical: JoinTokenCanonical): ProbeOriginResult {
  if (transport === "ssh" && (!canonical.sshAlias || canonical.sshAlias.trim() === "")) {
    return {
      ok: false,
      cause: "sshAlias-unresolved",
      fix: "the join token carries no canonical.sshAlias — add it to the token (and to ~/.ssh/config) so the ssh tunnel can resolve the hub host",
    };
  }
  return { ok: true, origin: `http://${canonical.host}:${canonical.port}` };
}

// ── HTTP helpers ───────────────────────────────────────────────────────────
type HealthProbe = { status: number; version: string | null } | { error: "unreachable" };

async function probeHealth(origin: string, authHeader: string | undefined, fetchImpl: typeof fetch): Promise<HealthProbe> {
  const url = `${origin.replace(/\/+$/, "")}/global/health`;
  try {
    const res = await fetchImpl(url, {
      ...(authHeader ? { headers: { Authorization: authHeader } } : {}),
    });
    if (!res.ok) return { status: res.status, version: null };
    const body = (await res.json()) as { version?: unknown };
    return { status: res.status, version: typeof body.version === "string" ? body.version : null };
  } catch {
    return { error: "unreachable" };
  }
}

async function postRosterRow(
  canonical: JoinTokenCanonical,
  authHeader: string | undefined,
  row: RosterRow,
  fetchImpl: typeof fetch,
): Promise<{ ok: boolean; status: number } | { error: string }> {
  const url = `http://${canonical.host}:${canonical.port}/amicode/roster`;
  try {
    const res = await fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...(authHeader ? { Authorization: authHeader } : {}) },
      body: JSON.stringify(row),
    });
    return { ok: res.ok, status: res.status };
  } catch (e) {
    return { error: (e as Error).message };
  }
}

// ── the server path ────────────────────────────────────────────────────────
/** Verify the hub is reachable on the given origin, retry-or-honest-fail (#1372
 *  AC1). Retries ONLY on `{error:"unreachable"}` (a transient loopback race);
 *  any answer (the hub responded at all) proves it is up. Returns ok:false only
 *  after exhausting retries. Distinct from the dev-fallback pin probe, which
 *  TOLERATES an unreachable hub and is therefore NOT proof of reachability. */
async function verifyHubReachable(
  origin: string,
  fetchImpl: typeof fetch,
  retryDelays: number[] = [1000, 2000, 4000],
): Promise<{ ok: boolean }> {
  const maxAttempts = 1 + retryDelays.length;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const probe = await probeHealth(origin, undefined, fetchImpl);
    if (!("error" in probe)) return { ok: true }; // the hub answered ⇒ reachable
    if (attempt < retryDelays.length) {
      await new Promise<void>((resolve) => setTimeout(resolve, retryDelays[attempt]));
      continue;
    }
  }
  return { ok: false };
}

/** The pin_version to stamp on a minted join token. Precedence (#1354 follow-up):
 *  an explicit injection or AMICO_CLIENT_VERSION env wins (operator override);
 *  otherwise probe the just-provisioned local hub's /global/health and pin its
 *  REAL engine version — NOT the placeholder "dev", which fails the enroll-time
 *  pin-check against the server's own 1.18.x engine. "dev" survives only as the
 *  last-resort fallback when the hub is unreachable at mint time. */
async function resolveServerPinVersion(
  deps: FleetEnrollDeps,
  canonical: JoinTokenCanonical,
  fetchImpl: typeof fetch,
): Promise<string> {
  if (deps.clientVersion) return deps.clientVersion();
  const envPin = process.env.AMICO_CLIENT_VERSION;
  if (typeof envPin === "string" && envPin.trim() !== "") return envPin;
  // The hub listens on loopback; advertised canonical.host may not resolve locally.
  const probe = await probeHealth(`http://127.0.0.1:${canonical.port}`, undefined, fetchImpl);
  if ("version" in probe && typeof probe.version === "string" && probe.version.trim() !== "") {
    return probe.version;
  }
  return "dev";
}

async function enrollAsServer(argv: string[], deps: FleetEnrollDeps): Promise<VerbResult> {
  const runner = deps.commandRunner ?? defaultCommandRunner;
  const machineName = (deps.machineName ?? (() => detectDeviceNameVia(runner, hostname(), process.platform)))();
  // The friendly display name is DECOUPLED from canonical.host (ADR 0028 §inv 6):
  // canonical derives from --host or the RAW hostname, never the friendly name,
  // so a friendly name can never leak into `canonical`/the minted join token.
  const host = flagValue(argv, "--host") ?? hostname();
  const portRaw = flagValue(argv, "--port") ?? "4096";
  if (!/^\d+$/.test(portRaw)) return fail([`--port "${portRaw}" must be a positive integer`]);
  const port = Number(portRaw);
  const sshAlias = flagValue(argv, "--ssh-alias") ?? host;
  const transportHint = flagValue(argv, "--transport-hint") ?? "ssh";
  const canonical: JoinTokenCanonical = { host, port, sshAlias };

  const writeConfig = deps.writeFleetConfig ?? schemaWriteFleetConfig;
  const configPath = deps.fleetConfigPath ?? fleetTopologyPath();
  writeConfig({ role: "server", canonical }, configPath);

  // Provision the durable hub service (the installer, role server; idempotent).
  const inst = (deps.runInstaller ?? defaultRunInstaller)("server");
  if (!inst.ok) {
    return fail(
      [`hub-service provisioning failed: ${inst.detail ?? "(no detail)"}`],
      { role: "server", fix: "run `bash tools/fleet/install.sh` and re-enroll once it reports ok" },
      70,
    );
  }

  const fleet_token = (deps.mintFleetToken ?? defaultMintFleetToken)();
  const fetchImpl = deps.fetchImpl ?? (globalThis.fetch as typeof fetch);
  const pin_version = await resolveServerPinVersion(deps, canonical, fetchImpl);
  const token: JoinToken = { canonical, fleet_token, transport_hint: transportHint, pin_version };
  const outPath = deps.joinTokenOutPath ?? path.join(homedir(), ".amico", "ops", "fleet", "join-token.json");
  (deps.writeJoinToken ?? defaultWriteJoinToken)(outPath, token);

  // ── self-register the server's OWN roster row (#1372 AC2), keyed by
  //    machine_id = canonical.host — the same identity a client references it
  //    by, so the client's synthesized canonical-server node collapses against
  //    this real row (zero client-side change), and the server's own self-row
  //    (reconciled to canonical.host in the extension) renders exactly once.
  //    ONLY after VERIFYING the hub is reachable on loopback (#1372 AC1): the
  //    hub listens on loopback; canonical.host may not resolve locally. This is
  //    a SEPARATE check from resolveServerPinVersion's dev-fallback probe (which
  //    tolerates an unreachable hub) — a dev pin is never reachability proof.
  //    No silent fallback (ADR 0024/0025): unreachable ⇒ no POST, no false row.
  const readSetting = deps.readDeviceSetting ?? defaultReadDeviceSetting;
  const nameOverride = readSetting("amicode.device.name");
  const resolvedName = nameOverride && nameOverride.trim() !== "" ? nameOverride.trim() : machineName;
  const typeOverride = readSetting("amicode.device.type");
  const detectedType = (deps.deviceType ?? (() => detectDeviceTypeVia(runner, process.platform)))();
  // The server's device_type: override → OS detection → the honest "server"
  // default (a server that can't detect its form factor is, at least, a server).
  const serverDeviceType = typeOverride && typeOverride.trim() !== "" ? typeOverride.trim() : (detectedType ?? "server");

  const loopbackOrigin = `http://127.0.0.1:${port}`;
  const loopbackCanonical: JoinTokenCanonical = { host: "127.0.0.1", port, sshAlias };
  const reachable = await verifyHubReachable(loopbackOrigin, fetchImpl, deps.retryDelayMs);
  let self_registered = false;
  if (reachable.ok) {
    const serverRow: RosterRow = {
      machine_id: canonical.host,
      name: resolvedName,
      server_mode: "server",
      capabilities: (deps.capabilities ?? (() => []))(),
      sshAlias: canonical.sshAlias,
      transport: transportHint,
      last_report: (deps.now ?? (() => new Date().toISOString()))(),
      health: "reachable",
      device_type: serverDeviceType,
    };
    // Reuse the single-writer POST (no new writer). The URL targets loopback
    // (the local hub); the ROW carries machine_id = canonical.host.
    const post = await postRosterRow(loopbackCanonical, undefined, serverRow, fetchImpl);
    self_registered = "ok" in post && post.ok;
  }

  const result: EnrollResult = {
    machine_id: (deps.machineId ?? (() => hostname()))(),
    name: resolvedName,
    server_mode: "server",
    capabilities: (deps.capabilities ?? (() => []))(),
    transport: transportHint,
    verify_attach: { ok: true },
  };
  return {
    json: {
      verb: "fleet",
      subcommand: "enroll",
      ok: true,
      result,
      // the join token rides the result so #1320 can hand it to clients; it is
      // ALSO persisted at 0600. It is a secret — surfaced on the structured
      // result only, never in a log line.
      join_token: token,
      join_token_path: outPath,
      self_registered,
      // AC5: canonical.host is IMMUTABLE after first server enroll — changing
      // --host on a re-enroll orphans clients' synthesized node and requires
      // re-enrolling the CLIENTS, not just the server (never auto-reconciled).
      caveat:
        "canonical.host is immutable after first enroll — changing --host requires re-enrolling clients (their canonical pointer is not auto-reconciled)",
      note: self_registered
        ? "server enrolled — durable hub service provisioned, Fleet token minted, join token emitted (0600), and the server's own roster row self-registered (machine_id = canonical.host)"
        : "server enrolled — hub provisioned + join token emitted (0600); the hub was NOT reachable on loopback at self-register time, so the server roster row was NOT posted (no false success). Re-enroll once the hub answers.",
    },
    code: 0,
  };
}

// ── the client redeem path ───────────────────────────────────────────────────
async function enrollAsClient(argv: string[], token: JoinToken, deps: FleetEnrollDeps): Promise<VerbResult> {
  const fetchImpl = deps.fetchImpl ?? (globalThis.fetch as typeof fetch);
  const canonical = token.canonical;

  // ── AC4: the PIN CHECK, BEFORE any file is written ──
  // Probe the canonical host's version and reject a pin_version disagreement
  // via the pure versionSkewVerdict. An unreachable host at this stage is also
  // a pre-write refusal (the token cannot be validated) — never a blind write.
  // #1354: the hub uses open auth (AMICODE_SERVICE_AUTH=open) — the SSH tunnel
  // is the trust boundary, so no HTTP credentials are sent.
  const pinProbe = await probeHealth(`http://${canonical.host}:${canonical.port}`, undefined, fetchImpl);
  if ("error" in pinProbe) {
    return fail(
      [`cannot reach the hub host to validate the join token's pin (host ${canonical.host}:${canonical.port} unreachable)`],
      {
        stage: "pin-check",
        cause: "transport-down",
        fix: "confirm the hub is up and reachable from this machine, then re-run enroll",
        wrote_nothing: true,
      },
      69,
    );
  }
  if (pinProbe.version !== null) {
    const verdict = versionSkewVerdict(token.pin_version, pinProbe.version);
    if (!verdict.agree) {
      return fail([verdict.reason], {
        stage: "pin-check",
        cause: "pin-mismatch",
        pin_version: token.pin_version,
        host_version: pinProbe.version,
        fix: "align the client and hub versions (upgrade one) and re-mint the join token, then re-enroll",
        wrote_nothing: true,
      });
    }
  }

  // ── transport selection (AC2): roaming → tailscale, else the token hint ──
  const caps = (deps.capabilities ?? (() => []))();
  const transport = caps.includes("roaming") ? "tailscale" : token.transport_hint;

  // ── write fleet.json (role + canonical ONLY — capabilities go to the row) ──
  const writeConfig = deps.writeFleetConfig ?? schemaWriteFleetConfig;
  const configPath = deps.fleetConfigPath ?? fleetTopologyPath();
  writeConfig({ role: "client", canonical }, configPath);

  const machineId = (deps.machineId ?? (() => hostname()))();
  const rawHostname = hostname();
  const runner = deps.commandRunner ?? defaultCommandRunner;
  const readSetting = deps.readDeviceSetting ?? defaultReadDeviceSetting;

  // ── device identity, resolved per field (ADR 0028 precedence) ──
  // name:       setting override → OS detection (machineName seam) → prettified hostname
  // device_type: setting override → OS detection (deviceType seam) → undefined (honest omit)
  const nameOverride = readSetting("amicode.device.name");
  const detectedName = (deps.machineName ?? (() => detectDeviceNameVia(runner, rawHostname, process.platform)))();
  const name = nameOverride && nameOverride.trim() !== "" ? nameOverride.trim() : detectedName;

  const typeOverride = readSetting("amicode.device.type");
  const detectedType = (deps.deviceType ?? (() => detectDeviceTypeVia(runner, process.platform)))();
  const deviceType = typeOverride && typeOverride.trim() !== "" ? typeOverride.trim() : detectedType;

  const now = (deps.now ?? (() => new Date().toISOString()))();

  // ── register the roster row (#1318 POST /amicode/roster), provisional ──
  const provisionalRow: RosterRow = {
    machine_id: machineId,
    name,
    server_mode: "client",
    capabilities: caps,
    sshAlias: canonical.sshAlias,
    transport,
    last_report: now,
    health: "reachable",
    ...(deviceType ? { device_type: deviceType } : {}),
  };
  await postRosterRow(canonical, undefined, provisionalRow, fetchImpl);

  // ── set the transport, then run the installer (guard + client tunnel) ──
  (deps.setTransport ?? defaultSetTransport)(transport);
  const inst = (deps.runInstaller ?? defaultRunInstaller)("client");

  // ── VERIFY ATTACH (AC3): probe the just-set transport ──
  const resolveOrigin = deps.resolveProbeOrigin ?? defaultResolveProbeOrigin;
  const verify = await runVerifyAttach(resolveOrigin, transport, canonical, token, fetchImpl, deps.retryDelayMs);

  const result: EnrollResult = {
    machine_id: machineId,
    name,
    server_mode: "client",
    capabilities: caps,
    transport,
    verify_attach: verify.ok ? { ok: true } : { ok: false, cause: verify.cause },
  };

  if (verify.ok) {
    return {
      json: {
        verb: "fleet",
        subcommand: "enroll",
        ok: true,
        result,
        installer_ok: inst.ok,
        note: "client enrolled — fleet.json written, roster row registered, transport set, guard installed, verify-attach passed",
      },
      code: 0,
    };
  }

  // ── honest failure: reflect it on the roster row, do NOT report success ──
  const failedHealth: RosterHealth = verify.cause === "transport-down" ? "down" : "degraded";
  await postRosterRow(
    canonical,
    undefined,
    { ...provisionalRow, health: failedHealth, last_report: (deps.now ?? (() => new Date().toISOString()))() },
    fetchImpl,
  );
  return {
    json: {
      verb: "fleet",
      subcommand: "enroll",
      ok: false,
      result,
      cause: verify.cause,
      fix: verify.fix,
      roster_health: failedHealth,
      installer_ok: inst.ok,
      note: "verify-attach FAILED — the roster row's health reflects it and success is NOT reported (no silent fallback)",
    },
    code: 65,
  };
}

type VerifyOutcome = { ok: true } | { ok: false; cause: string; fix: string };

async function runVerifyAttach(
  resolveOrigin: (transport: string, canonical: JoinTokenCanonical) => ProbeOriginResult,
  transport: string,
  canonical: JoinTokenCanonical,
  token: JoinToken,
  fetchImpl: typeof fetch,
  retryDelays: number[] = [1000, 2000, 4000],
): Promise<VerifyOutcome> {
  const originR = resolveOrigin(transport, canonical);
  if (!originR.ok) return { ok: false, cause: originR.cause, fix: originR.fix };

  const maxAttempts = 1 + retryDelays.length; // first try + retries
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const probe = await probeHealth(originR.origin, undefined, fetchImpl);

    // Only "unreachable" (transport-down) retries — auth rejections, pin
    // mismatches, and other non-transport failures fail immediately.
    if ("error" in probe) {
      if (attempt < retryDelays.length) {
        await new Promise<void>((resolve) => setTimeout(resolve, retryDelays[attempt]));
        continue;
      }
      // Exhausted retries
      return {
        ok: false,
        cause: "transport-down",
        fix: `the ${transport} transport to ${canonical.host}:${canonical.port} is not reachable — confirm the tunnel/tailscale is up, then re-run enroll`,
      };
    }
    if (probe.status === 401 || probe.status === 403) {
      return {
        ok: false,
        cause: "auth-rejected",
        fix: "the hub rejected the Fleet token — re-mint it on the server (`amico fleet enroll --as-server`) and re-enroll with the fresh join token",
      };
    }
    if (probe.status !== 200) {
      return {
        ok: false,
        cause: "transport-down",
        fix: `the transport reached the host but it answered HTTP ${probe.status} on /global/health — confirm the hub is healthy, then re-run enroll`,
      };
    }
    // 200 but a pin that does not match the host = reached the WRONG/updated host.
    if (probe.version !== null && !versionSkewVerdict(token.pin_version, probe.version).agree) {
      return {
        ok: false,
        cause: "pin-mismatch",
        fix: `verify-attach reached a host reporting ${probe.version} but the token pins ${token.pin_version} — the transport points at the wrong host or it was upgraded; re-mint the join token`,
      };
    }
    return { ok: true };
  }

  // Unreachable — the loop always returns — but TypeScript needs it.
  return {
    ok: false,
    cause: "transport-down",
    fix: `the ${transport} transport to ${canonical.host}:${canonical.port} is not reachable — confirm the tunnel/tailscale is up, then re-run enroll`,
  };
}

// ── the enroll verb body ───────────────────────────────────────────────────
export async function fleetEnroll(argv: string[], deps: FleetEnrollDeps = {}): Promise<VerbResult> {
  if (argv.includes("--as-server")) {
    return enrollAsServer(argv, deps);
  }

  const tokenPath = flagValue(argv, "--join-token");
  const tokenJson = flagValue(argv, "--join-token-json");
  let raw: string | null = null;
  if (tokenJson !== undefined) {
    raw = tokenJson;
  } else if (tokenPath !== undefined) {
    raw = (deps.readJoinTokenFile ?? defaultReadJoinTokenFile)(tokenPath);
    if (raw === null) return fail([`join token file not found or unreadable: ${tokenPath}`]);
  } else {
    return fail([
      "enroll needs a role: `amico fleet enroll --as-server` (mint a join token) or `amico fleet enroll --join-token <path>` (redeem one)",
    ]);
  }

  const token = parseJoinToken(raw);
  if (token === null) {
    return fail([
      "the join token is malformed — expected { canonical{host,port,sshAlias}, fleet_token, transport_hint, pin_version }",
    ]);
  }
  return enrollAsClient(argv, token, deps);
}
