// ATTACHMENT CREDENTIAL (#1343, ADR 0027 §7/D10a — Slice 3): the per-attachment
// analogue of hub_credential.ts's single-hub credential. D10a: "inject a UI
// client credential per attachment (as #1262 does) — a proxied request must
// carry it to authenticate to the peer engine, so it lands with the
// transport (Slice 3), not later."
//
// hub_credential.ts holds exactly ONE credential because there is exactly
// one hub. An attach flow can reach MANY peers (the roster lists every
// machine, even though only one is ATTACHED at a time per D6) — so this
// module generalizes the shape to a small KEYED store, keyed by the target's
// roster `machine_id`, rather than assuming "the one hub". Slice 3's own
// acceptance criteria need only ONE credentialed attach vs ONE uncredentialed
// attach (never two peers simultaneously) — but the keyed shape is the
// honest generalization the design asks for, and it is what a real attach
// verb (Slice 4) reads/writes per target when it exists.
//
// This is the H1 UI-mint credential ONLY (D10a) — NOT the Horizon-2
// peer-trust identity (a NEW, separately-mintable/revocable peer token,
// D10b, recorded in ADR 0027 §7 and explicitly NOT built here).
//
// Store shape (one file, atomically written 0600 via the shared writer):
//   { store_version: 1, peers: { "<machine_id>": { base_url, token } } }
// Unknown top-level keys are preserved on rewrite (the same F4-style
// bidirectional courtesy hub_credential.ts already carries); a per-key read
// is a NAMED outcome (absent | malformed | incomplete), never a throw, never
// a fabricated credential.
import { existsSync, readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { atomicWriteFileSync } from "./credentials";
import { hubUpstreamAuthHeader } from "./hub_credential";

export const ATTACHMENT_CREDENTIAL_STORE_VERSION = 1;

/** One target's injected credential — byte-identical shape to HubCredential
 *  (hub_credential.ts), on purpose: one credential model, hub hop and peer
 *  hop alike. */
export interface AttachmentCredential {
  baseUrl: string;
  token: string;
}

export interface AttachmentCredentialDeps {
  /** Override the store file (pure-injection for tests). Default:
   *  $AMICO_FLEET_ATTACHMENT_CREDENTIAL_FILE -> ~/.amico/fleet-attachment-credentials.json
   *  (a sibling of hub_credential.ts's ~/.amico/fleet-hub.json — secrets live
   *  directly under ~/.amico/, not the ops/fleet pointer-cache directory the
   *  D6/D7 pointers use). */
  credentialFile?: string;
}

export function attachmentCredentialFilePath(deps: AttachmentCredentialDeps = {}): string {
  if (deps.credentialFile) return deps.credentialFile;
  const env = process.env.AMICO_FLEET_ATTACHMENT_CREDENTIAL_FILE;
  if (env && env.trim() !== "") return env;
  return join(homedir(), ".amico", "fleet-attachment-credentials.json");
}

export type AttachmentCredentialReadReason = "absent" | "malformed" | "incomplete";

/** The NAMED read outcome for ONE target — never a throw, never a
 *  half-present credential. `absent` covers both "no entry for this
 *  machine_id" and "the whole store file is unreadable/corrupt" — from a
 *  per-key caller's perspective those are operationally identical (no
 *  credential is available for this target), which is exactly the
 *  uncredentialed leg attach_injects_client_credential needs. */
export type AttachmentCredentialRead =
  | { ok: true; credential: AttachmentCredential }
  | { ok: false; reason: AttachmentCredentialReadReason };

interface StoreDoc {
  store_version?: number;
  peers?: Record<string, unknown>;
  [key: string]: unknown;
}

function readStoreDoc(file: string): StoreDoc {
  if (!existsSync(file)) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return {}; // corrupt whole-file JSON degrades to empty — tolerant read, never a throw
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
  return parsed as StoreDoc;
}

function peersOf(doc: StoreDoc): Record<string, unknown> {
  return typeof doc.peers === "object" && doc.peers !== null && !Array.isArray(doc.peers)
    ? (doc.peers as Record<string, unknown>)
    : {};
}

/** Look up the injected credential for ONE target machine_id. */
export function readAttachmentCredential(machineId: string, deps: AttachmentCredentialDeps = {}): AttachmentCredentialRead {
  const peers = peersOf(readStoreDoc(attachmentCredentialFilePath(deps)));
  const entry = peers[machineId];
  if (entry === undefined) return { ok: false, reason: "absent" };
  if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return { ok: false, reason: "malformed" };
  const e = entry as Record<string, unknown>;
  const baseUrl = typeof e.base_url === "string" ? e.base_url.trim() : "";
  const token = typeof e.token === "string" ? e.token.trim() : "";
  if (baseUrl === "" || token === "") return { ok: false, reason: "incomplete" };
  return { ok: true, credential: { baseUrl, token } };
}

/** Inject (write) the credential for ONE target machine_id — an upsert
 *  keyed by machine_id; every OTHER target's entry, and every unknown
 *  top-level key, is preserved untouched. Atomic 0600 via the shared writer
 *  (the same credentials.ts primitive hub_credential.ts uses). */
export function writeAttachmentCredential(
  machineId: string,
  value: AttachmentCredential,
  deps: AttachmentCredentialDeps = {},
): void {
  const file = attachmentCredentialFilePath(deps);
  const doc = readStoreDoc(file);
  const peers = { ...peersOf(doc), [machineId]: { base_url: value.baseUrl.trim(), token: value.token.trim() } };
  const out: StoreDoc = { ...doc, store_version: ATTACHMENT_CREDENTIAL_STORE_VERSION, peers };
  atomicWriteFileSync(file, JSON.stringify(out, null, 2) + "\n");
}

/** Remove ONE target's credential (the detach counterpart write). An absent
 *  key, or an absent store, is an idempotent no-op. */
export function clearAttachmentCredential(machineId: string, deps: AttachmentCredentialDeps = {}): void {
  const file = attachmentCredentialFilePath(deps);
  const doc = readStoreDoc(file);
  const peers = peersOf(doc);
  if (!(machineId in peers)) return;
  const remaining = { ...peers };
  delete remaining[machineId];
  const out: StoreDoc = { ...doc, store_version: ATTACHMENT_CREDENTIAL_STORE_VERSION, peers: remaining };
  atomicWriteFileSync(file, JSON.stringify(out, null, 2) + "\n");
}

/** Remove the ENTIRE store file; absent is a no-op (mirrors clearHubCredential). */
export function clearAllAttachmentCredentials(deps: AttachmentCredentialDeps = {}): void {
  rmSync(attachmentCredentialFilePath(deps), { force: true });
}

/** The Authorization header an attach injects to authenticate to the peer
 *  engine — REUSES the SAME Basic idiom the hub upstream hop already uses
 *  (hubUpstreamAuthHeader -> serverAuthHeader: Basic base64("opencode:<token>")).
 *  One auth convention serves the hub hop and every peer hop alike; this is
 *  a semantically-named alias, not a parallel implementation. */
export function attachmentUpstreamAuthHeader(token: string): string {
  return hubUpstreamAuthHeader(token);
}
