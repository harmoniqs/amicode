// ssh_test_harness.test.ts — #1634 Slice 1: the focused unit test for the
// real-SSH test-leak sweep/teardown DECISION LOGIC.
//
// This is the deterministic corrector for the shared test-support harness
// (test/support/ssh_test_harness.ts): it exercises the PID-registry sweep, the
// authorized_keys strip, and the crash-safe teardown against INJECTED seams —
// an injectable fs interface and an injectable process enumerator/killer — so
// the logic runs with NO real sshd, NO real spawns, and NO mutation of the
// developer's ~/.ssh/authorized_keys.
//
// Every acceptance criterion on #1634 that is a DECISION (not an
// end-to-end-with-real-ssh measurement) is proven here:
//   AC2 — a registry PID is killed ONLY after confirming it is a live `ssh`
//         process with a loopback `-L 127.0.0.1:…:127.0.0.1:…` forward; a
//         recycled PID (now a non-ssh process) is never killed.
//   AC3 — the authorized_keys strip removes only `amicode-*-test-*` comment
//         lines and preserves every other line byte-for-byte (mixed fixture).
//   AC4 — the sweep is a no-op on zero artifacts (empty/absent registry, no
//         test key lines): neither errors nor mutates.
//   AC1 — after a simulated hard-kill, the next run's pre-flight sweep leaves
//         zero registry-confirmed live ssh loopback forwards and zero test
//         key lines (the two counts driven to 0).
//   AC5 — a SIGINT/SIGTERM delivered mid-run restores authorized_keys and
//         terminates every spawned child (synchronous handlers).
import { describe, expect, it } from "vitest";

import {
  type HarnessFs,
  type ProcessEntry,
  type ProcessInspector,
  confirmSshLoopbackForward,
  registerForward,
  sweepForwards,
  sweepAuthorizedKeys,
  preflightSweep,
  installTeardownHandlers,
  type SignalSink,
  defaultRegistryFile,
  defaultAuthorizedKeysPath,
  nodeProcessInspector,
} from "./support/ssh_test_harness";
import { homedir } from "node:os";
import { join } from "node:path";

// ── an in-memory HarnessFs seam ────────────────────────────────────────────
function memFs(seed: Record<string, string> = {}): HarnessFs & { files: Record<string, string | undefined> } {
  const files: Record<string, string | undefined> = { ...seed };
  return {
    files,
    existsSync: (p: string) => files[p] !== undefined,
    readFileSync: (p: string) => {
      const v = files[p];
      if (v === undefined) throw Object.assign(new Error(`ENOENT: ${p}`), { code: "ENOENT" });
      return v;
    },
    writeFileSync: (p: string, data: string) => {
      files[p] = data;
    },
    appendFileSync: (p: string, data: string) => {
      files[p] = (files[p] ?? "") + data;
    },
  };
}

// ── an in-memory ProcessInspector seam ─────────────────────────────────────
function memInspector(entries: Record<number, ProcessEntry | undefined>): ProcessInspector & { killed: number[] } {
  const killed: number[] = [];
  return {
    killed,
    inspect: (pid: number) => entries[pid],
    kill: (pid: number) => {
      killed.push(pid);
      return true;
    },
  };
}

// A canonical live ssh loopback forward process entry.
const sshForward: ProcessEntry = {
  alive: true,
  command: "ssh",
  argv: ["ssh", "-N", "-L", "127.0.0.1:41999:127.0.0.1:43117", "user@127.0.0.1"],
};

