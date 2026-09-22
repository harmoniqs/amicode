// Tests for the connect-to-device Quick Pick handler (#1413, ADR 0030 §D1/D2).

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  handleConnectToDevice,
  resolveDevice,
  buildRemoteQuickPickItems,
  type ConnectToDeviceMessage,
  type FleetConnectDeps,
  type ConnectQuickPickItem,
} from "../src/fleet_connect_device";
import type { RosterRow } from "@amicode/schema";
import type { FleetTopologyState } from "../src/fleet_topology";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeAttachmentCredential } from "../src/amicode_service/attachment_credential";

// ── Test helpers ─────────────────────────────────────────────────────────────

const rosterRow = (over: Partial<RosterRow> = {}): RosterRow => ({
  machine_id: "peer-01",
  name: "Peer One",
  server_mode: "server",
  capabilities: ["serving"],
  sshAlias: "peer-one@host",
  transport: "ssh",
  last_report: "2026-09-21T12:00:00.000Z",
  health: "reachable",
  ...over,
});

const okTopology = (canonical?: { host?: string; port?: number; sshAlias?: string }): FleetTopologyState =>
  ({
    kind: "ok",
    role: "client",
    canonical,
    mode: "fleet",
    posture: "ok",
    freshness: {},
    provenanceSource: "test",
    projection: {} as never,
  }) as unknown as FleetTopologyState;

function makeDeps(overrides: Partial<FleetConnectDeps> = {}): FleetConnectDeps {
  // Use a temp dir for credential lookups so we don't read from the real system
  const tmpDir = mkdtempSync(join(tmpdir(), "fleet-connect-device-"));
  return {
    credentialFile: join(tmpDir, "attachment-credentials.json"),
    readRoster: () => [],
    readTopology: () => okTopology(),
    attachToDevice: async () => ({ ok: true, switched: true }),
    connectRemoteSsh: async () => ({ ok: true, authority: "ssh-remote+hub", path: "~", uri: "vscode-remote://ssh-remote+hub/~" }),
    goStandalone: () => {},
    isRemoteSshAvailable: () => true,
    reloadWindow: async () => {},
    showQuickPick: async () => undefined,
    showWarningMessage: async () => undefined,
    showInformationMessage: async () => undefined,
    ...overrides,
  };
}

const remoteMsg = (machineId = "peer-01", deviceName = "Peer One"): ConnectToDeviceMessage => ({
  kind: "connect-to-device",
  machineId,
  deviceName,
  isLocal: false,
});

const localMsg = (machineId = "local-01", deviceName = "This Machine"): ConnectToDeviceMessage => ({
  kind: "connect-to-device",
  machineId,
  deviceName,
  isLocal: true,
});

// ── resolveDevice ────────────────────────────────────────────────────────────

describe("resolveDevice — two-branch resolution (#1413)", () => {
  it("resolves from a roster row", () => {
    const deps = makeDeps({
      readRoster: () => [rosterRow({ machine_id: "peer-01", sshAlias: "studio", capabilities: ["serving", "compute"] })],
    });
    const d = resolveDevice(remoteMsg("peer-01"), deps);
    expect(d.sshAlias).toBe("studio");
    expect(d.capabilities).toEqual(["serving", "compute"]);
    expect(d.health).toBe("reachable");
  });

  it("falls back to topology canonical when roster misses", () => {
    const deps = makeDeps({
      readRoster: () => [],
      readTopology: () => okTopology({ host: "192.168.1.100", sshAlias: "mac-studio" }),
    });
    const d = resolveDevice(remoteMsg("192.168.1.100", "Mac Studio"), deps);
    expect(d.sshAlias).toBe("mac-studio");
    expect(d.capabilities).toEqual(["serving"]);
    expect(d.isHub).toBe(true);
  });

  it("returns minimal info when both roster and topology miss", () => {
    const deps = makeDeps({
      readRoster: () => [],
      readTopology: () => okTopology({ host: "other-machine" }),
    });
    const d = resolveDevice(remoteMsg("ghost-99"), deps);
    expect(d.sshAlias).toBeUndefined();
    expect(d.capabilities).toBeUndefined();
  });
});

// ── buildRemoteQuickPickItems ────────────────────────────────────────────────

