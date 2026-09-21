// ATTACH LIFECYCLE (#1381, ADR 0027 §3/D5 — the upstream lifecycle coordinator):
// the attach ACTION (attach_action.ts) writes the pointer file and credential
// store; THIS module manages the LIVE resources that action implies:
//
//   1. The SSH forward (via attachment_transport.ts's bringUpSshAttachment)
//   2. The HubProxy registered on FleetPlane.attached (so the D3 resolver
//      can route requests to the peer)
//   3. The credential injection (the per-attachment UI client mint read from
//      attachment_credential.ts, wired as the HubProxy's credential provider)
//
// Lifecycle rules:
//   - One active attachment at a time — re-attach tears down the previous
//     (AC5), no stacking.
//   - Detach tears down the SSH forward, clears FleetPlane.attached, and
//     resets the SSE cursor (AC4).
//   - The attach path never writes `role=client` and never installs the
//     never-fork guard.
//   - Credential injection uses the existing UI client mint (H1); per-peer
//     token is H2.
import { HubProxy } from "./hub_proxy";
import {
  readAttachmentCredential,
  type AttachmentCredentialDeps,
} from "./attachment_credential";
import type { HubCredentialRead } from "./hub_credential";
import type { FleetPlane } from "./server";
import type { AttachmentTarget, AttachmentTransportHandle } from "./attachment_transport";

/** The injectable transport bring-up — the real `bringUpSshAttachment` in
 *  production, a mock in tests (the test does not need real SSH). */
export type TransportFactory = (opts: {
  target: AttachmentTarget;
  remotePort: number;
}) => Promise<AttachmentTransportHandle>;

export interface AttachLifecycleOpts {
  /** The FleetPlane whose `attached` slot this lifecycle manages. */
  plane: FleetPlane;
  /** The transport factory (injectable; defaults to bringUpSshAttachment). */
  transportFactory: TransportFactory;
  /** The port the peer engine listens on (default 43117). */
  remotePort?: number;
  /** DI for the credential store file (tests). */
  credentialFile?: string;
  /** The SSE cursor reset callback (AC4 — invoked on detach). */
  resetCursorOnSwitch?: () => void;
  /** Data-plane timeout for the created HubProxy (ms). */
  dataPlaneTimeoutMs?: number;
}

const HUB_MINT_NAME = "hub" as const;

/** Read the per-attachment credential and adapt it to the HubCredentialRead
 *  shape the HubProxy expects. The `mint` field is carried for type
 *  compatibility; the proxy uses only `.ok` and `.credential.token`. */
function credentialForAttachment(
  machineId: string,
  deps: AttachmentCredentialDeps,
): HubCredentialRead {
  const read = readAttachmentCredential(machineId, deps);
  if (read.ok) {
    return { ok: true, mint: HUB_MINT_NAME, credential: read.credential };
  }
  return { ok: false, mint: HUB_MINT_NAME, reason: read.reason };
}

export class AttachLifecycle {
  private handle?: AttachmentTransportHandle;
  private currentMachineId?: string;
  private readonly opts: Required<Pick<AttachLifecycleOpts, "plane" | "transportFactory">> &
    AttachLifecycleOpts;

  constructor(opts: AttachLifecycleOpts) {
    this.opts = opts;
  }

  /** The currently-attached machine_id, or undefined when idle. */
  get attachedMachineId(): string | undefined {
    return this.currentMachineId;
  }

  /** Attach to a peer: spin up the transport, create the HubProxy with
   *  credential injection, and register it on FleetPlane.attached. If a
   *  previous attachment exists, it is torn down first (AC5). */
  async attach(target: AttachmentTarget): Promise<void> {
    // AC5: tear down previous
    if (this.handle) {
      await this.teardown();
    }

    const remotePort = this.opts.remotePort ?? 43117;

    // AC1: spin up the per-attachment transport
    this.handle = await this.opts.transportFactory({
      target,
      remotePort,
    });

    const localUrl = this.handle.localUrl;
    const machineId = target.machine_id;
    const credDeps: AttachmentCredentialDeps = this.opts.credentialFile
      ? { credentialFile: this.opts.credentialFile }
      : {};

    // AC2+AC3: create HubProxy with credential injection and register it
    const proxy = new HubProxy({
      getUrl: () => localUrl,
      credential: () => credentialForAttachment(machineId, credDeps),
      ...(this.opts.dataPlaneTimeoutMs !== undefined
        ? { timeoutMs: this.opts.dataPlaneTimeoutMs }
        : {}),
    });

    this.opts.plane.attached = proxy;
    this.currentMachineId = machineId;
  }

  /** Detach: tear down the SSH forward, clear FleetPlane.attached, and reset
   *  the SSE cursor (AC4). Idempotent — a detach with no attachment is a
   *  no-op, never throws. */
  async detach(): Promise<void> {
    if (!this.handle) return;
    await this.teardown();
    this.opts.resetCursorOnSwitch?.();
  }

  /** Stop the transport and clear the FleetPlane slot (shared by detach and
   *  the re-attach path). */
  private async teardown(): Promise<void> {
    if (this.handle) {
      await this.handle.stop();
      this.handle = undefined;
    }
    this.opts.plane.attached = undefined;
    this.currentMachineId = undefined;
  }
}