describe("confirmSshLoopbackForward — the kill-decision predicate (#1634 AC2)", () => {
  it("confirms a live ssh process carrying a loopback -L 127.0.0.1:…:127.0.0.1:… forward", () => {
    expect(confirmSshLoopbackForward(sshForward)).toBe(true);
  });

  it("REFUSES a recycled PID now belonging to an unrelated (non-ssh) process — never killed", () => {
    const recycled: ProcessEntry = { alive: true, command: "node", argv: ["node", "server.js"] };
    expect(confirmSshLoopbackForward(recycled)).toBe(false);
  });

  it("REFUSES a dead PID (the process already exited)", () => {
    expect(confirmSshLoopbackForward({ alive: false, command: "ssh", argv: sshForward.argv })).toBe(false);
    expect(confirmSshLoopbackForward(undefined)).toBe(false);
  });

  it("REFUSES an ssh process WITHOUT a loopback -L forward (e.g. a plain interactive ssh)", () => {
    expect(confirmSshLoopbackForward({ alive: true, command: "ssh", argv: ["ssh", "user@host"] })).toBe(false);
  });

  it("REFUSES an ssh -L forward that is NOT loopback-to-loopback (a user's own remote forward)", () => {
    expect(
      confirmSshLoopbackForward({
        alive: true,
        command: "ssh",
        argv: ["ssh", "-N", "-L", "0.0.0.0:8080:10.0.0.5:80", "gateway"],
      }),
    ).toBe(false);
  });
});

const REGISTRY = "/reg/forwards.pids";

describe("registerForward + sweepForwards — the PID-registry reap (#1634 AC1/AC2)", () => {
  it("registerForward appends each spawned PID as its own line", () => {
    const fs = memFs();
    registerForward(1111, { fs, registryFile: REGISTRY });
    registerForward(2222, { fs, registryFile: REGISTRY });
    expect(fs.files[REGISTRY]).toBe("1111\n2222\n");
  });

  it("kills every registry PID confirmed as a live ssh loopback forward, then truncates the registry (AC1: count -> 0)", () => {
    const fs = memFs({ [REGISTRY]: "1111\n2222\n" });
    const inspector = memInspector({ 1111: sshForward, 2222: sshForward });
    const result = sweepForwards({ fs, inspector, registryFile: REGISTRY });
    expect(inspector.killed.sort()).toEqual([1111, 2222]);
    expect(result.killed.sort()).toEqual([1111, 2222]);
    // the registry is truncated (empty) after the sweep — no stale debris carried forward
    expect(fs.files[REGISTRY]).toBe("");
    // AC1 measurement: zero registry PIDs remain confirmable as live ssh loopback forwards
    const remaining = (fs.files[REGISTRY] ?? "")
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .filter((l) => confirmSshLoopbackForward(inspector.inspect(Number(l))));
    expect(remaining.length).toBe(0);
  });

  it("NEVER kills a recycled PID now belonging to a non-ssh process (AC2 — safety over completeness)", () => {
    const fs = memFs({ [REGISTRY]: "1111\n2222\n" });
    // 2222 has been recycled to a node process; 1111 is still our ssh forward.
    const inspector = memInspector({
      1111: sshForward,
      2222: { alive: true, command: "node", argv: ["node", "unrelated.js"] },
    });
    const result = sweepForwards({ fs, inspector, registryFile: REGISTRY });
    expect(inspector.killed).toEqual([1111]);
    expect(result.killed).toEqual([1111]);
    expect(result.skipped).toContain(2222); // deliberately spared
  });
});

const AUTH_KEYS = "/home/u/.ssh/authorized_keys";

describe("sweepAuthorizedKeys — the marker-scoped strip (#1634 AC3)", () => {
  it("removes ONLY amicode-*-test-* comment lines; preserves every other line byte-for-byte (mixed fixture)", () => {
    // A realistic mixed authorized_keys: two real user keys (one with a
    // no-newline-at-EOF quirk we must preserve), a blank line, a comment line,
    // and ONE stale amicode test key from a crashed run.
    const original =
      "ssh-ed25519 AAAAreal1 user@laptop\n" +
      "# my own comment line\n" +
      "\n" +
      "ssh-ed25519 AAAAtestkey amicode-attachment-transport-test-49213\n" +
      'command="/bin/true" ssh-rsa AAAAreal2 backup@nas\n';
    const fs = memFs({ [AUTH_KEYS]: original });
    const result = sweepAuthorizedKeys({ fs, authorizedKeysPath: AUTH_KEYS });
    expect(result.mutated).toBe(true);
    expect(result.removedLines).toBe(1);
    expect(fs.files[AUTH_KEYS]).toBe(
      "ssh-ed25519 AAAAreal1 user@laptop\n" +
        "# my own comment line\n" +
        "\n" +
        'command="/bin/true" ssh-rsa AAAAreal2 backup@nas\n',
    );
  });

  it("strips every amicode-*-test-* variant the three suites mint (peer-e2e, attachment-transport, attach-switch-latency)", () => {
    const original =
      "ssh-ed25519 AAAAreal keep@me\n" +
      "ssh-ed25519 AAAAa amicode-peer-e2e-test-1\n" +
      "ssh-ed25519 AAAAb amicode-attachment-transport-test-2\n" +
      "ssh-ed25519 AAAAc amicode-attach-switch-latency-test-3\n";
    const fs = memFs({ [AUTH_KEYS]: original });
    const result = sweepAuthorizedKeys({ fs, authorizedKeysPath: AUTH_KEYS });
    expect(result.removedLines).toBe(3);
    expect(fs.files[AUTH_KEYS]).toBe("ssh-ed25519 AAAAreal keep@me\n");
  });
});