describe("buildRemoteQuickPickItems — precondition gating (#1413)", () => {
  it("both options enabled when all preconditions met", () => {
    const items = buildRemoteQuickPickItems({
      machineId: "p", name: "P", isLocal: false,
      sshAlias: "alias", capabilities: ["serving"], health: "reachable",
      hasStoredCredential: true,
    }, true);
    expect(items).toHaveLength(2);
    // Enabled items have `detail` but no `description`
    expect(items[0].description).toBeUndefined();
    expect(items[1].description).toBeUndefined();
  });

  it("thin client disabled when target lacks serving capability", () => {
    const items = buildRemoteQuickPickItems({
      machineId: "p", name: "P", isLocal: false,
      capabilities: [], health: "reachable", hasStoredCredential: true,
    }, true);
    expect(items[0].action).toBe("thin-client");
    expect(items[0].description).toBe("Not running a server");
  });

  it("thin client disabled when target health is down", () => {
    const items = buildRemoteQuickPickItems({
      machineId: "p", name: "P", isLocal: false,
      capabilities: ["serving"], health: "down", hasStoredCredential: true,
    }, true);
    expect(items[0].description).toBe("Device unreachable");
  });

  it("thin client enabled even without stored credential (credential is not a gate)", () => {
    const items = buildRemoteQuickPickItems({
      machineId: "p", name: "P", isLocal: false,
      capabilities: ["serving"], health: "reachable", hasStoredCredential: false,
    }, true);
    expect(items[0].action).toBe("thin-client");
    expect(items[0].description).toBeUndefined(); // enabled — no description
    expect(items[0].detail).toBeDefined();
  });

  it("remote ssh disabled when extension not installed", () => {
    const items = buildRemoteQuickPickItems({
      machineId: "p", name: "P", isLocal: false,
      capabilities: ["serving"], health: "reachable", hasStoredCredential: true,
      sshAlias: "alias",
    }, false);
    expect(items[1].description).toContain("Remote-SSH extension");
  });

  it("remote ssh disabled when no sshAlias", () => {
    const items = buildRemoteQuickPickItems({
      machineId: "p", name: "P", isLocal: false,
      capabilities: ["serving"], health: "reachable", hasStoredCredential: true,
    }, true);
    expect(items[1].description).toBe("No SSH alias configured");
  });
});

// ── handleConnectToDevice — remote device ────────────────────────────────────

