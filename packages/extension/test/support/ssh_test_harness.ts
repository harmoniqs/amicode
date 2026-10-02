// ssh_test_harness.ts — #1634 Slice 1: a shared test-support harness that
// stops the real-SSH integration suites from LEAKING `ssh -N` loopback
// forwards and throwaway `~/.ssh/authorized_keys` entries across interrupted
// runs. (Leaked forwards accumulate, saturate the local sshd past
// MaxStartups/PerSourcePenalties, and silently break a fleet machine's inbound
// heartbeat — see #1634.)
//
// Two defenses, both owned HERE (no change to production forward bring-up):
//
//   (1) A spawn-time PID REGISTRY — the PRIMARY, path-independent reap
//       mechanism. Every forward's PID is appended to a harness-owned registry
//       file at bring-up (`registerForward`). The pre-flight sweep
//       (`sweepForwards`) reads the registry and, for each still-alive PID it
//       can CONFIRM is an `ssh` process carrying a loopback
//       `-L 127.0.0.1:…:127.0.0.1:…` forward, kills it, then truncates the
//       file. This survives SIGKILL (the file persists) and works whether or
//       not a throwaway key was ever installed — because the preferred
//       zero-mutation SSH_READY path spawns forwards with NO `-i` marker, a
//       marker-only sweep would reap nothing on the common developer machine.
//       Marker-scoping (`amicode-*-test-*`) is retained ONLY as the secondary
//       authorized_keys filter, never the sole identifier of a forward.
//
//   (2) A crash-safe TEARDOWN — SIGINT/SIGTERM/exit handlers that
//       SYNCHRONOUSLY restore authorized_keys and kill spawned children,
//       covering the common interactive Ctrl-C / SIGTERM case.
//
// Every decision is injected against SEAMS — a HarnessFs and a
// ProcessInspector — so the unit test (ssh_test_harness.test.ts) runs
// deterministically with no real sshd, no real spawns, and no real fs writes.

// ── seams ──────────────────────────────────────────────────────────────────

/** The minimal, synchronous filesystem surface the harness needs. The default
 *  binding is node:fs; the unit test injects an in-memory implementation. */
export interface HarnessFs {
  existsSync(path: string): boolean;
  readFileSync(path: string): string;
  writeFileSync(path: string, data: string): void;
  appendFileSync(path: string, data: string): void;
}

/** What the inspector reports about ONE pid — enough to decide, safely,
 *  whether it is a live `ssh` loopback forward this harness spawned. `argv`
 *  is the process's full argument vector (argv[0] is the command). */
export interface ProcessEntry {
  alive: boolean;
  command: string;
  argv: readonly string[];
}

/** Enumerate + kill processes. The default binding shells out to `ps`/
 *  process.kill; the unit test injects a deterministic in-memory table so a
 *  recycled PID (now a non-ssh process) is provably never killed. */
export interface ProcessInspector {
  /** Inspect a pid; `undefined` when no such process exists (dead/absent). */
  inspect(pid: number): ProcessEntry | undefined;
  /** Kill a pid. Returns whether the signal was delivered. */
  kill(pid: number): boolean;
}

// ── the kill-decision predicate (AC2) ──────────────────────────────────────

/** A loopback-to-loopback `-L` forward spec: `127.0.0.1:<lport>:127.0.0.1:<rport>`.
 *  Both ends MUST be 127.0.0.1 — a user's own `-L 0.0.0.0:…:10.0.0.5:…` remote
 *  forward is deliberately NOT matched, so the sweep never reaps it. */
const LOOPBACK_FORWARD_RE = /^127\.0\.0\.1:\d+:127\.0\.0\.1:\d+$/;

/** The safety-over-completeness predicate at the heart of the sweep (AC2): a
 *  registry PID is reaped ONLY when the inspector confirms it is (a) alive,
 *  (b) an `ssh` process, and (c) carrying a loopback `-L 127.0.0.1:…:127.0.0.1:…`
 *  forward argument. A recycled PID now belonging to an unrelated process, a
 *  dead PID, a plain interactive ssh, or a non-loopback forward all return
 *  false — never killed. */
