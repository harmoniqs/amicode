// ATTACHMENT TRANSPORT (#1343, ADR 0027 §6/D9 — Slice 3): per-attachment
// transport bring-up — ON DEMAND, PARAMETERIZED PER TARGET, not the hub's one
// persistent (launchd/systemd-managed) tunnel. This module adds NO new
// provider abstraction: it reuses fleet_transport.ts's seam (createSshProvider/
// createTailscaleProvider/createDirectProvider/transportForSelection/
// resolveFleetTransportKind) exactly as shipped, and wires it PER ATTACHMENT
// target instead of the single hub's config knob.
//
// D9 — "Per-attachment transport, SSH default, engine-reachable." Each
// transport this module brings up is an authenticated, ENGINE-REACHABLE
// channel that is BIDIRECTIONAL-CAPABLE BY CONSTRUCTION: an ssh `-L` forward
// (or a resolved tailscale/direct base URL) is a full-duplex TCP/HTTP
// channel — nothing here narrows it to a request/response-only shape. That
// is the load-bearing reason Horizon 2's engine<->engine RPC (ADR 0027 §7-8,
// an explicit non-goal of THIS slice) can reuse the SAME channel without
// re-plumbing the transport: the substrate this module stands up already
// carries traffic both ways, today, over the SAME socket a proxied HTTP
// request rides.
//
// `roaming`-tagged peers default to tailscale; every OTHER peer (the
// majority case, and the only one this build REQUIRES) defaults to ssh — the
// universal floor. A fleet with zero Tailscale still attaches, over ssh,
// always (ADR 0027 §6: "no one is forced onto a tailnet").
//
// Credential injection (D10a) is a SEPARATE, orthogonal concern — see
// attachment_credential.ts — layered on top of whatever base URL this module
// resolves, via a plain Authorization header on each proxied request. This
// module never reads or writes a credential.
import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";

import {
  resolveFleetTransportKind,
  transportForSelection,
  type FleetTransportKind,
  type FleetTransportProvider,
  type FleetTransportSelection,
} from "./fleet_transport";

// ── D9 roaming-aware default (pure, no network, no I/O) ─────────────────────

/** The roster capability -> default transport SETTING (D9): a peer tagged
 *  `roaming` defaults to tailscale (it moves between networks, where a
 *  loopback-forward's ssh alias would need to keep changing); every other
 *  peer defaults to `ssh` — the universal, zero-Tailscale-required floor.
 *  This is ONLY the default a fresh attach picks when the caller has not
 *  already chosen a transport (e.g. an explicit AttachmentPointer/roster
 *  `transport` field) — it never overrides an already-decided value. */
export function defaultTransportSettingForCapabilities(capabilities: readonly string[]): "ssh" | "tailscale" {
  return capabilities.includes("roaming") ? "tailscale" : "ssh";
}

/** D9 composed with the EXISTING resolver: derive the `setting` input from
 *  the target's roster capabilities, then defer ENTIRELY to
 *  resolveFleetTransportKind for availability/disabled-provider handling —
 *  the no-cross-provider-fallback law (a disabled or not-yet-shipped
 *  provider is a NAMED not-ok, never a silent substitute) stays THEIRS,
 *  never reimplemented here. This is the "thin wrapper" the issue asks for:
 *  no new provider-selection logic, only a new INPUT to the old one. */
export function resolveAttachmentTransportKind(opts: {
  capabilities: readonly string[];
  available?: readonly FleetTransportKind[];
  disabled?: readonly FleetTransportKind[];
}): FleetTransportSelection {
  return resolveFleetTransportKind({
    setting: defaultTransportSettingForCapabilities(opts.capabilities),
    available: opts.available,
    disabled: opts.disabled,
  });
}

// ── per-attachment provider construction (parameterized per target) ────────

/** The minimal per-target reach coordinate this module needs — mirrors
 *  AttachmentPointer's own vocabulary (sshAlias/transport/machine_id,
 *  attachment_pointer.ts) so a resolved AttachmentPointer OR a roster row
 *  both satisfy this shape without adaptation. `transport` here is the
 *  ALREADY-DECIDED value for this one target (e.g. from
 *  resolveAttachmentTransportKind, or an explicit override) — this type
 *  does not itself derive a default. */
export interface AttachmentTarget {
  /** The ssh target this attachment is reachable at (its fleet.json/roster
   *  canonical alias, e.g. "user@host" or a ~/.ssh/config Host alias). */
  sshAlias: string;
  /** The DECIDED transport kind for this target (e.g. "ssh", "tailscale",
   *  "direct") — a free string, validated by resolveFleetTransportKind. */
  transport: string;
  /** The target's roster machine_id — the same key the credential store
   *  (attachment_credential.ts) and the D6 pointer key on. */
  machine_id: string;
}