describe("handleConnectToDevice — remote device (#1413)", () => {
  it("thin client: calls attach + reload on confirm", async () => {
    let attached = false;
    let reloaded = false;
    const tmpDir = mkdtempSync(join(tmpdir(), "fleet-tc-"));
    const credentialFile = join(tmpDir, "creds.json");
    // Write a stored credential so Thin Client is enabled
    writeAttachmentCredential("peer-01", { baseUrl: "http://127.0.0.1:4096", token: "tok" }, { credentialFile });
    const deps = makeDeps({
      credentialFile,
      readRoster: () => [rosterRow({ machine_id: "peer-01", capabilities: ["serving"] })],
      showQuickPick: async (items: ConnectQuickPickItem[]) =>
        items.find((i) => i.action === "thin-client" && !i.description),
      showInformationMessage: async () => "Continue",
      attachToDevice: async (p) => { attached = true; expect(p.machine_id).toBe("peer-01"); return { ok: true }; },
      reloadWindow: async () => { reloaded = true; },
    });
    await handleConnectToDevice(remoteMsg("peer-01"), deps);
    expect(attached).toBe(true);
    expect(reloaded).toBe(true);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("thin client: does NOT reload when user cancels confirmation", async () => {
    let reloaded = false;
    const tmpDir = mkdtempSync(join(tmpdir(), "fleet-tc-cancel-"));
    const credentialFile = join(tmpDir, "creds.json");
    writeAttachmentCredential("peer-01", { baseUrl: "http://127.0.0.1:4096", token: "tok" }, { credentialFile });
    const deps = makeDeps({
      credentialFile,
      readRoster: () => [rosterRow({ machine_id: "peer-01", capabilities: ["serving"] })],
      showQuickPick: async (items: ConnectQuickPickItem[]) =>
        items.find((i) => i.action === "thin-client" && !i.description),
      showInformationMessage: async () => "Cancel",
      reloadWindow: async () => { reloaded = true; },
    });
    await handleConnectToDevice(remoteMsg("peer-01"), deps);
    expect(reloaded).toBe(false);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("remote ssh: calls connectRemoteSsh with the alias", async () => {
    let calledWith = "";
    const deps = makeDeps({
      readRoster: () => [rosterRow({ machine_id: "peer-01", sshAlias: "studio" })],
      showQuickPick: async (items: ConnectQuickPickItem[]) =>
        items.find((i) => i.action === "remote-ssh" && !i.description),
      connectRemoteSsh: async (alias) => { calledWith = alias; return { ok: true, authority: "", path: "", uri: "" }; },
    });
    await handleConnectToDevice(remoteMsg("peer-01"), deps);
    expect(calledWith).toBe("studio");
  });

  it("disabled item shows a warning toast with the reason", async () => {
    let attached = false;
    let sshCalled = false;
    let warningMsg = "";
    const deps = makeDeps({
      readRoster: () => [rosterRow({ machine_id: "peer-01", capabilities: [] })], // no serving
      showQuickPick: async (items: ConnectQuickPickItem[]) =>
        items.find((i) => i.action === "thin-client"), // the disabled one
      attachToDevice: async () => { attached = true; return { ok: true }; },
      connectRemoteSsh: async () => { sshCalled = true; return { ok: true, authority: "", path: "", uri: "" }; },
      showWarningMessage: async (msg: string) => { warningMsg = msg; return undefined; },
    });
    await handleConnectToDevice(remoteMsg("peer-01"), deps);
    expect(attached).toBe(false);
    expect(sshCalled).toBe(false);
    expect(warningMsg).toBe("Not running a server");
  });

  it("disabled 'device unreachable' item shows the right toast", async () => {
    let warningMsg = "";
    const deps = makeDeps({
      readRoster: () => [rosterRow({ machine_id: "peer-01", capabilities: ["serving"], health: "down" })],
      showQuickPick: async (items: ConnectQuickPickItem[]) =>
        items.find((i) => i.action === "thin-client"),
      showWarningMessage: async (msg: string) => { warningMsg = msg; return undefined; },
    });
    await handleConnectToDevice(remoteMsg("peer-01"), deps);
    expect(warningMsg).toBe("Device unreachable");
  });

  it("dismissed quick pick (undefined) is a no-op", async () => {
    let attached = false;
    const deps = makeDeps({
      readRoster: () => [rosterRow({ machine_id: "peer-01" })],
      showQuickPick: async () => undefined,
      attachToDevice: async () => { attached = true; return { ok: true }; },
    });
    await handleConnectToDevice(remoteMsg("peer-01"), deps);
    expect(attached).toBe(false);
  });
});

// ── handleConnectToDevice — local device ─────────────────────────────────────

describe("handleConnectToDevice — local device (#1413)", () => {
  it("go standalone: calls goStandalone on pick", async () => {
    let standalone = false;
    const deps = makeDeps({
      showQuickPick: async (items: ConnectQuickPickItem[]) =>
        items.find((i) => i.action === "go-standalone"),
      goStandalone: () => { standalone = true; },
    });
    await handleConnectToDevice(localMsg(), deps);
    expect(standalone).toBe(true);
  });

  it("hub-specific warning: shows device count and requires confirmation", async () => {
    let warningMsg = "";
    let standalone = false;
    const deps = makeDeps({
      readRoster: () => [rosterRow(), rosterRow({ machine_id: "peer-02" })],
      readTopology: () => okTopology({ host: "local-01", sshAlias: "local" }),
      showWarningMessage: async (msg: string) => { warningMsg = msg; return "Go Standalone"; },
      goStandalone: () => { standalone = true; },
    });
    await handleConnectToDevice(localMsg("local-01"), deps);
    expect(warningMsg).toContain("disconnect");
    expect(warningMsg).toContain("1 other device"); // 2 in roster - 1 self = 1
    expect(standalone).toBe(true);
  });

  it("hub-specific warning: cancel does NOT call goStandalone", async () => {
    let standalone = false;
    const deps = makeDeps({
      readRoster: () => [rosterRow(), rosterRow({ machine_id: "peer-02" })],
      readTopology: () => okTopology({ host: "local-01", sshAlias: "local" }),
      showWarningMessage: async () => "Cancel",
      goStandalone: () => { standalone = true; },
    });
    await handleConnectToDevice(localMsg("local-01"), deps);
    expect(standalone).toBe(false);
  });
});
