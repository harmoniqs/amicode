// #1322 — the Fleet Manager tab's command routing (AC5). The standalone
// Fleet & Versions webview panel is RETIRED; its command (amicode.fleet.versions)
// and the sidebar's amicode.openFleetManager both route to the Work Column tab
// by broadcasting an `open-fleet-manager` message to the live chat webview(s).
// The Versions route carries the `amico doctor` report so the tab's Versions
// section renders the same content the retired panel showed.
import { describe, it, expect, vi, beforeEach } from "vitest";
import * as vscode from "vscode";
import {
  buildOpenFleetManagerMessage,
  registerFleetManagerCommands,
  OPEN_FLEET_MANAGER_KIND,
} from "../src/fleet_manager_command";
import { registerFleetPanel, _resetFleetPanelForTesting } from "../src/fleet_panel";
import type { DoctorReport } from "../src/fleet_panel";

const ctx = () => ({ subscriptions: [] as unknown[], extensionUri: vscode.Uri.file("/ext") });

const REPORT: DoctorReport = {
  surfaces: [{ surface: "extension", version: "0.3.6", source_version: "0.3.6", verdict: "current", evidence: ["ok"] }],
};

describe("buildOpenFleetManagerMessage — the open-fleet-manager envelope", () => {
  it("carries source/kind, with section + localMachineId optional", () => {
    expect(buildOpenFleetManagerMessage({})).toEqual({ source: "amicode", kind: OPEN_FLEET_MANAGER_KIND });
    expect(buildOpenFleetManagerMessage({ section: "versions" })).toEqual({
      source: "amicode",
      kind: OPEN_FLEET_MANAGER_KIND,
      section: "versions",
    });
    expect(buildOpenFleetManagerMessage({ localMachineId: "m1" })).toEqual({
      source: "amicode",
      kind: OPEN_FLEET_MANAGER_KIND,
      localMachineId: "m1",
    });
  });

  it("carries window-mode as its OWN field (a separate axis from posture, ADR 0025 #4)", () => {
    expect(buildOpenFleetManagerMessage({ windowMode: "remote-ssh" })).toEqual({
      source: "amicode",
      kind: OPEN_FLEET_MANAGER_KIND,
      windowMode: "remote-ssh",
    });
  });
});

describe("registerFleetManagerCommands — routes to the Work Column tab", () => {
  it("amicode.openFleetManager opens the tab (broadcast to the chat webviews)", async () => {
    const posted: Array<Record<string, unknown>> = [];
    registerFleetManagerCommands(ctx() as never, {
      postToAll: (m) => posted.push(m as Record<string, unknown>),
      localMachineId: () => "m1",
    });
    await vscode.commands.executeCommand("amicode.openFleetManager");
    expect(posted).toHaveLength(1);
    expect(posted[0].kind).toBe(OPEN_FLEET_MANAGER_KIND);
    expect(posted[0].localMachineId).toBe("m1");
  });

  it("amicode.fleet.versions (the retired panel's command) opens the tab's Versions section, carrying the doctor report", async () => {
    const posted: Array<Record<string, unknown>> = [];
    const doctor = vi.fn(async () => ({ ok: true, report: REPORT, error: null }));
    registerFleetManagerCommands(ctx() as never, {
      postToAll: (m) => posted.push(m as Record<string, unknown>),
      localMachineId: () => null,
      doctor,
    });
    await vscode.commands.executeCommand("amicode.fleet.versions");
    expect(doctor).toHaveBeenCalledTimes(1);
    expect(posted).toHaveLength(1);
    expect(posted[0].section).toBe("versions");
    // the retired panel's content rides along so the tab's Versions section renders it
    expect(posted[0].report).toEqual(REPORT);
  });

  it("amicode.fleet.versions still routes even when doctor is unavailable (honest, report omitted)", async () => {
    const posted: Array<Record<string, unknown>> = [];
    registerFleetManagerCommands(ctx() as never, { postToAll: (m) => posted.push(m as Record<string, unknown>) });
    await vscode.commands.executeCommand("amicode.fleet.versions");
    expect(posted).toHaveLength(1);
    expect(posted[0].section).toBe("versions");
    expect(posted[0].report).toBeUndefined();
  });
});

describe("registerFleetPanel — the standalone Fleet & Versions panel is RETIRED (AC5)", () => {
  beforeEach(() => _resetFleetPanelForTesting());

  it("no longer registers a webview-panel command (its command routes to the tab instead)", async () => {
    const spy = vi.spyOn(vscode.commands, "registerCommand");
    registerFleetPanel(ctx() as never, {});
    // The retired panel registers NOTHING — amicode.fleet.versions is owned by
    // registerFleetManagerCommands now, which routes to the Work Column tab.
    const registered = spy.mock.calls.map((c) => c[0]);
    expect(registered).not.toContain("amicode.fleet.versions");
    spy.mockRestore();
  });
});