export function confirmSshLoopbackForward(entry: ProcessEntry | undefined): boolean {
  if (!entry || !entry.alive) return false;
  if (entry.command !== "ssh" && !entry.command.endsWith("/ssh")) return false;
  const argv = entry.argv;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "-L" && i + 1 < argv.length && LOOPBACK_FORWARD_RE.test(argv[i + 1])) {
      return true;
    }
  }
  return false;
}

// ── the PID registry (AC1/AC2) ─────────────────────────────────────────────

/** Append ONE spawned forward's PID to the harness-owned registry file. Called
 *  at forward bring-up — this is the spawn-time half of the primary,
 *  path-independent reap mechanism. The file persists across SIGKILL, so the
 *  NEXT run's pre-flight sweep can find and reap this run's debris. */
export function registerForward(pid: number, opts: { fs: HarnessFs; registryFile: string }): void {
  opts.fs.appendFileSync(opts.registryFile, `${pid}\n`);
}

/** The result of one forward sweep: which registry PIDs were killed, and which
 *  were deliberately SKIPPED (spared) because they could not be confirmed as a
 *  live ssh loopback forward (recycled, dead, or a user's own forward). */
export interface ForwardSweepResult {
  killed: number[];
  skipped: number[];
}

/** The PRE-FLIGHT forward sweep: read the registry, kill every PID that
 *  `confirmSshLoopbackForward` vouches for, spare every one it does not, then
 *  TRUNCATE the registry (this run adopts a clean slate; its own forwards
 *  re-register as they spawn). Reaping only confirmed PIDs is the load-bearing
 *  safety property (AC2) — a recycled PID is never killed. An absent registry
 *  file is a clean no-op (AC4). */
export function sweepForwards(opts: {
  fs: HarnessFs;
  inspector: ProcessInspector;
  registryFile: string;
}): ForwardSweepResult {
  const killed: number[] = [];
  const skipped: number[] = [];
  if (opts.fs.existsSync(opts.registryFile)) {
    const pids = opts.fs
      .readFileSync(opts.registryFile)
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .map(Number)
      .filter((n) => Number.isInteger(n) && n > 0);
    for (const pid of pids) {
      if (confirmSshLoopbackForward(opts.inspector.inspect(pid))) {
        opts.inspector.kill(pid);
        killed.push(pid);
      } else {
        skipped.push(pid);
      }
    }
    // truncate: this run starts from a clean registry, re-registering its own
    // forwards as they spawn. Debris (killed) and false-positives (skipped,
    // e.g. recycled PIDs) are BOTH dropped from the file — a spared PID is not
    // ours, so it must not be carried forward to be re-examined every run.
    opts.fs.writeFileSync(opts.registryFile, "");
  }
  return { killed, skipped };
}

// ── the authorized_keys strip (AC3, secondary marker filter) ───────────────

/** The throwaway-key comment marker every real-SSH suite mints: `amicode-*-test-*`
 *  (e.g. `amicode-peer-e2e-test-<pid>`, `amicode-attachment-transport-test-<pid>`,
 *  `amicode-attach-switch-latency-test-<pid>`). This is the SECONDARY safety
 *  filter — the PID registry is the primary reap. A line matches only when this
 *  token appears in its trailing key COMMENT field. */
const TEST_KEY_MARKER_RE = /amicode-.*-test-.*/;

/** The result of one authorized_keys strip. */
export interface AuthorizedKeysSweepResult {
  mutated: boolean;
  removedLines: number;
}

/** Strip ONLY the stale `amicode-*-test-*`-commented key lines from
 *  authorized_keys, preserving EVERY other line byte-for-byte — real user
 *  keys, comments, blank lines, forced-command lines, and the original EOF
 *  shape. An absent file, or a file with no test-key lines, is a clean no-op
 *  that neither errors nor mutates (AC4). */
