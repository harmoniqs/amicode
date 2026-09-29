// SESSION PEER HOME BASE (#1643, completes #1484 AC3) — resolves the default
// working directory for a remote session.create.
//
//   GET /amicode/fleet/peer-home-base?machine=<id>
//
// A remote create needs a directory that exists ON THE PEER — the app's own
// projectDirectory may not. This route performs ONE small peer read to resolve
// the peer's home-base directory. Unresolvable → {ok:false, reason:"no-remote-root"}
// so the app refuses the create with that exact reason.
//
// Deliberately NOT the ADR 0031 §D4 project-roots fan-out (which does not exist
// yet): a single home-base default, bounded to this slice. Under /amicode/fleet/*
// (never proxied — the resolution is driven from THIS machine's fleet view).

export interface PeerHomeBaseDeps {
  /** Read the peer's advertised home/default working directory (SYNC). Kept for
   *  back-compat / unit tests; the live route uses `resolveHomeDir` instead. */
  readPeerHomeDir: (peerId: string) => string | undefined;
  /** Resolve the peer's home directory via a live peer read (ASYNC, preferred).
   *  When present, it takes precedence over readPeerHomeDir. */
  resolveHomeDir?: (peerId: string) => Promise<string | undefined>;
}

export interface RouteResult {
  status?: number;
  body: string;
}

/** Resolve the peer's home-base directory, or undefined if unresolvable.
 *  An empty/whitespace directory is treated as unresolvable (not a valid root). */
export function resolvePeerHomeBase(peerId: string, deps: PeerHomeBaseDeps): string | undefined {
  const dir = deps.readPeerHomeDir(peerId);
  if (typeof dir !== "string") return undefined;
  const trimmed = dir.trim();
  return trimmed === "" ? undefined : trimmed;
}

/** GET /amicode/fleet/peer-home-base?machine=<id>. Never throws. Async so the
 *  live peer read (resolveHomeDir) can dial the owning machine; a purely-sync
 *  deps set still resolves synchronously-then-wrapped. */
export async function peerHomeBaseResponse(
  machine: string | undefined,
  deps: PeerHomeBaseDeps,
): Promise<RouteResult> {
  if (machine === undefined || machine.trim() === "") {
    return { status: 400, body: JSON.stringify({ ok: false, reason: "missing-machine" }) };
  }
  let directory: string | undefined;
  if (deps.resolveHomeDir) {
    const dir = await deps.resolveHomeDir(machine);
    directory = typeof dir === "string" && dir.trim() !== "" ? dir.trim() : undefined;
  } else {
    directory = resolvePeerHomeBase(machine, deps);
  }
  if (directory === undefined) {
    return { status: 200, body: JSON.stringify({ ok: false, reason: "no-remote-root" }) };
  }
  return { status: 200, body: JSON.stringify({ ok: true, directory }) };
}