/** Build the FleetTransportProvider for ONE attachment target — the D9
 *  per-attachment analogue of the hub's single transportForSelection call.
 *  `resolveUrl` is supplied by the CALLER: for ssh, the live loopback
 *  forward's URL once `bringUpSshAttachment` has it up (undefined before —
 *  the same "not yet bound" honesty the hub path already has); for
 *  tailscale, the host's MagicDNS origin; for direct, the operator-supplied
 *  URL. This function does NOT fork createSshProvider/createTailscaleProvider/
 *  createDirectProvider — it is transportForSelection, called with a
 *  PER-TARGET setting and a PER-TARGET resolver instead of the hub's single
 *  config knob. Two different targets therefore always get two independent
 *  providers, never a shared one. */
export function providerForAttachment(
  target: AttachmentTarget,
  resolveUrl: () => string | undefined,
  opts?: { available?: readonly FleetTransportKind[]; disabled?: readonly FleetTransportKind[] },
): FleetTransportProvider {
  const sel = resolveFleetTransportKind({
    setting: target.transport,
    available: opts?.available,
    disabled: opts?.disabled,
  });
  return transportForSelection(sel, resolveUrl);
}

// ── the ssh provider's per-attachment forward (ON DEMAND, not OS-managed) ──
//
// The hub's ssh provider (fleet_transport.ts) is deliberately a lifecycle
// no-op: its `-L` forward is a PERSISTENT, OS-managed (launchd/systemd)
// tunnel the installer provisions once. A per-attachment forward is the
// opposite by design (D5, Slice 4: "bring up a per-attachment transport ON
// DEMAND") — it comes up when an attach happens and tears down on detach.
// This module owns THAT lifecycle for the ssh kind; tailscale/direct need no
// bring-up step at all (their URL is already reachable once resolved — see
// their own honest start()/stop() no-ops in fleet_transport.ts).

/** The per-attachment ssh `-L` forward argv. Mirrors sshForwardArgs'
 *  (fleet_transport.ts) option set BYTE-FOR-BYTE — same flags, same order —
 *  generalized ONLY to accept INDEPENDENT local/remote ports (sshForwardArgs
 *  assumes one port serves both ends, true for the hub's single tunnel
 *  between two DIFFERENT hosts, but not safe when several per-attachment
 *  forwards run concurrently on one client, or — as this module's own test
 *  needs — when the "local" and "remote" ends are loopback on the SAME
 *  host and must not collide on one port). `extraSshOptions` is the
 *  CI-safe/throwaway-identity seam (BatchMode, StrictHostKeyChecking, a
 *  throwaway -i, etc.) — production callers pass nothing; the alias's own
 *  ~/.ssh/config entry carries its identity, the same convention
 *  sshForwardArgs already uses. */
export function attachmentForwardArgs(opts: {
  alias: string;
  localPort: number;
  remotePort: number;
  extraSshOptions?: readonly string[];
}): string[] {
  return [
    "-N",
    "-o", "ExitOnForwardFailure=yes",
    "-o", "ServerAliveInterval=15",
    "-o", "ServerAliveCountMax=2",
    "-o", "TCPKeepAlive=yes",
    ...(opts.extraSshOptions ?? []),
    "-L", `127.0.0.1:${opts.localPort}:127.0.0.1:${opts.remotePort}`,
    opts.alias,
  ];
}

/** A live per-attachment transport — the forward (ssh) or resolved URL
 *  (tailscale/direct) PLUS the FleetTransportProvider built on top of it.
 *  `stop()` tears the forward down (a no-op for kinds with no lifecycle of
 *  their own). Bidirectional-capable by construction (see module header) —
 *  `localUrl` is a normal HTTP origin either direction of traffic can use. */
export interface AttachmentTransportHandle {
  readonly kind: FleetTransportKind;
  /** The loopback URL a caller dials to reach the attached peer THROUGH
   *  this channel. */
  readonly localUrl: string;
  readonly provider: FleetTransportProvider;
  stop(): Promise<void>;
}

