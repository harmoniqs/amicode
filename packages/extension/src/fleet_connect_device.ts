// fleet_connect_device.ts — Connect-to-device Quick Pick handler (#1413,
// ADR 0030 §D1/D2/D5/D6/D7). The user-facing integration layer: a device row
// click in the sidebar posts a connect-to-device bridge message, and this module
// shows the Quick Pick and dispatches to the appropriate connection path.
//
// For remote devices: "Thin Client (Poor Connection)" or "Remote SSH (Strong Connection)".
// For the local device: "Go Standalone".
//
// All precondition data (sshAlias, capabilities, health, credentials) is resolved
// host-side from the roster and topology — the webview message carries identity only.

import type { RosterRow } from "@amicode/schema";
import type { FleetTopologyState, FleetCanonical } from "./fleet_topology";
import { canonicalMachineId } from "./fleet_topology";
import type { RemoteSshResolution } from "./fleet_connect_remote_ssh";
import { readAttachmentCredential, type AttachmentCredentialDeps } from "./amicode_service/attachment_credential";

// ── Types ────────────────────────────────────────────────────────────────────

/** The bridge message the webview posts on a device row click. */
export interface ConnectToDeviceMessage {
  kind: "connect-to-device";
  machineId: string;
  deviceName: string;
  isLocal: boolean;
}

/** The Quick Pick item shape — VS Code's QuickPickItem with our metadata. */
export interface ConnectQuickPickItem {
  label: string;
  description?: string;
  detail?: string;
  picked?: boolean;
  /** Internal dispatch tag — not shown to the user. */
  action: "thin-client" | "remote-ssh" | "go-standalone";
}

/** Resolved device info — everything the Quick Pick needs to gate options. */
export interface ResolvedDevice {
  machineId: string;
  name: string;
  isLocal: boolean;
  sshAlias?: string;
  serverMode?: string;
  capabilities?: string[];
  health?: string;
  hasStoredCredential: boolean;
  isHub?: boolean;
  deviceCount?: number;
}

/** Injectable deps for the connect handler. Separate from the read-only
 *  FleetSectionDeps — ADR 0030 §D6. */
export interface FleetConnectDeps extends AttachmentCredentialDeps {
  readRoster: () => RosterRow[];
  readTopology: () => FleetTopologyState;
  attachToDevice: (payload: { machine_id: string; base_url?: string; token?: string }) => Promise<{ ok: boolean; switched?: boolean }>;
  connectRemoteSsh: (sshAlias: string) => Promise<RemoteSshResolution>;
  goStandalone: () => void;
  isRemoteSshAvailable: () => boolean;
  reloadWindow: () => Promise<void>;
  showQuickPick: <T extends ConnectQuickPickItem>(items: T[], opts?: { title?: string; placeHolder?: string }) => Promise<T | undefined>;
  showWarningMessage: (msg: string, ...items: string[]) => Promise<string | undefined>;
  showInformationMessage: (msg: string, ...items: string[]) => Promise<string | undefined>;
}

// ── Device resolution ────────────────────────────────────────────────────────

/** Resolve full device info from identity (machineId + isLocal). Two-branch
 *  resolution: roster lookup first, then topology fallback for the canonical
 *  server (ADR 0030 §D4). */
export function resolveDevice(msg: ConnectToDeviceMessage, deps: FleetConnectDeps): ResolvedDevice {
  const roster = deps.readRoster();
  const rosterMatch = roster.find((r) => r.machine_id === msg.machineId);

  if (rosterMatch) {
    const cred = readAttachmentCredential(msg.machineId, deps);
    return {
      machineId: msg.machineId,
      name: msg.deviceName,
      isLocal: msg.isLocal,
      sshAlias: rosterMatch.sshAlias,
      serverMode: rosterMatch.server_mode,
      capabilities: rosterMatch.capabilities,
      health: rosterMatch.health,
      hasStoredCredential: cred.ok,
      isHub: false,
      deviceCount: roster.length,
    };
  }

  // Topology fallback — canonical server synthesized row
  let topology: FleetTopologyState;
  try {
    topology = deps.readTopology();
  } catch {
    return {
      machineId: msg.machineId,
      name: msg.deviceName,
      isLocal: msg.isLocal,
      hasStoredCredential: false,
      deviceCount: roster.length,
    };
  }
  if (topology.kind === "ok" && topology.canonical) {
    const cid = canonicalMachineId(topology.canonical);
    if (cid === msg.machineId) {
      const cred = readAttachmentCredential(msg.machineId, deps);
      return {
        machineId: msg.machineId,
        name: msg.deviceName,
        isLocal: msg.isLocal,
        sshAlias: topology.canonical.sshAlias,
        serverMode: "server",
        capabilities: ["serving"], // canonical is serving by definition
        health: "reachable", // optimistic — the topology exists
        hasStoredCredential: cred.ok,
        isHub: true,
        deviceCount: roster.length,
      };
    }
  }

  return {
    machineId: msg.machineId,
    name: msg.deviceName,
    isLocal: msg.isLocal,
    hasStoredCredential: false,
    deviceCount: roster.length,
  };
}

