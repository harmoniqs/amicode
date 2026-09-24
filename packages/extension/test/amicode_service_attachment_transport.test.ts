// amicode_service_attachment_transport.test.ts — #1343 (ADR 0027 §6-7, Slice
// 3): per-attachment transport + credential, SSH-default, engine-reachable.
//
// Three groups:
//  - D9 roaming-aware default (pure, no network) — capabilities[] -> ssh/
//    tailscale, composed with the EXISTING resolveFleetTransportKind (the
//    no-cross-provider-fallback law stays THEIRS, never reimplemented here).
//  - providerForAttachment (pure construction, no network) — the per-target
//    FleetTransportProvider wiring, parameterized PER ATTACHMENT (not the
//    hub's one persistent tunnel).
//  - the attachment credential store (filesystem only, no network) — the
//    per-target keyed generalization of hub_credential.ts's single-hub
//    shape (D10a).
//
// A FOURTH group — real SSH-default per-attachment transport + credential
// injection, the `attach_over_real_transport` / `attach_injects_client_
// credential` acceptance criteria — needs an actual loopback sshd the
// current user can authenticate to. Gated behind a synchronous, module-scope
// readiness probe (SSH_READY, below): it tries the CURRENT identity/agent
// first (zero mutation); only if that fails does it generate a THROWAWAY
// keypair, atomically append it to ~/.ssh/authorized_keys, and verify it
// actually connects — rolling back immediately if it doesn't. When ready via
// the throwaway path, the block's own afterAll removes exactly that
// appended line (restoring ~/.ssh/authorized_keys byte-for-byte) and deletes
// the generated keypair — every run, success or failure. When NOT ready at
// all (no sshd on 127.0.0.1:22, or ssh-keygen missing, or authorized_keys
// isn't writable), the whole block honestly `describe.skip`s with a printed
// reason — never a fake pass, never a hard failure on a machine without
// loopback SSH.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import * as http from "node:http";
import { createServer as createNetServer, type AddressInfo } from "node:net";
import { homedir, tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import type { Readable } from "node:stream";
import { randomBytes } from "node:crypto";

import { atomicWriteFileSync } from "../src/amicode_service/credentials";
import { hubUpstreamAuthHeader } from "../src/amicode_service/hub_credential";
import {
  createSshProvider,
  resolveFleetTransportKind,
} from "../src/amicode_service/fleet_transport";
import {
  attachmentForwardArgs,
  bringUpSshAttachment,
  defaultTransportSettingForCapabilities,
  providerForAttachment,
  resolveAttachmentTransportKind,
  type AttachmentTarget,
  type AttachmentTransportHandle,
} from "../src/amicode_service/attachment_transport";
import {
  attachmentUpstreamAuthHeader,
  clearAttachmentCredential,
  readAttachmentCredential,
  writeAttachmentCredential,
} from "../src/amicode_service/attachment_credential";

// ── D9 — roaming-aware transport default (pure, no network) ────────────────

describe("D9 — roaming-aware transport default (pure, no network)", () => {
  it("no `roaming` capability -> ssh (the universal floor, zero tailscale required)", () => {
    expect(defaultTransportSettingForCapabilities([])).toBe("ssh");
    expect(defaultTransportSettingForCapabilities(["compute"])).toBe("ssh");
    expect(defaultTransportSettingForCapabilities(["serving"])).toBe("ssh");
  });

  it("`roaming` capability -> tailscale", () => {
    expect(defaultTransportSettingForCapabilities(["roaming"])).toBe("tailscale");
    expect(defaultTransportSettingForCapabilities(["compute", "roaming"])).toBe("tailscale");
  });

  it("composes with the EXISTING resolveFleetTransportKind — the setting is DERIVED, the no-fallback law is not reimplemented", () => {
    expect(resolveAttachmentTransportKind({ capabilities: [] })).toEqual({ ok: true, kind: "ssh" });
    expect(resolveAttachmentTransportKind({ capabilities: ["roaming"] })).toEqual({ ok: true, kind: "tailscale" });
    // same answer resolveFleetTransportKind itself would give for that setting —
    // proving this is composition, not a parallel reimplementation.
    expect(resolveAttachmentTransportKind({ capabilities: ["roaming"] })).toEqual(
      resolveFleetTransportKind({ setting: "tailscale" }),
    );
  });

  it("a fleet with ZERO tailscale still attaches over ssh — a roaming peer with tailscale disabled is a NAMED not-ok, never a silent ssh substitution", () => {
    const sel = resolveAttachmentTransportKind({ capabilities: ["roaming"], disabled: ["tailscale"] });
    expect(sel.ok).toBe(false);
    if (!sel.ok) expect(sel.reason).toContain("tailscale-disabled");
  });

  it("a non-roaming peer needs ZERO tailscale registered to attach (available=['ssh'] only)", () => {
    expect(resolveAttachmentTransportKind({ capabilities: [], available: ["ssh"] })).toEqual({ ok: true, kind: "ssh" });
  });
});

// ── providerForAttachment — parameterized PER TARGET ────────────────────────

describe("providerForAttachment — per-target FleetTransportProvider construction (not the hub's one persistent tunnel)", () => {
  it("builds an ssh-kind provider whose resolveBaseUrl is the INJECTED per-target resolver", () => {
    const target: AttachmentTarget = { sshAlias: "peer-alias", transport: "ssh", machine_id: "m1" };
    const provider = providerForAttachment(target, () => "http://127.0.0.1:4100");
    expect(provider.kind).toBe("ssh");
    expect(provider.resolveBaseUrl()?.toString()).toBe("http://127.0.0.1:4100/");
  });

  it("two DIFFERENT targets get two INDEPENDENT providers — per-attachment, never a shared singleton", () => {
    const a = providerForAttachment({ sshAlias: "a", transport: "ssh", machine_id: "m-a" }, () => "http://127.0.0.1:4101");
    const b = providerForAttachment({ sshAlias: "b", transport: "tailscale", machine_id: "m-b" }, () => "http://127.0.0.1:4102");
    expect(a.kind).toBe("ssh");
    expect(b.kind).toBe("tailscale");
    expect(a.resolveBaseUrl()?.toString()).not.toBe(b.resolveBaseUrl()?.toString());
  });

  it("an unknown per-target transport hint binds NO url — the honest not-ok, never a silent ssh substitution", () => {
    const target: AttachmentTarget = { sshAlias: "peer-alias", transport: "carrier-pigeon", machine_id: "m1" };
    const provider = providerForAttachment(target, () => "http://127.0.0.1:4100");
    expect(provider.resolveBaseUrl()).toBeUndefined();
  });

  it("transport:\"ssh\" is the SAME primitive createSshProvider constructs directly — providerForAttachment does not fork the abstraction", () => {
    const direct = createSshProvider({ resolveUrl: () => "http://127.0.0.1:6100" });
    const viaAttachment = providerForAttachment({ sshAlias: "x", transport: "ssh", machine_id: "m" }, () => "http://127.0.0.1:6100");
    expect(viaAttachment.kind).toBe(direct.kind);
    expect(viaAttachment.resolveBaseUrl()?.toString()).toBe(direct.resolveBaseUrl()?.toString());
  });
});

// ── attachment forward args — the per-attachment ssh -L argv shape ──────────

describe("attachmentForwardArgs — the per-attachment ssh -L forward argv (independent local/remote ports)", () => {
  it("mirrors sshForwardArgs' option set byte-for-byte, generalized to independent local/remote ports", () => {
    const args = attachmentForwardArgs({ alias: "peer-alias", localPort: 5100, remotePort: 5200 });
    expect(args).toEqual([
      "-N",
      "-o", "ExitOnForwardFailure=yes",
      "-o", "ServerAliveInterval=15",
      "-o", "ServerAliveCountMax=2",
      "-o", "TCPKeepAlive=yes",
      "-L", "127.0.0.1:5100:127.0.0.1:5200",
      "peer-alias",
    ]);
  });

  it("threads extraSshOptions BEFORE -L/alias — the CI-safe/throwaway-identity seam", () => {
    const args = attachmentForwardArgs({
      alias: "peer-alias",
      localPort: 5100,
      remotePort: 5200,
      extraSshOptions: ["-i", "/tmp/key", "-o", "IdentitiesOnly=yes"],
    });
    expect(args).toEqual([
      "-N",
      "-o", "ExitOnForwardFailure=yes",
      "-o", "ServerAliveInterval=15",
      "-o", "ServerAliveCountMax=2",
      "-o", "TCPKeepAlive=yes",
      "-i", "/tmp/key",
      "-o", "IdentitiesOnly=yes",
      "-L", "127.0.0.1:5100:127.0.0.1:5200",
      "peer-alias",
    ]);
  });
});

// ── the attachment credential store (filesystem only, no network) ──────────

describe("attachment credential store (#1343, ADR 0027 §7/D10a) — per-target keyed, generalizing hub_credential.ts", () => {
  let dir: string;
  let credFile: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "amicode-attach-cred-unit-"));
    credFile = join(dir, "attachment-credentials.json");
  });
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("absent file -> reason 'absent' for any machine_id, never a throw", () => {
    expect(readAttachmentCredential("peer-a", { credentialFile: credFile })).toEqual({ ok: false, reason: "absent" });
  });

  it("round-trips ONE target's credential; an unrelated second target stays absent", () => {
    writeAttachmentCredential("peer-a", { baseUrl: "http://127.0.0.1:9001", token: "tok-a" }, { credentialFile: credFile });
    expect(readAttachmentCredential("peer-a", { credentialFile: credFile })).toEqual({
      ok: true,
      credential: { baseUrl: "http://127.0.0.1:9001", token: "tok-a" },
    });
    expect(readAttachmentCredential("peer-b", { credentialFile: credFile })).toEqual({ ok: false, reason: "absent" });
  });

  it("a SECOND target's write never disturbs the FIRST's entry — single-writer-per-key, generalized to N keys", () => {
    writeAttachmentCredential("peer-a", { baseUrl: "http://127.0.0.1:9001", token: "tok-a" }, { credentialFile: credFile });
    writeAttachmentCredential("peer-b", { baseUrl: "http://127.0.0.1:9002", token: "tok-b" }, { credentialFile: credFile });
    expect(readAttachmentCredential("peer-a", { credentialFile: credFile })).toEqual({
      ok: true,
      credential: { baseUrl: "http://127.0.0.1:9001", token: "tok-a" },
    });
    expect(readAttachmentCredential("peer-b", { credentialFile: credFile })).toEqual({
      ok: true,
      credential: { baseUrl: "http://127.0.0.1:9002", token: "tok-b" },
    });
  });

  it("clearAttachmentCredential removes ONE target's entry, leaves others intact; an absent key is a no-op", () => {
    writeAttachmentCredential("peer-a", { baseUrl: "http://127.0.0.1:9001", token: "tok-a" }, { credentialFile: credFile });
    writeAttachmentCredential("peer-b", { baseUrl: "http://127.0.0.1:9002", token: "tok-b" }, { credentialFile: credFile });
    clearAttachmentCredential("peer-a", { credentialFile: credFile });
    expect(readAttachmentCredential("peer-a", { credentialFile: credFile })).toEqual({ ok: false, reason: "absent" });
    expect(readAttachmentCredential("peer-b", { credentialFile: credFile })).toEqual({
      ok: true,
      credential: { baseUrl: "http://127.0.0.1:9002", token: "tok-b" },
    });
    expect(() => clearAttachmentCredential("peer-nonexistent", { credentialFile: credFile })).not.toThrow();
  });

  it("an entry missing its token reads as 'incomplete' — never a throw, never a fabricated credential", () => {
    writeFileSync(credFile, JSON.stringify({ store_version: 1, peers: { "peer-a": { base_url: "http://x" } } }));
    expect(readAttachmentCredential("peer-a", { credentialFile: credFile })).toEqual({ ok: false, reason: "incomplete" });
  });

  it("an entry that isn't an object reads as 'malformed' — never a throw", () => {
    writeFileSync(credFile, JSON.stringify({ store_version: 1, peers: { "peer-a": "not-an-object" } }));
    expect(readAttachmentCredential("peer-a", { credentialFile: credFile })).toEqual({ ok: false, reason: "malformed" });
  });

  it("attachmentUpstreamAuthHeader mirrors hubUpstreamAuthHeader's Basic idiom byte-for-byte — one auth convention, hub hop and peer hop alike", () => {
    expect(attachmentUpstreamAuthHeader("secret-tok")).toBe(hubUpstreamAuthHeader("secret-tok"));
  });
});