export function sweepAuthorizedKeys(opts: { fs: HarnessFs; authorizedKeysPath: string }): AuthorizedKeysSweepResult {
  if (!opts.fs.existsSync(opts.authorizedKeysPath)) return { mutated: false, removedLines: 0 };
  const content = opts.fs.readFileSync(opts.authorizedKeysPath);
  // Split on \n, KEEPING the trailing-empty-segment structure so we can rebuild
  // the file byte-for-byte (a trailing "\n" yields a final "" segment we keep).
  const segments = content.split("\n");
  const kept: string[] = [];
  let removedLines = 0;
  for (const seg of segments) {
    if (TEST_KEY_MARKER_RE.test(seg)) {
      removedLines++;
      continue;
    }
    kept.push(seg);
  }
  if (removedLines === 0) return { mutated: false, removedLines: 0 };
  opts.fs.writeFileSync(opts.authorizedKeysPath, kept.join("\n"));
  return { mutated: true, removedLines };
}

// ── the combined pre-flight sweep (AC1/AC4) ────────────────────────────────

/** The combined result of a pre-flight sweep. */
export interface PreflightSweepResult {
  forwards: ForwardSweepResult;
  authorizedKeys: AuthorizedKeysSweepResult;
}

/** The single entry point the suites call at PROBE SETUP, BEFORE installing any
 *  new throwaway key — so each run cleans the PREVIOUS run's debris. Runs the
 *  PID-registry forward sweep (primary) and the marker-scoped authorized_keys
 *  strip (secondary). On a machine with zero artifacts — absent/empty registry,
 *  no test-key lines — it is a clean no-op: it neither throws nor mutates
 *  anything (AC4). */
export function preflightSweep(opts: {
  fs: HarnessFs;
  inspector: ProcessInspector;
  registryFile: string;
  authorizedKeysPath: string;
}): PreflightSweepResult {
  return {
    forwards: sweepForwards({ fs: opts.fs, inspector: opts.inspector, registryFile: opts.registryFile }),
    authorizedKeys: sweepAuthorizedKeys({ fs: opts.fs, authorizedKeysPath: opts.authorizedKeysPath }),
  };
}

// ── crash-safe teardown (AC5) ──────────────────────────────────────────────

/** Where signal/exit handlers are registered. The default binding is
 *  `process`; the unit test injects an in-memory sink so a "signal" can be
 *  fired deterministically. */
export interface SignalSink {
  on(signal: string, handler: () => void): void;
}

/** Register SYNCHRONOUS SIGINT/SIGTERM/exit handlers that, on an interactive
 *  interrupt, restore authorized_keys to its original content (only when a
 *  throwaway key was installed this run — `originalAuthorizedKeys` present) and
 *  kill every spawned forward child. This is the SECONDARY defense for the
 *  common Ctrl-C / SIGTERM case; the PID registry is the primary reap that
 *  survives an un-handleable SIGKILL. The handler is idempotent — a SIGINT
 *  followed by the `exit` handler restores/kills at most once. */
export function installTeardownHandlers(opts: {
  signals: SignalSink;
  fs: HarnessFs;
  inspector: ProcessInspector;
  authorizedKeysPath: string;
  /** The authorized_keys content to restore. `undefined` when no throwaway key
   *  was installed this run (the zero-mutation path) — then authorized_keys is
   *  never touched. */
  originalAuthorizedKeys: string | undefined;
  /** The PIDs of forwards this run spawned, to terminate on teardown. */
  spawnedPids: readonly number[];
}): void {
  let torn = false;
  const teardown = () => {
    if (torn) return;
    torn = true;
    if (opts.originalAuthorizedKeys !== undefined) {
      try {
        opts.fs.writeFileSync(opts.authorizedKeysPath, opts.originalAuthorizedKeys);
      } catch {
        /* best-effort synchronous restore */
      }
    }
    for (const pid of opts.spawnedPids) {
      try {
        opts.inspector.kill(pid);
      } catch {
        /* best-effort synchronous kill */
      }
    }
  };
  for (const sig of ["SIGINT", "SIGTERM", "exit"]) {
    opts.signals.on(sig, teardown);
  }
}

// ── default (production) seam bindings ─────────────────────────────────────
//
// The three real-SSH suites call these to get seams wired to the real
// node:fs / process surfaces. The UNIT test never uses them — it injects
// in-memory seams so it needs no real sshd, no real spawns, and never mutates
// the developer's ~/.ssh/authorized_keys.

