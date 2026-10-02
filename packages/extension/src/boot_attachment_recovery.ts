// boot_attachment_recovery.ts — Boot-time attachment pointer recovery (#1410,
// ADR 0030 §D3). On extension activation, reads the on-disk attachment pointer
// and — when valid — spins up the per-attachment transport so the D3 resolver
// routes to the attached device after a window reload.
//
// This is the minimum wiring that makes `POST /fleet/attach → reload → proxied
// sessions` work end-to-end. The live re-target (switch without reload) stays
// with #1353; the reload is still required.
//
// CREDENTIAL: the boot-time proxy uses the per-attachment credential (from
// readAttachmentCredential), NOT the hub credential — matching the runtime
// AttachLifecycle.attach() credential path.
//
// TIMEOUT: a shorter readiness timeout (4s vs the runtime 8s) protects startup
// UX on mobile fleet (laptop boots at home, lab machine unreachable).

import {
  resolveAttachmentPointer,
  type AttachmentPointer,
  type AttachmentPointerDeps,
} from "./amicode_service/attachment_pointer";
import {
  readAttachmentCredential,
  type AttachmentCredentialDeps,
} from "./amicode_service/attachment_credential";

/** The result of boot-time attachment recovery: either a transport handle with
 *  a getUrl function, or nothing (the local-sessions default). */
export interface BootAttachmentResult {
  /** URL getter for the attached device's proxied endpoint. */
  getUrl: () => string | undefined;
  /** Credential getter for the attached device. */
  credential: () => { baseUrl: string; token: string } | null;
  /** The pointer that was recovered. */
  pointer: AttachmentPointer;
  /** Tear down the transport (called on extension deactivate). */
  stop: () => Promise<void>;
}

/** Injectable deps for boot-time recovery — all file-path overrides for
 *  testability, plus the transport bring-up function. */
export interface BootAttachmentRecoveryDeps extends AttachmentPointerDeps, AttachmentCredentialDeps {
  /** The transport bring-up function. Injectable for tests; defaults to
   *  bringUpSshAttachment from attachment_transport.ts. */
  bringUpTransport?: (opts: {
    target: { sshAlias: string; transport: string; machine_id: string };
    remotePort: number;
    readyTimeoutMs?: number;
  }) => Promise<{ localUrl: string; stop: () => Promise<void> }>;
  /** The remote port the peer engine listens on. Default 43117. */
  remotePort?: number;
  /** The readiness timeout (ms). Default 4000 (shorter than runtime 8s). */
  readyTimeoutMs?: number;
  /** Log sink. */
  log?: { appendLine(line: string): void };
}

/** Read the attachment pointer from disk and, when valid, spin up the
 *  per-attachment transport. Returns the handle on success, or undefined on
 *  any failure (absent pointer, malformed pointer, transport timeout).
 *  Never throws — all failures degrade to local sessions with a log line. */
export async function recoverBootAttachment(
  deps: BootAttachmentRecoveryDeps = {},
): Promise<BootAttachmentResult | undefined> {
  const log = deps.log ?? { appendLine: () => {} };
  const remotePort = deps.remotePort ?? 43117;
  const readyTimeoutMs = deps.readyTimeoutMs ?? 4000;

  // Step 1: read the pointer from disk (synchronous)
  const result = resolveAttachmentPointer(deps);
  if (!result.ok) {
    log.appendLine(`[boot-attachment] pointer malformed — ${result.error}; using local sessions`);
    return undefined;
  }
  if (!result.attached) {
    // Empty pointer = the local default. Not an error, not even a log line.
    return undefined;
  }
  const pointer = result.pointer;
  log.appendLine(`[boot-attachment] found pointer → ${pointer.machine_id} (${pointer.sshAlias})`);

  // Step 2: spin up the per-attachment transport
  const bringUp = deps.bringUpTransport;
  if (!bringUp) {
    log.appendLine(`[boot-attachment] no transport factory available — using local sessions`);
    return undefined;
  }

  let handle: { localUrl: string; stop: () => Promise<void> };
  try {
    handle = await bringUp({
      target: pointer,
      remotePort,
      readyTimeoutMs,
    });
  } catch (e) {
    log.appendLine(
      `[boot-attachment] transport failed for ${pointer.machine_id} — ${(e as Error).message}; using local sessions`,
    );
    return undefined;
  }

  log.appendLine(`[boot-attachment] transport ready → ${handle.localUrl}`);

  // Step 3: build the credential getter (per-attachment, not hub)
  const credential = (): { baseUrl: string; token: string } | null => {
    const cred = readAttachmentCredential(pointer.machine_id, deps);
    if (!cred.ok) return null;
    return { baseUrl: cred.credential.baseUrl, token: cred.credential.token };
  };

  return {
    getUrl: () => handle.localUrl,
    credential,
    pointer,
    stop: () => handle.stop(),
  };
}