// ── bringUpSshAttachment's honest-failure path (no real ssh needed) ────────
//
// A fake spawnFn stands in for `ssh` itself exiting before the forward ever
// answers anything (bad alias, refused connection, whatever) — this proves
// bringUpSshAttachment REJECTS with the ssh stderr attached rather than ever
// fabricating a success. It deliberately does NOT stand in for a WORKING
// transport (that would be exactly the forbidden move) — it only proves the
// failure path is honest, and needs no network or real ssh binary at all.
function fakeExitingSshChild(stderrText: string) {
  const stderrStream = new EventEmitter() as unknown as Readable;
  const child = new EventEmitter() as unknown as ReturnType<typeof spawn> & { exitCode: number | null };
  Object.assign(child, { stdin: null, stdout: new EventEmitter(), stderr: stderrStream, exitCode: null, kill: () => true });
  queueMicrotask(() => {
    (stderrStream as unknown as EventEmitter).emit("data", Buffer.from(stderrText));
    (child as { exitCode: number | null }).exitCode = 255;
    (child as unknown as EventEmitter).emit("exit", 255, null);
  });
  return child;
}

describe("bringUpSshAttachment — honest failure when the ssh child exits before the forward answers (no real ssh needed)", () => {
  it("rejects with the captured ssh stderr — never a fabricated success", async () => {
    const localPort = await pickFreeLoopbackPort();
    const target: AttachmentTarget = { sshAlias: "nonexistent-alias", transport: "ssh", machine_id: "m-fail" };
    await expect(
      bringUpSshAttachment({
        target,
        remotePort: localPort, // arbitrary — the fake spawn never really connects anywhere
        localPort,
        spawnFn: ((() =>
          fakeExitingSshChild(
            "ssh: Could not resolve hostname nonexistent-alias: nodename nor servname provided, or not known\n",
          )) as unknown) as typeof spawn,
        readyTimeoutMs: 3000,
      }),
    ).rejects.toThrow(/Could not resolve hostname/);
  });
});