// ── Quick Pick item builder ──────────────────────────────────────────────────

/** Build the Quick Pick items for a remote device. Items are disabled (with a
 *  note) when their preconditions are unmet. */
export function buildRemoteQuickPickItems(device: ResolvedDevice, remoteSshAvailable: boolean): ConnectQuickPickItem[] {
  const items: ConnectQuickPickItem[] = [];
  const hasServing = device.capabilities?.includes("serving") ?? false;
  const isDown = device.health === "down";
  const hasAlias = typeof device.sshAlias === "string" && device.sshAlias.trim() !== "";

  // Thin Client option
  if (!hasServing) {
    items.push({ label: "$(cloud) Thin Client (Poor Connection)", description: "Not running a server", action: "thin-client" });
  } else if (isDown) {
    items.push({ label: "$(cloud) Thin Client (Poor Connection)", description: "Device unreachable", action: "thin-client" });
  } else if (!device.hasStoredCredential) {
    items.push({ label: "$(cloud) Thin Client (Poor Connection)", description: "No credentials available — use the Fleet Manager to connect", action: "thin-client" });
  } else {
    items.push({ label: "$(cloud) Thin Client (Poor Connection)", detail: "Re-attach to this device and reload the window", action: "thin-client" });
  }

  // Remote SSH option
  if (!remoteSshAvailable) {
    items.push({ label: "$(terminal) Remote SSH (Strong Connection)", description: "Requires Remote-SSH extension", action: "remote-ssh" });
  } else if (!hasAlias) {
    items.push({ label: "$(terminal) Remote SSH (Strong Connection)", description: "No SSH alias configured", action: "remote-ssh" });
  } else {
    items.push({ label: "$(terminal) Remote SSH (Strong Connection)", detail: "Open a new VS Code window connected via SSH", action: "remote-ssh" });
  }

  return items;
}

/** Check if a Quick Pick item is enabled (no description = enabled; description = disabled note). */
function isItemEnabled(item: ConnectQuickPickItem): boolean {
  return item.description === undefined;
}

// ── Main handler ─────────────────────────────────────────────────────────────

/** The main connect-to-device handler. Shows a Quick Pick and dispatches
 *  to the appropriate connection path. Never throws. */
export async function handleConnectToDevice(msg: ConnectToDeviceMessage, deps: FleetConnectDeps): Promise<void> {
  const device = resolveDevice(msg, deps);

  if (device.isLocal) {
    await handleLocalDevice(device, deps);
    return;
  }

  await handleRemoteDevice(device, deps);
}

async function handleLocalDevice(device: ResolvedDevice, deps: FleetConnectDeps): Promise<void> {
  // Hub-specific warning
  if (device.isHub && (device.deviceCount ?? 0) > 1) {
    const otherCount = (device.deviceCount ?? 1) - 1;
    const result = await deps.showWarningMessage(
      `This machine is the hub — going standalone will disconnect ${otherCount} other device(s). Continue?`,
      "Go Standalone",
      "Cancel",
    );
    if (result !== "Go Standalone") return;
    deps.goStandalone();
    return;
  }

  const items: ConnectQuickPickItem[] = [
    { label: "$(debug-disconnect) Go Standalone", detail: "Leave the fleet and run locally", action: "go-standalone" },
  ];
  const pick = await deps.showQuickPick(items, { title: `${device.name} (This Machine)` });
  if (pick?.action === "go-standalone") {
    deps.goStandalone();
  }
}

async function handleRemoteDevice(device: ResolvedDevice, deps: FleetConnectDeps): Promise<void> {
  const remoteSshAvailable = deps.isRemoteSshAvailable();
  const items = buildRemoteQuickPickItems(device, remoteSshAvailable);

  const pick = await deps.showQuickPick(items, {
    title: `View sessions on ${device.name} remotely?`,
  });
  if (!pick) return;

  if (!isItemEnabled(pick)) return; // disabled items are no-ops

  if (pick.action === "thin-client") {
    // Resolve credential
    const cred = readAttachmentCredential(device.machineId, deps);
    const payload: { machine_id: string; base_url?: string; token?: string } = { machine_id: device.machineId };
    if (cred.ok) {
      payload.base_url = cred.credential.baseUrl;
      payload.token = cred.credential.token;
    }

    const confirm = await deps.showInformationMessage(
      `This will reload the window and connect to ${device.name}. Any in-progress chat will restart. Continue?`,
      "Continue",
      "Cancel",
    );
    if (confirm !== "Continue") return;

    const result = await deps.attachToDevice(payload);
    if (result.ok) {
      await deps.reloadWindow();
    }
    return;
  }

  if (pick.action === "remote-ssh" && device.sshAlias) {
    await deps.connectRemoteSsh(device.sshAlias);
  }
}