describe("preflightSweep — combined forward + authorized_keys sweep, no-op on zero artifacts (#1634 AC1/AC4)", () => {
  it("is a NO-OP on a machine with zero artifacts: absent registry + absent authorized_keys neither errors nor mutates", () => {
    const fs = memFs(); // nothing on disk
    const inspector = memInspector({});
    let result!: ReturnType<typeof preflightSweep>;
    expect(() => {
      result = preflightSweep({ fs, inspector, registryFile: REGISTRY, authorizedKeysPath: AUTH_KEYS });
    }).not.toThrow();
    expect(result.forwards.killed).toEqual([]);
    expect(result.authorizedKeys.mutated).toBe(false);
    expect(inspector.killed).toEqual([]);
    // no file was created or written
    expect(fs.files[REGISTRY]).toBeUndefined();
    expect(fs.files[AUTH_KEYS]).toBeUndefined();
  });

  it("is a NO-OP when the registry is EMPTY and authorized_keys has no test-key lines (present but clean)", () => {
    const cleanKeys = "ssh-ed25519 AAAAreal only@me\n";
    const fs = memFs({ [REGISTRY]: "", [AUTH_KEYS]: cleanKeys });
    const inspector = memInspector({});
    const result = preflightSweep({ fs, inspector, registryFile: REGISTRY, authorizedKeysPath: AUTH_KEYS });
    expect(result.forwards.killed).toEqual([]);
    expect(result.authorizedKeys.mutated).toBe(false);
    expect(fs.files[AUTH_KEYS]).toBe(cleanKeys); // byte-for-byte untouched
  });

  it("after a simulated hard-kill, the next run's preflight leaves zero live ssh forwards and zero test keys (AC1)", () => {
    // Debris from a hard-killed prior run: two registered ssh forwards still
    // alive, and one stale test key in authorized_keys.
    const fs = memFs({
      [REGISTRY]: "5555\n6666\n",
      [AUTH_KEYS]: "ssh-ed25519 AAAAreal keep@me\nssh-ed25519 AAAAtest amicode-peer-e2e-test-999\n",
    });
    const inspector = memInspector({ 5555: sshForward, 6666: sshForward });
    const result = preflightSweep({ fs, inspector, registryFile: REGISTRY, authorizedKeysPath: AUTH_KEYS });
    expect(result.forwards.killed.sort()).toEqual([5555, 6666]);
    // AC1 measurement — orphaned_test_forwards_after_next_run == 0:
    const orphaned = (fs.files[REGISTRY] ?? "")
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .filter((l) => confirmSshLoopbackForward(inspector.inspect(Number(l))));
    expect(orphaned.length).toBe(0);
    // AC1 measurement — zero amicode-*-test-* lines remain:
    expect(fs.files[AUTH_KEYS]).toBe("ssh-ed25519 AAAAreal keep@me\n");
  });
});

// ── an in-memory SignalSink seam ───────────────────────────────────────────
function memSignals(): SignalSink & { fire(sig: string): void; handlers: Record<string, Array<() => void>> } {
  const handlers: Record<string, Array<() => void>> = {};
  return {
    handlers,
    on: (signal: string, handler: () => void) => {
      (handlers[signal] ??= []).push(handler);
    },
    fire: (sig: string) => {
      for (const h of handlers[sig] ?? []) h();
    },
  };
}