export interface BringUpSshAttachmentOptions {
  target: AttachmentTarget;
  /** The port the forward's REMOTE side dials on the target host (the
   *  peer engine's own loopback bind). */
  remotePort: number;
  /** The port THIS forward listens on locally. Defaults to `remotePort`
   *  (the hub's existing same-port convention) — pass an explicit,
   *  DIFFERENT value when that would collide (concurrently attaching to
   *  several peers from one client, or a same-host loopback test/rehearsal
   *  where "local" and "remote" are literally the same interface). */
  localPort?: number;
  /** Extra ssh argv appended before the final `-L`/alias args — the
   *  CI-safe/throwaway-identity seam. Production callers pass nothing. */
  extraSshOptions?: readonly string[];
  /** Injectable spawn (test seam); default node:child_process spawn. */
  spawnFn?: typeof spawn;
  /** How long to wait for the forward to answer ANY request before giving
   *  up (ms). Default 8000. */
  readyTimeoutMs?: number;
  /** Poll interval while waiting for the forward to come up (ms). Default 150. */
  readyPollIntervalMs?: number;
  /** Injectable fetch for the readiness poll (test seam); default global fetch. */
  fetchFn?: typeof fetch;
}

/** Bring up ONE ssh-kind per-attachment transport: spawn a real `ssh -N -L`
 *  forward (child_process, the SAME CLI the hub path shells out to — no
 *  ssh2/node-ssh dependency), wait until it actually answers a request
 *  end-to-end (local forward -> ssh tunnel -> the target's remote port), and
 *  return a handle carrying its FleetTransportProvider (via
 *  providerForAttachment, above) plus a `stop()` that tears the child down.
 *  NEVER a same-process stub standing in for "real": if the ssh child exits
 *  before the forward answers anything, this rejects with the ssh stderr
 *  attached — an honest failure, never a fabricated success. */
export async function bringUpSshAttachment(opts: BringUpSshAttachmentOptions): Promise<AttachmentTransportHandle> {
  const localPort = opts.localPort ?? opts.remotePort;
  const spawnFn = opts.spawnFn ?? spawn;
  const doFetch = opts.fetchFn ?? fetch;
  const readyTimeoutMs = opts.readyTimeoutMs ?? 8000;
  const pollIntervalMs = opts.readyPollIntervalMs ?? 150;

  const args = attachmentForwardArgs({
    alias: opts.target.sshAlias,
    localPort,
    remotePort: opts.remotePort,
    extraSshOptions: opts.extraSshOptions,
  });
  const child = spawnFn("ssh", args, { stdio: ["ignore", "pipe", "pipe"] }) as ChildProcessByStdio<null, Readable, Readable>;
  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf8");
  });
  let exited: { code: number | null; signal: NodeJS.Signals | null } | undefined;
  child.once("exit", (code, signal) => {
    exited = { code, signal };
  });

  const localUrl = `http://127.0.0.1:${localPort}`;
  const deadline = Date.now() + readyTimeoutMs;
  let ready = false;
  let lastFailure = "";
  while (Date.now() < deadline) {
    if (exited) {
      throw new Error(
        `ssh forward exited before becoming reachable (code=${exited.code}, signal=${exited.signal}): ${stderr.trim() || "(no stderr)"}`,
      );
    }
    try {
      // ANY response (even a 401) proves the WHOLE path is live: the local
      // listener bound, the ssh tunnel carried the connection, and the
      // target host's remote port answered — this is the readiness gate
      // AND the first proof of end-to-end reachability, at once.
      await doFetch(localUrl, { signal: AbortSignal.timeout(500) });
      ready = true;
      break;
    } catch (e) {
      lastFailure = e instanceof Error ? e.message : String(e);
      await new Promise((r) => setTimeout(r, pollIntervalMs));
    }
  }
  if (!ready) {
    child.kill();
    throw new Error(
      `ssh forward never became reachable within ${readyTimeoutMs}ms (last attempt: ${lastFailure})${stderr ? ` — stderr: ${stderr.trim()}` : ""}`,
    );
  }

  const provider = providerForAttachment(opts.target, () => localUrl);
  let stopped = false;
  return {
    kind: provider.kind,
    localUrl,
    provider,
    async stop(): Promise<void> {
      if (stopped) return;
      stopped = true;
      if (exited || child.exitCode !== null) return;
      await new Promise<void>((resolve) => {
        const done = () => resolve();
        child.once("exit", done);
        child.kill();
        // Safety net: SIGKILL if the graceful signal is ever ignored, so a
        // test/attach-teardown can never hang on a stray ssh child.
        setTimeout(() => {
          try {
            child.kill("SIGKILL");
          } catch {
            /* already gone */
          }
        }, 2000);
      });
    },
  };
}

// re-export the types this module composes with, for callers that only need
// the provider seam's own types alongside this module's per-attachment ones.
export type { FleetTransportKind, FleetTransportProvider, FleetTransportSelection };
