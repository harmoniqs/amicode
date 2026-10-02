// peer_workspace_route.test.ts — #1643 remote-create unblock (peer-workspace).
//
// GET /amicode/fleet/peer-workspace — a machine's OWN honest description of its
// workspace for a remote-create picker: its home-base default directory (where
// a remote session lands when no project is chosen) + its projects. Served by
// the OWNING machine (the Studio serves its own truth); the local app fetches
// it when that machine is picked. Under /amicode/fleet/* (never proxied — a
// machine describing ITSELF). Extensible: worktrees/branches join later
// (the deferred cascade), the home_base field unblocks the create today.
import { describe, it, expect } from "vitest";
import { peerWorkspaceResponse, type PeerWorkspaceDeps } from "../src/amicode_service/peer_workspace_route";

function parse(body: string) {
  return JSON.parse(body) as {
    ok: boolean;
    home_base?: string;
    projects?: Array<{ slug: string; path: string }>;
  };
}

function deps(over?: Partial<PeerWorkspaceDeps>): PeerWorkspaceDeps {
  return {
    homeBaseDir: () => "/Users/studio/amico-projects",
    listProjects: () => [
      { slug: "qec-sweep", path: "/Users/studio/amico-projects/qec-sweep", type: "julia" },
      { slug: "transmon", path: "/Users/studio/amico-projects/transmon", type: "julia" },
    ],
    ...over,
  };
}

describe("#1643 GET /amicode/fleet/peer-workspace — a machine's own workspace truth", () => {
  it("returns ok with the home-base directory (the create's default landing dir)", () => {
    const res = peerWorkspaceResponse(deps());
    const b = parse(res.body);
    expect(b.ok).toBe(true);
    expect(b.home_base).toBe("/Users/studio/amico-projects");
  });

  it("returns the machine's projects", () => {
    const b = parse(peerWorkspaceResponse(deps()).body);
    expect(b.projects?.map((p) => p.slug)).toEqual(["qec-sweep", "transmon"]);
  });

  it("an empty project list is lawful (a machine with no projects yet)", () => {
    const b = parse(peerWorkspaceResponse(deps({ listProjects: () => [] })).body);
    expect(b.ok).toBe(true);
    expect(b.projects).toEqual([]);
    // home_base is still present — the create can land there even with no projects.
    expect(b.home_base).toBe("/Users/studio/amico-projects");
  });

  it("an unresolvable home-base yields ok:true with no home_base (honest — the create then blocks no-remote-root)", () => {
    const b = parse(peerWorkspaceResponse(deps({ homeBaseDir: () => undefined })).body);
    expect(b.ok).toBe(true);
    expect(b.home_base).toBeUndefined();
  });

  it("never throws: a listProjects that throws degrades to an empty list", () => {
    const b = parse(
      peerWorkspaceResponse(
        deps({
          listProjects: () => {
            throw new Error("readdir failed");
          },
        }),
      ).body,
    );
    expect(b.ok).toBe(true);
    expect(b.projects).toEqual([]);
    expect(b.home_base).toBe("/Users/studio/amico-projects");
  });
});