describe("installTeardownHandlers — crash-safe SIGINT/SIGTERM/exit restore + kill (#1634 AC5)", () => {
  it("registers handlers for SIGINT, SIGTERM, and exit", () => {
    const signals = memSignals();
    installTeardownHandlers({
      signals,
      fs: memFs(),
      inspector: memInspector({}),
      authorizedKeysPath: AUTH_KEYS,
      originalAuthorizedKeys: "orig\n",
      spawnedPids: [],
    });
    expect(Object.keys(signals.handlers).sort()).toEqual(["SIGINT", "SIGTERM", "exit"]);
  });

  it("on SIGINT, synchronously restores authorized_keys to its ORIGINAL content and kills every spawned child", () => {
    const signals = memSignals();
    const original = "ssh-ed25519 AAAAreal keep@me\n";
    // authorized_keys currently carries a throwaway test key this run appended:
    const fs = memFs({ [AUTH_KEYS]: original + "ssh-ed25519 AAAAtest amicode-peer-e2e-test-1\n" });
    const inspector = memInspector({ 7777: sshForward, 8888: sshForward });
    installTeardownHandlers({
      signals,
      fs,
      inspector,
      authorizedKeysPath: AUTH_KEYS,
      originalAuthorizedKeys: original,
      spawnedPids: [7777, 8888],
    });
    signals.fire("SIGINT");
    expect(fs.files[AUTH_KEYS]).toBe(original); // byte-for-byte original restored
    expect(inspector.killed.sort()).toEqual([7777, 8888]); // every spawned child terminated
  });

  it("on SIGTERM, likewise restores authorized_keys and kills every spawned child", () => {
    const signals = memSignals();
    const original = "";
    const fs = memFs({ [AUTH_KEYS]: "ssh-ed25519 AAAAtest amicode-attach-switch-latency-test-2\n" });
    const inspector = memInspector({ 9999: sshForward });
    installTeardownHandlers({
      signals,
      fs,
      inspector,
      authorizedKeysPath: AUTH_KEYS,
      originalAuthorizedKeys: original,
      spawnedPids: [9999],
    });
    signals.fire("SIGTERM");
    expect(fs.files[AUTH_KEYS]).toBe(original);
    expect(inspector.killed).toEqual([9999]);
  });

  it("with no throwaway key installed (originalAuthorizedKeys undefined), teardown still kills children without touching authorized_keys", () => {
    const signals = memSignals();
    const fs = memFs(); // authorized_keys never written — the zero-mutation path
    const inspector = memInspector({ 1234: sshForward });
    installTeardownHandlers({
      signals,
      fs,
      inspector,
      authorizedKeysPath: AUTH_KEYS,
      originalAuthorizedKeys: undefined,
      spawnedPids: [1234],
    });
    signals.fire("SIGTERM");
    expect(inspector.killed).toEqual([1234]);
    expect(fs.files[AUTH_KEYS]).toBeUndefined(); // authorized_keys untouched
  });
});

describe("default (production) seam bindings — honest wiring (#1634)", () => {
  it("the registry lives at ~/.amico/ops/ssh-test-forwards.pids (survives runs, never the user's real ssh state)", () => {
    expect(defaultRegistryFile()).toBe(join(homedir(), ".amico", "ops", "ssh-test-forwards.pids"));
  });

  it("authorized_keys is the only real ssh-state file the harness targets", () => {
    expect(defaultAuthorizedKeysPath()).toBe(join(homedir(), ".ssh", "authorized_keys"));
  });

  it("the node inspector reports a definitely-absent pid as undefined -> confirmSshLoopbackForward false -> never killed (safety over completeness)", () => {
    const inspector = nodeProcessInspector();
    // pid 2^31-1 is astronomically unlikely to exist; ps exits non-zero -> undefined.
    const entry = inspector.inspect(2147483646);
    expect(entry).toBeUndefined();
    expect(confirmSshLoopbackForward(entry)).toBe(false);
  });
});