import {
  appendFileSync as nodeAppendFileSync,
  existsSync as nodeExistsSync,
  mkdirSync as nodeMkdirSync,
  readFileSync as nodeReadFileSync,
  writeFileSync as nodeWriteFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** The harness-owned registry file: `~/.amico/ops/ssh-test-forwards.pids`. The
 *  deliberation named `~/.amico/ops/` — a stable, per-user location that
 *  survives across runs (so a hard-killed run's debris is found next run) and
 *  is never the user's real ssh state. */
export function defaultRegistryFile(): string {
  return join(homedir(), ".amico", "ops", "ssh-test-forwards.pids");
}

/** The user's authorized_keys — the only real ssh-state file the harness ever
 *  touches, and only to strip its own `amicode-*-test-*` lines. */
export function defaultAuthorizedKeysPath(): string {
  return join(homedir(), ".ssh", "authorized_keys");
}

/** A HarnessFs bound to node:fs, ensuring the registry's parent dir exists on
 *  append (the ops dir may not pre-exist on a fresh machine). */
export function nodeHarnessFs(): HarnessFs {
  return {
    existsSync: (p) => nodeExistsSync(p),
    readFileSync: (p) => nodeReadFileSync(p, "utf8"),
    writeFileSync: (p, data) => nodeWriteFileSync(p, data),
    appendFileSync: (p, data) => {
      nodeMkdirSync(dirname(p), { recursive: true });
      nodeAppendFileSync(p, data);
    },
  };
}

/** A ProcessInspector bound to the OS: `ps` for enumeration (command + argv),
 *  `process.kill` for termination. On any `ps` failure it reports the pid as
 *  absent (undefined) — which, via `confirmSshLoopbackForward`, means "never
 *  kill" — safety over completeness. */
export function nodeProcessInspector(): ProcessInspector {
  return {
    inspect: (pid) => {
      let line: string;
      try {
        // `ps -o command= -p <pid>` prints the full command line (argv joined)
        // or exits non-zero when the pid is gone.
        line = execFileSync("ps", ["-o", "command=", "-p", String(pid)], {
          stdio: ["ignore", "pipe", "ignore"],
          timeout: 5000,
        })
          .toString("utf8")
          .trim();
      } catch {
        return undefined; // pid gone (or ps unavailable) -> absent -> never killed
      }
      if (!line) return undefined;
      const argv = line.split(/\s+/);
      return { alive: true, command: argv[0] ?? "", argv };
    },
    kill: (pid) => {
      try {
        process.kill(pid, "SIGTERM");
        return true;
      } catch {
        return false;
      }
    },
  };
}

/** A SignalSink bound to the real process. */
export function nodeSignalSink(): SignalSink {
  return {
    on: (signal, handler) => {
      process.on(signal as NodeJS.Signals, handler);
    },
  };
}

// ── suite-facing convenience: a probe guard + a registering spawn wrapper ──
//
// These compose the pieces above into the two calls a real-SSH suite makes:
// one pre-flight sweep at module load (BEFORE any throwaway key is installed),
// and a spawn wrapper that registers each forward's PID at bring-up. Neither
// changes production forward bring-up behavior — the suites still call
// bringUpSshAttachment exactly as before; they only pass a wrapping spawnFn.

import { spawn as nodeSpawn } from "node:child_process";
import { mkdtempSync as nodeMkdtempSync, rmSync as nodeRmSync } from "node:fs";
import { tmpdir as nodeTmpdir } from "node:os";
import { atomicWriteFileSync } from "../../src/amicode_service/credentials";

let preflightRan = false;

/** Run the pre-flight sweep ONCE per test process, wired to the real node
 *  seams. Idempotent — safe to call from multiple suites' module scope; only
 *  the first call sweeps. MUST be invoked BEFORE a suite's SSH_READY probe
 *  installs any throwaway key, so each run cleans the PREVIOUS run's debris
 *  and never its own. Returns the sweep result (empty on subsequent calls). */
export function runPreflightSweepOnce(): PreflightSweepResult {
  if (preflightRan) {
    return { forwards: { killed: [], skipped: [] }, authorizedKeys: { mutated: false, removedLines: 0 } };
  }
  preflightRan = true;
  try {
    return preflightSweep({
      fs: nodeHarnessFs(),
      inspector: nodeProcessInspector(),
      registryFile: defaultRegistryFile(),
      authorizedKeysPath: defaultAuthorizedKeysPath(),
    });
  } catch {
    // A sweep failure must NEVER break the suite it protects — degrade to a
    // no-op result (the honest-skip / test behavior is unchanged).
    return { forwards: { killed: [], skipped: [] }, authorizedKeys: { mutated: false, removedLines: 0 } };
  }
}

/** A `spawn`-compatible wrapper that, after delegating to the real spawn (or an
 *  injected inner spawn), records the spawned child's PID in the harness
 *  registry — the spawn-time half of the primary reap. Pass the RESULT as the
 *  `spawnFn` to bringUpSshAttachment: production bring-up is unchanged (same
 *  argv, same child), the wrapper only appends the PID at the moment of
 *  spawn. */
export function registeringSpawn(inner: typeof nodeSpawn = nodeSpawn): typeof nodeSpawn {
  const fs = nodeHarnessFs();
  const registryFile = defaultRegistryFile();
  const wrapped = ((command: string, args?: readonly string[], options?: unknown) => {
    const child = (inner as (c: string, a?: readonly string[], o?: unknown) => ReturnType<typeof nodeSpawn>)(
      command,
      args,
      options,
    );
    if (typeof child.pid === "number") {
      try {
        registerForward(child.pid, { fs, registryFile });
      } catch {
        /* best-effort — never break a bring-up over registry bookkeeping */
      }
    }
    return child;
  }) as unknown as typeof nodeSpawn;
  return wrapped;
}

// ── shared loopback-SSH readiness probe (#1634 Slice 2) ────────────────────
//
// The three real-SSH suites (fleet_peer_e2e, amicode_service_attachment_
// transport, amicode_service_attach_switch_latency) each carried a near-
// identical `SSH_READY` IIFE that, at module load, decides whether a loopback
// sshd the current OS user can authenticate to is reachable — preferring a
// ZERO-MUTATION path (the default identity already connects → `identityArgs:
// []`, no throwaway key installed, no `-i` marker), and only otherwise
// generating a THROWAWAY ed25519 key, atomically appending its public half to
// ~/.ssh/authorized_keys, and verifying it connects (rolling back byte-for-
// byte if it does not). Slice 2 de-duplicates that logic onto this one
// function; the suites call it with a per-suite label + key-file names.
//
// Unlike the sweep/teardown above, this probe LEGITIMATELY touches the real
// fs/ssh at module load (it must — readiness is a property of the machine),
// so it is NOT injected-seam style. It uses the same node:fs / node:child_
// process / atomicWriteFileSync surfaces the suites used inline before.

/** The throwaway ed25519 key a probe installed to reach `ready` — present
 *  ONLY on the fallback path. A suite's afterAll (and the crash-safe teardown)
 *  uses this to remove EXACTLY that mutation, byte-for-byte, every run. */
export interface Throwaway {
  keyDir: string;
  originalAuthorizedKeys: string;
}

/** The result of the loopback-SSH readiness probe. */
export interface SshReadiness {
  ready: boolean;
  reason?: string;
  /** Extra ssh argv a suite's forwards must pass to authenticate: empty for
   *  the zero-mutation path; `-i <throwaway key> -o IdentitiesOnly=yes` for
   *  the fallback path. */
  identityArgs: string[];
  /** Present ONLY when a throwaway key was installed to reach `ready`. */
  throwaway?: Throwaway;
}

/** The per-suite parameters the shared probe threads into its otherwise
 *  identical logic: the tmpdir prefix, the throwaway key filename, the
 *  `ssh-keygen -C` comment (which MUST carry the `amicode-*-test-*` marker so
 *  the authorized_keys sweep can strip it), and the reason string emitted when
 *  a freshly-installed key still fails to connect. */
export interface SshProbeParams {
  keyDirPrefix: string;
  keyFileName: string;
  keyComment: string;
  verifyFailedReason: string;
}

/** The ssh argv every probe/forward passes so it never consults (or depends
 *  on) the user's real ~/.ssh/config, never prompts, and never touches the
 *  user's real known_hosts. Exported so the suites' forwards reuse it verbatim
 *  (they spread `[...sshProbeBaseArgs(), ...SSH_READY.identityArgs]`). */
export function sshProbeBaseArgs(): string[] {
  return [
    "-F", "/dev/null", // never consult (or depend on) the user's real ~/.ssh/config
    "-o", "BatchMode=yes", // never prompt — an outcome, not a hang
    "-o", "ConnectTimeout=3",
    "-o", "StrictHostKeyChecking=no", // a throwaway loopback hop; nothing security-sensitive rides this
    "-o", "UserKnownHostsFile=/dev/null", // never touch the user's real known_hosts
  ];
}

/** True iff `ssh <base args> <identityArgs> 127.0.0.1 true` succeeds — the one
 *  question the readiness probe asks the machine. */
export function canConnectLoopback(identityArgs: readonly string[]): boolean {
  try {
    execFileSync("ssh", [...sshProbeBaseArgs(), ...identityArgs, "127.0.0.1", "true"], {
      stdio: "ignore",
      timeout: 5000,
    });
    return true;
  } catch {
    return false;
  }
}

/** The shared, synchronous loopback-SSH readiness probe (#1634 Slice 2) — the
 *  one implementation the three real-SSH suites now call in lieu of their own
 *  `SSH_READY` IIFE. Behavior is byte-for-byte the pre-Slice-2 per-suite logic:
 *  the zero-mutation path first (`identityArgs: []`), then a throwaway-key
 *  fallback with byte-for-byte rollback on any failure, then the honest not-
 *  ready result carrying a printed reason. The only per-suite variation is the
 *  `SshProbeParams` (key-file names, marker comment, verify-failed reason). */
export function probeSshReadiness(params: SshProbeParams): SshReadiness {
  const authorizedKeysPath = defaultAuthorizedKeysPath();
  if (canConnectLoopback([])) {
    return { ready: true, identityArgs: [] }; // the simpler, zero-mutation path — prefer it
  }
  let tmpDir: string | undefined;
  let originalAuthorizedKeys: string | undefined;
  try {
    tmpDir = nodeMkdtempSync(join(nodeTmpdir(), params.keyDirPrefix));
    const keyPath = join(tmpDir, params.keyFileName);
    execFileSync(
      "ssh-keygen",
      ["-t", "ed25519", "-N", "", "-C", params.keyComment, "-f", keyPath],
      { stdio: "ignore", timeout: 10_000 },
    );
    const pubKey = nodeReadFileSync(`${keyPath}.pub`, "utf8").trim();
    originalAuthorizedKeys = nodeExistsSync(authorizedKeysPath)
      ? nodeReadFileSync(authorizedKeysPath, "utf8")
      : "";
    const sep = originalAuthorizedKeys === "" || originalAuthorizedKeys.endsWith("\n") ? "" : "\n";
    atomicWriteFileSync(authorizedKeysPath, `${originalAuthorizedKeys}${sep}${pubKey}\n`);
    const identityArgs = ["-i", keyPath, "-o", "IdentitiesOnly=yes"];
    if (canConnectLoopback(identityArgs)) {
      return { ready: true, identityArgs, throwaway: { keyDir: tmpDir, originalAuthorizedKeys } };
    }
    // the freshly-installed key STILL didn't connect — roll back before
    // reporting not-ready; leave zero trace.
    atomicWriteFileSync(authorizedKeysPath, originalAuthorizedKeys);
    nodeRmSync(tmpDir, { recursive: true, force: true });
    return { ready: false, identityArgs: [], reason: params.verifyFailedReason };
  } catch (e) {
    if (originalAuthorizedKeys !== undefined) {
      try {
        atomicWriteFileSync(authorizedKeysPath, originalAuthorizedKeys);
      } catch {
        /* best-effort rollback */
      }
    }
    if (tmpDir) {
      try {
        nodeRmSync(tmpDir, { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
    }
    return { ready: false, identityArgs: [], reason: `loopback ssh probe failed: ${e instanceof Error ? e.message : String(e)}` };
  }
}
