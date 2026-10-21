// AMICODE #1826 — posture-aware chat link resolution. The pre-#1826 bridge
// gated every chat file link on `fs.existsSync` on the CLIENT's disk: on the
// hub-client posture (#1784) a hub path is never on the laptop, so every
// click on hub content died silently. The resolution order — ONE function the
// bridge calls — is three layers, preview-first:
//   1. vault roots only: a path under a discovered vault mount that exists
//      locally opens local (vaults are 1:1 synced across machines — faithful
//      up to sync latency). Every OTHER path class — including a
//      locally-existing repo checkout — is the hub's: a stale local checkout
//      must never silently win over the authoritative copy.
//   2. the hub-client default: click-time re-resolution through the hub's
//      resolve-file route (server stat + mount containment — the resolver is
//      the security boundary), then Preview via the hub-bound SDK. The client
//      stat routes (layer 1) but never blocks the open.
//   3. vscode-remote: an explicit affordance handled by the bridge with the
//      Remote-SSH URI builder (fleet_connect_remote_ssh.ts).
// Total failure names why it died — `not-found-on-hub` / `tunnel-down` /
// `no-ssh-alias` — the Block system's discipline: a dead link names itself.
import * as fs from "node:fs";
import * as path from "node:path";
import { hostProofFetch, type BootPosture } from "./hub_client";
import { listMounts } from "./amicode_service/vaults";

/** Budget for one hub resolve ask (the tunnel adds a hop; the probe's 1500 ms
 *  steady budget plus slack). */
const RESOLVE_TIMEOUT_MS = 3000;

/** The failure classes a dead link names — never a silent no-op. */
export type LinkFailureReason = "not-found-on-hub" | "tunnel-down" | "no-ssh-alias";

/** What the bridge does with one chat link click. "silent" keeps the
 *  pre-#1826 refusal (non-hub postures, unchanged). */
export type ChatLinkResolution =
  | { action: "preview"; path: string }
  | { action: "silent" }
  | { action: "failed"; reason: LinkFailureReason; detail: string };

/** The posture-aware context the panel hands the bridge per message —
 *  wired at activation where the boot posture (#1784) is decided. */
export interface LinkResolutionContext {
  posture: BootPosture;
  /** The normalized hub origin when posture = "hub-client". */
  hubUrl?: string;
  /** The ?directory= placement for instance asks (#1801: the key the hub
   *  frontdoor routes instance requests by). */
  directory?: string;
  /** The Remote-SSH alias for the remote affordance (topology projection). */
  sshAlias?: string;
  /** Injectable fetch (tests); production rides the host-proof node:http
   *  fetch (the ext host's patched fetch fails loopback tunnel URLs). */
  fetchImpl?: typeof fetch;
}

/** The resolution function's knobs — the context plus injectable disk access. */
export interface ChatLinkDeps extends LinkResolutionContext {
  /** Discovered vault mount roots (layer 1's scope); default: listMounts. */
  vaultRoots?: () => string[];
  exists?: (p: string) => boolean;
}

/** The resolve ask — an instance ask placed like the composer's harness
 *  route (#1801 lesson): `?directory=` is the placement the hub frontdoor
 *  routes instance requests by; a missing directory keeps the bare ask
 *  (the default-engine placement). The raw markdown path goes to the hub's
 *  resolve-file route, never straight to a file read. */
export function hubResolveUrl(hubUrl: string, fsPath: string, directory: string | undefined): string {
  const query = `path=${encodeURIComponent(fsPath)}${directory ? `&directory=${encodeURIComponent(directory)}` : ""}`;
  return `${hubUrl.replace(/\/+$/, "")}/amicode/resolve-file?${query}`;
}

/** Layer 1's scope predicate: the path exists locally AND sits inside a
 *  discovered vault mount (realpath containment — mounts may be symlinked
 *  and a chat string may carry `..`; same idiom as the engine's
 *  containedExisting). */
function underVaultRoot(fsPath: string, roots: string[], exists: (p: string) => boolean): boolean {
  if (!exists(fsPath)) return false;
  let realTarget: string;
  try {
    realTarget = fs.realpathSync(fsPath);
  } catch {
    return false;
  }
  return roots.some((root) => {
    let realRoot: string;
    try {
      realRoot = fs.realpathSync(root);
    } catch {
      return false;
    }
    return realTarget === realRoot || realTarget.startsWith(realRoot + path.sep);
  });
}

const defaultVaultRoots = () => listMounts().map((m) => m.dir);

/** The engine's resolve-file body shape (file-resolve.ts): `{ok, found,
 *  path?}` on success, `{ok:false, error}` on a gated/bad ask. */
type HubResolveBody = { ok?: boolean; found?: boolean; path?: unknown; error?: unknown };

/** Resolve one chat link path per the posture (#1826's three layers). */
export async function resolveChatFileLink(fsPath: string, deps: ChatLinkDeps): Promise<ChatLinkResolution> {
  const exists = deps.exists ?? fs.existsSync;
  // Non-hub postures: the panel's server IS this disk (the spawned local
  // engine), so the local stat both routes and terminates — byte-identical
  // pre-#1826 behavior, including the silent refusal for stale paths.
  if (deps.posture !== "hub-client") {
    return exists(fsPath) ? { action: "preview", path: fsPath } : { action: "silent" };
  }
  // Layer 1 — vault roots only: a synced mount copy opens local.
  if (underVaultRoot(fsPath, (deps.vaultRoots ?? defaultVaultRoots)(), exists)) {
    return { action: "preview", path: fsPath };
  }
  // Layer 2 — the hub-client default: click-time re-resolution through the
  // hub's resolve-file route, then Preview via the hub SDK.
  const hubUrl = deps.hubUrl ?? "";
  if (hubUrl === "") return { action: "failed", reason: "tunnel-down", detail: "no hub URL configured" };
  let response: Response;
  try {
    response = await (deps.fetchImpl ?? hostProofFetch)(hubResolveUrl(hubUrl, fsPath, deps.directory), {
      signal: AbortSignal.timeout(RESOLVE_TIMEOUT_MS),
    });
  } catch {
    return { action: "failed", reason: "tunnel-down", detail: `${hubUrl} is unreachable` };
  }
  let body: HubResolveBody;
  try {
    body = (await response.json()) as HubResolveBody;
  } catch {
    return { action: "failed", reason: "tunnel-down", detail: `${hubUrl} did not answer JSON` };
  }
  if (body.ok !== true) {
    return {
      action: "failed",
      reason: "not-found-on-hub",
      detail: typeof body.error === "string" ? body.error : "the hub refused to resolve the path",
    };
  }
  if (body.found !== true) {
    return { action: "failed", reason: "not-found-on-hub", detail: `${fsPath} is not on the hub` };
  }
  // The hub-resolved path opens in Preview — the app fetches content from
  // `file.read` via the hub-bound session SDK.
  return { action: "preview", path: typeof body.path === "string" && body.path !== "" ? body.path : fsPath };
}