// ── real SSH-default per-attachment transport ───────────────────────────────
// attach_over_real_transport == 1 / attach_injects_client_credential == 1
//
// A tiny stub "peer engine" HTTP server on loopback (mirrors
// fleet_client_relay.test.ts's startStubHost pattern): it 401s anything
// without the expected Authorization header, and answers 2xx with a
// FRESH, per-run-random `peer_identity` field on a credentialed request —
// the field the loopback multiplexer (or this test process) could not have
// forged, because the stub minted it itself, at listen time, this run.
//
// The forward to reach it is a REAL `ssh -N -L` child process (spawned via
// node:child_process, using this module's own bringUpSshAttachment — the
// SAME argv shape production per-attachment transports use), against
// 127.0.0.1 using the current user's own SSH access.

interface StubPeerEngine {
  url: string;
  port: number;
  identity: string;
  requests: string[];
  stop(): Promise<void>;
}

function startStubPeerEngine(expectedAuthHeader: string): Promise<StubPeerEngine> {
  const identity = `stub-peer-${randomBytes(12).toString("hex")}`;
  const requests: string[] = [];
  const server = http.createServer((req, res) => {
    requests.push(`${req.method} ${req.url}`);
    if (req.headers.authorization !== expectedAuthHeader) {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "unauthorized" }));
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, peer_identity: identity }));
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as AddressInfo).port;
      resolve({
        url: `http://127.0.0.1:${port}`,
        port,
        identity,
        requests,
        stop: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}

function pickFreeLoopbackPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createNetServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as AddressInfo).port;
      srv.close(() => resolve(port));
    });
  });
}

