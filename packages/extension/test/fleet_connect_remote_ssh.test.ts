// Tests for issue #1271 — "Opt-in entry: connect the editor to the hub over
// Remote-SSH". The command resolves the hub coordinates from the projection
// (the ONE topology reader, ADR 0023 — never a hand-built host string or a
// second config source) and opens a Remote-SSH window onto the hub workspace.
//
// AC1: a command connects the editor to the hub host via Remote-SSH using
//      coordinates resolved from the projection.
// AC2: missing/invalid hub coordinates produce an honest, actionable message —
//      no crash, no half-opened window.
//
// The URI/authority construction is a PURE function (resolveRemoteSshTarget);
// the topology→resolution adapter (resolveRemoteSshFromTopology) preserves the
// reader's own actionable messages verbatim; the thin handler
// (connectToHubOverRemoteSsh) wires them to readFleetTopology + executeCommand.

import { describe, it, expect, beforeEach } from "vitest";
import {
  resolveRemoteSshTarget,
  resolveRemoteSshFromTopology,
  connectToHubOverRemoteSsh,
  DEFAULT_HUB_WORKSPACE_PATH,
} from "../src/fleet_connect_remote_ssh";
import type { FleetTopologyState } from "../src/fleet_topology";
import * as vscode from "vscode";

// Minimal topology-state builders — the resolver reads only `.kind`, `.canonical`
// (ok) or `.detail` (absent/broken), so a cast-through minimal object is enough.
const okTopology = (canonical?: { host?: string; port?: number; sshAlias?: string }): FleetTopologyState =>
  ({
    kind: "ok",
    role: "client",
    mode: "fleet",
    posture: "ok",
    freshness: {},
    provenanceSource: "test",
    projection: {} as never,
    ...(canonical ? { canonical } : {}),
  }) as unknown as FleetTopologyState;
const absentTopology = (): FleetTopologyState =>
  ({
    kind: "absent",
    detail:
      "fleet projection absent at /home/jj/.amico/ops/fleet/projection.json — refresh it with `amico fleet status --projection`",
  }) as FleetTopologyState;
const brokenTopology = (): FleetTopologyState =>
  ({
    kind: "broken",
    detail: "fleet projection failed the contract read: boom — refresh via `amico fleet status --projection`",
  }) as FleetTopologyState;

describe("resolveRemoteSshTarget (pure URI/authority construction — AC1)", () => {
  it("builds the Remote-SSH URI from the canonical sshAlias + the home default path", () => {
    const r = resolveRemoteSshTarget({ host: "100.104.59.70", port: 4096, sshAlias: "amico-erlich" });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.authority).toBe("ssh-remote+amico-erlich");
      expect(r.path).toBe("~");
      expect(r.uri).toBe("vscode-remote://ssh-remote+amico-erlich/~");
    }
  });

  it("uses a configured absolute workspace path verbatim", () => {
    const r = resolveRemoteSshTarget({ host: "h", sshAlias: "hub" }, "/home/jj/amicode");
    expect(r).toEqual({
      ok: true,
      authority: "ssh-remote+hub",
      path: "/home/jj/amicode",
      uri: "vscode-remote://ssh-remote+hub/home/jj/amicode",
    });
  });

  it("accepts a home-relative (~) configured path", () => {
    const r = resolveRemoteSshTarget({ host: "h", sshAlias: "hub" }, "~/amicode");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.uri).toBe("vscode-remote://ssh-remote+hub/~/amicode");
  });

  it("trims the alias (mirrors resolveHubTarget)", () => {
    const r = resolveRemoteSshTarget({ host: "h", sshAlias: " hub " });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.authority).toBe("ssh-remote+hub");
  });

  it("a blank configured workspace path falls back to the home default (not an error)", () => {
    const r = resolveRemoteSshTarget({ host: "h", sshAlias: "hub" }, "   ");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.path).toBe(DEFAULT_HUB_WORKSPACE_PATH);
    expect(DEFAULT_HUB_WORKSPACE_PATH).toBe("~");
  });
});

describe("resolveRemoteSshTarget (cannot resolve — AC2)", () => {
  it("is a no-ssh-alias reason without any canonical (undefined)", () => {
    const r = resolveRemoteSshTarget(undefined);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe("no-ssh-alias");
      expect(r.detail).toMatch(/amico fleet status --projection/);
    }
  });

  it("is a no-ssh-alias reason when the canonical carries no sshAlias", () => {
    const r = resolveRemoteSshTarget({ host: "h", port: 4096 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("no-ssh-alias");
  });

  it("is a no-ssh-alias reason when the sshAlias is blank", () => {
    const r = resolveRemoteSshTarget({ host: "h", sshAlias: "   " });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("no-ssh-alias");
  });

  it("rejects a relative configured workspace path — never a half-window", () => {
    const r = resolveRemoteSshTarget({ host: "h", sshAlias: "hub" }, "amicode/sub");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe("invalid-workspace-path");
      expect(r.detail).toContain("amicode/sub");
      expect(r.detail).toMatch(/hubWorkspacePath/);
    }
  });
});

