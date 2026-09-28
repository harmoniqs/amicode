// session_peer_home_base.test.ts — #1643 (completes #1484 AC3): the service
// route resolving a remote peer's default working directory for a remote
// session.create.
//
//   GET /amicode/fleet/peer-home-base?machine=<id>
//
// A remote create needs a directory to create IN — the app cannot use its own
// projectDirectory (that path may not exist on the peer). This route resolves
// the peer's home-base directory via one small peer read. Unresolvable →
// {ok:false, reason:"no-remote-root"} so the app refuses the create with that
// exact blocked reason (NOT the §D4 roots fan-out, deliberately).
import { describe, it, expect } from "vitest";
import {
  peerHomeBaseResponse,
  resolvePeerHomeBase,
  type PeerHomeBaseDeps,
} from "../src/amicode_service/session_peer_home_base";

function parse(body: string) {
  return JSON.parse(body) as { ok: boolean; directory?: string; reason?: string };
}

describe("#1643 resolvePeerHomeBase — the peer's default working directory", () => {
  it("returns the peer's advertised home directory when present", () => {
    const dir = resolvePeerHomeBase("peer-a", {
      readPeerHomeDir: (id) => (id === "peer-a" ? "/Users/studio/work" : undefined),
    });
    expect(dir).toBe("/Users/studio/work");
  });

  it("returns undefined when the peer advertises no directory", () => {
    const dir = resolvePeerHomeBase("peer-a", { readPeerHomeDir: () => undefined });
    expect(dir).toBeUndefined();
  });

  it("returns undefined for an empty-string directory (unresolvable)", () => {
    const dir = resolvePeerHomeBase("peer-a", { readPeerHomeDir: () => "  " });
    expect(dir).toBeUndefined();
  });
});

describe("#1643 GET /amicode/fleet/peer-home-base — route", () => {
  const deps = (over?: Partial<PeerHomeBaseDeps>): PeerHomeBaseDeps => ({
    readPeerHomeDir: (id) => (id === "peer-a" ? "/Users/studio/work" : undefined),
    ...over,
  });

  it("missing machine param → 400 missing-machine", () => {
    const res = peerHomeBaseResponse(undefined, deps());
    expect(res.status).toBe(400);
    expect(parse(res.body).reason).toBe("missing-machine");
  });

  it("resolvable peer → ok with directory", () => {
    const res = peerHomeBaseResponse("peer-a", deps());
    const b = parse(res.body);
    expect(b.ok).toBe(true);
    expect(b.directory).toBe("/Users/studio/work");
  });

  it("unresolvable peer → ok:false with reason no-remote-root", () => {
    const res = peerHomeBaseResponse("peer-x", deps());
    const b = parse(res.body);
    expect(b.ok).toBe(false);
    expect(b.reason).toBe("no-remote-root");
  });
});