// ── the loopback SSH readiness probe (synchronous, module scope) ───────────
//
// Needs: a real sshd listening on 127.0.0.1:22 that the CURRENT OS user can
// authenticate to. Detection, in order:
//   1. does the current identity/agent ALREADY grant access (zero mutation —
//      `ssh -o BatchMode=yes 127.0.0.1 true`, bypassing ~/.ssh/config via
//      `-F /dev/null` so no Host/Match block can interfere)? If so, use it
//      as-is.
//   2. else, generate a THROWAWAY ed25519 keypair into a tmpdir, atomically
//      append its public half to ~/.ssh/authorized_keys, and verify THAT
//      connects. If it does not, the append is rolled back immediately
//      (byte-for-byte original content restored) before this probe returns
//      not-ready — a failed attempt leaves no trace.
// When NOT ready at all (no sshd on 22, no ssh-keygen, or the throwaway key
// still can't connect), `SSH_READY.ready` is false and the whole suite below
// `describe.skip`s with a printed reason — never a hard failure, never a
// faked pass.
const AUTHORIZED_KEYS_PATH = join(homedir(), ".ssh", "authorized_keys");

interface SshReadiness {
  ready: boolean;
  reason?: string;
  /** Extra ssh argv this suite's forwards must pass to authenticate: empty
   *  for the zero-mutation path; -i <throwaway key> + IdentitiesOnly for
   *  the fallback path. */
  identityArgs: string[];
  /** Present ONLY when a throwaway key was installed to reach `ready` — the
   *  describe block's own afterAll uses this to remove EXACTLY that
   *  mutation, byte-for-byte, every run. */
  throwaway?: { keyDir: string; originalAuthorizedKeys: string };
}