describe("resolveRemoteSshFromTopology (one topology reader → resolution)", () => {
  it("delegates an ok topology to the pure resolver", () => {
    const r = resolveRemoteSshFromTopology(okTopology({ host: "h", port: 4096, sshAlias: "hub" }));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.uri).toBe("vscode-remote://ssh-remote+hub/~");
  });

  it("surfaces an absent projection's actionable message VERBATIM (AC2)", () => {
    const state = absentTopology();
    const r = resolveRemoteSshFromTopology(state);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe("topology-absent");
      expect(r.detail).toBe((state as { detail: string }).detail);
    }
  });

  it("surfaces a broken projection's rejection VERBATIM (AC2)", () => {
    const state = brokenTopology();
    const r = resolveRemoteSshFromTopology(state);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe("topology-broken");
      expect(r.detail).toBe((state as { detail: string }).detail);
    }
  });

  it("an ok topology with no canonical is a no-ssh-alias reason", () => {
    const r = resolveRemoteSshFromTopology(okTopology());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("no-ssh-alias");
  });
});

function spies() {
  const opened: string[] = [];
  const errors: string[] = [];
  return {
    opened,
    errors,
    openFolder: (uri: string) => {
      opened.push(uri);
    },
    showError: (msg: string) => {
      errors.push(msg);
    },
  };
}

const openFolderCalls = () => vscode.commands.executed.filter((id) => id === "vscode.openFolder");

describe("connectToHubOverRemoteSsh (thin command handler)", () => {
  beforeEach(() => {
    vscode.commands.executed.length = 0;
  });

  it("AC1: opens the Remote-SSH folder exactly once with the resolved URI, no error", async () => {
    const s = spies();
    const r = await connectToHubOverRemoteSsh({
      readTopology: () => okTopology({ host: "h", port: 4096, sshAlias: "hub" }),
      openFolder: s.openFolder,
      showError: s.showError,
    });
    expect(r.ok).toBe(true);
    expect(s.opened).toEqual(["vscode-remote://ssh-remote+hub/~"]);
    expect(s.errors).toEqual([]);
  });

  it("AC1: the default openFolder wiring calls executeCommand('vscode.openFolder') exactly once", async () => {
    const r = await connectToHubOverRemoteSsh({
      readTopology: () => okTopology({ host: "h", sshAlias: "hub" }),
    });
    expect(r.ok).toBe(true);
    expect(openFolderCalls()).toHaveLength(1);
  });

  it("AC1: passes a configured workspace path through into the URI", async () => {
    const s = spies();
    await connectToHubOverRemoteSsh({
      readTopology: () => okTopology({ host: "h", sshAlias: "hub" }),
      workspacePath: "/srv/amicode",
      openFolder: s.openFolder,
      showError: s.showError,
    });
    expect(s.opened).toEqual(["vscode-remote://ssh-remote+hub/srv/amicode"]);
  });

  it("AC2: an absent projection shows the actionable message and opens NO window", async () => {
    const s = spies();
    const r = await connectToHubOverRemoteSsh({
      readTopology: () => absentTopology(),
      openFolder: s.openFolder,
      showError: s.showError,
    });
    expect(r.ok).toBe(false);
    expect(s.opened).toEqual([]);
    expect(s.errors).toHaveLength(1);
    expect(s.errors[0]).toContain("amico fleet status --projection");
  });

  it("AC2: a broken projection shows the reader's rejection and opens NO window", async () => {
    const s = spies();
    const r = await connectToHubOverRemoteSsh({
      readTopology: () => brokenTopology(),
      openFolder: s.openFolder,
      showError: s.showError,
    });
    expect(r.ok).toBe(false);
    expect(s.opened).toEqual([]);
    expect(s.errors).toHaveLength(1);
  });

  it("AC2: an ok projection with no sshAlias shows an actionable message and opens NO window", async () => {
    const s = spies();
    const r = await connectToHubOverRemoteSsh({
      readTopology: () => okTopology({ host: "h" }),
      openFolder: s.openFolder,
      showError: s.showError,
    });
    expect(r.ok).toBe(false);
    expect(s.opened).toEqual([]);
    expect(s.errors).toHaveLength(1);
    expect(s.errors[0]).toMatch(/amico fleet status --projection|Fleet — Repair/);
  });

  it("AC2: a misconfigured (relative) workspace path shows an actionable message and opens NO window", async () => {
    const s = spies();
    const r = await connectToHubOverRemoteSsh({
      readTopology: () => okTopology({ host: "h", sshAlias: "hub" }),
      workspacePath: "relative/path",
      openFolder: s.openFolder,
      showError: s.showError,
    });
    expect(r.ok).toBe(false);
    expect(s.opened).toEqual([]);
    expect(s.errors[0]).toContain("relative/path");
  });

  it("AC2: every error path makes ZERO vscode.openFolder executeCommand calls (default wiring)", async () => {
    await connectToHubOverRemoteSsh({ readTopology: () => absentTopology() });
    await connectToHubOverRemoteSsh({ readTopology: () => brokenTopology() });
    await connectToHubOverRemoteSsh({ readTopology: () => okTopology({ host: "h" }) });
    expect(openFolderCalls()).toHaveLength(0);
  });

  it("does not crash when the topology reader itself throws (honest error, no half-window)", async () => {
    const s = spies();
    const r = await connectToHubOverRemoteSsh({
      readTopology: () => {
        throw new Error("projection read blew up");
      },
      openFolder: s.openFolder,
      showError: s.showError,
    });
    expect(r.ok).toBe(false);
    expect(s.opened).toEqual([]);
    expect(s.errors).toHaveLength(1);
  });
});