function sshProbeBaseArgs(): string[] {
  return [
    "-F", "/dev/null", // never consult (or depend on) the user's real ~/.ssh/config
    "-o", "BatchMode=yes", // never prompt — an outcome, not a hang
    "-o", "ConnectTimeout=3",
    "-o", "StrictHostKeyChecking=no", // a throwaway loopback hop; nothing security-sensitive rides this
    "-o", "UserKnownHostsFile=/dev/null", // never touch the user's real known_hosts
  ];
}

function canConnectLoopback(identityArgs: readonly string[]): boolean {
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

const SSH_READY: SshReadiness = (() => {
  if (canConnectLoopback([])) {
    return { ready: true, identityArgs: [] }; // the simpler, zero-mutation path — prefer it
  }
  let tmpDir: string | undefined;
  let originalAuthorizedKeys: string | undefined;
  try {
    tmpDir = mkdtempSync(join(tmpdir(), "amicode-attach-sshkey-"));
    const keyPath = join(tmpDir, "id_attach_test");
    execFileSync(
      "ssh-keygen",
      ["-t", "ed25519", "-N", "", "-C", `amicode-attachment-transport-test-${process.pid}`, "-f", keyPath],
      { stdio: "ignore", timeout: 10_000 },
    );
    const pubKey = readFileSync(`${keyPath}.pub`, "utf8").trim();
    originalAuthorizedKeys = existsSync(AUTHORIZED_KEYS_PATH) ? readFileSync(AUTHORIZED_KEYS_PATH, "utf8") : "";
    const sep = originalAuthorizedKeys === "" || originalAuthorizedKeys.endsWith("\n") ? "" : "\n";
    atomicWriteFileSync(AUTHORIZED_KEYS_PATH, `${originalAuthorizedKeys}${sep}${pubKey}\n`);
    const identityArgs = ["-i", keyPath, "-o", "IdentitiesOnly=yes"];
    if (canConnectLoopback(identityArgs)) {
      return { ready: true, identityArgs, throwaway: { keyDir: tmpDir, originalAuthorizedKeys } };
    }
    // the freshly-installed key STILL didn't connect — roll back before
    // reporting not-ready; leave zero trace.
    atomicWriteFileSync(AUTHORIZED_KEYS_PATH, originalAuthorizedKeys);
    rmSync(tmpDir, { recursive: true, force: true });
    return {
      ready: false,
      identityArgs: [],
      reason: "installed a throwaway key but the resulting connection still failed (sshd may disallow key auth, or PubkeyAuthentication is off)",
    };
  } catch (e) {
    if (originalAuthorizedKeys !== undefined) {
      try {
        atomicWriteFileSync(AUTHORIZED_KEYS_PATH, originalAuthorizedKeys);
      } catch {
        /* best-effort rollback */
      }
    }
    if (tmpDir) {
      try {
        rmSync(tmpDir, { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
    }
    return { ready: false, identityArgs: [], reason: `loopback ssh probe failed: ${e instanceof Error ? e.message : String(e)}` };
  }
})();

if (!SSH_READY.ready) {
  // eslint-disable-next-line no-console
  console.warn(
    `[amicode_service_attachment_transport.test.ts] SKIPPING the real-SSH transport suite: ${SSH_READY.reason ?? "no loopback ssh access"}. ` +
      "Needs a loopback sshd on 127.0.0.1:22 the current OS user can authenticate to (directly, or via a throwaway key this probe installs and " +
      "verifies itself). attach_over_real_transport / attach_injects_client_credential are NOT exercised on this machine — this is an honest skip, not a failure.",
  );
}

describe.skipIf(!SSH_READY.ready)(
  "real SSH-default per-attachment transport + credential injection (#1343, ADR 0027 §6-7/D9+D10a)",
  () => {
    const PEER_TOKEN = "attach-test-peer-token";
    const MACHINE_ID = "peer-under-real-ssh";
    let peer: StubPeerEngine;
    let handle: AttachmentTransportHandle;
    let credDir: string;
    let credFile: string;

    beforeAll(async () => {
      const username = userInfo().username;
      peer = await startStubPeerEngine(attachmentUpstreamAuthHeader(PEER_TOKEN));
      const localPort = await pickFreeLoopbackPort();
      const target: AttachmentTarget = { sshAlias: `${username}@127.0.0.1`, transport: "ssh", machine_id: MACHINE_ID };
      handle = await bringUpSshAttachment({
        target,
        remotePort: peer.port,
        localPort,
        extraSshOptions: [...sshProbeBaseArgs(), ...SSH_READY.identityArgs],
      });
      credDir = mkdtempSync(join(tmpdir(), "amicode-attach-cred-real-"));
      credFile = join(credDir, "attachment-credentials.json");
    }, 30_000);

    afterAll(async () => {
      await handle?.stop();
      await peer?.stop();
      if (credDir) rmSync(credDir, { recursive: true, force: true });
      // Remove EXACTLY the throwaway key this run installed (if any) —
      // byte-for-byte restore of ~/.ssh/authorized_keys, always, whether the
      // tests above passed or failed.
      if (SSH_READY.throwaway) {
        atomicWriteFileSync(AUTHORIZED_KEYS_PATH, SSH_READY.throwaway.originalAuthorizedKeys);
        rmSync(SSH_READY.throwaway.keyDir, { recursive: true, force: true });
      }
    });

    it("attach_over_real_transport == 1 — reaches the peer engine over a REAL ssh -L forward, proven by a peer-identifying field the loopback mux cannot forge", async () => {
      expect(handle.kind).toBe("ssh");
      // the provider Slice 3's OWN module constructed, probed authenticated —
      // proving the per-attachment provider machinery genuinely reaches
      // through the real tunnel, not just a same-process stand-in.
      const health = await handle.provider.health();
      expect(health.reachable).toBe(true);

      // the sharp, forge-proof assertion: read the body directly.
      const res = await fetch(handle.localUrl, { headers: { Authorization: attachmentUpstreamAuthHeader(PEER_TOKEN) } });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { peer_identity?: string };
      expect(body.peer_identity).toBe(peer.identity); // minted by the STUB PEER at listen time — nothing local could have produced it
      expect(peer.requests.length).toBeGreaterThan(0); // the request genuinely reached the peer process
    }, 20_000);

    it("attach_injects_client_credential == 1 — uncredentialed refused (401/403); a credentialed attach returns 2xx carrying the peer identity", async () => {
      const before = peer.requests.length;
      const unauthed = await fetch(handle.localUrl);
      expect([401, 403]).toContain(unauthed.status);
      expect(peer.requests.length).toBeGreaterThan(before); // it DID reach the peer, which itself refused — not a local/tunnel-level rejection

      // inject the per-attachment credential via the generalized, keyed store
      writeAttachmentCredential(MACHINE_ID, { baseUrl: handle.localUrl, token: PEER_TOKEN }, { credentialFile: credFile });
      const read = readAttachmentCredential(MACHINE_ID, { credentialFile: credFile });
      expect(read.ok).toBe(true);
      if (!read.ok) throw new Error("unreachable"); // narrows for TS below
      const authed = await fetch(handle.localUrl, { headers: { Authorization: attachmentUpstreamAuthHeader(read.credential.token) } });
      expect(authed.status).toBe(200);
      const body = (await authed.json()) as { peer_identity?: string };
      expect(body.peer_identity).toBe(peer.identity);
    }, 20_000);
  },
);
