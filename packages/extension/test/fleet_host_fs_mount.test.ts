// fleet_host_fs_mount.test.ts — #1267 mount policy + wiring seam.
//
// AC4 (mandatory disclosure label) and AC6 (mounts ONLY in fleet-client posture;
// standalone / server / ssh-default untouched). Both are PURE / injected-fake
// tested — no `vscode` needed — so the gating and the disclosure content are
// pinned independently of the editor host.
import { describe, it, expect } from "vitest";
import { HOST_SCHEME, shouldMountHostFs, capabilityLabel } from "../src/fleet_host_fs/mount_policy";
import { mountAmicoHostFs, type HostFsMountDeps, type Disposable } from "../src/fleet_host_fs/mount";

function recordingDeps() {
  const calls = {
    registerProvider: [] as Array<{ scheme: string; isReadonly: boolean }>,
    addFolder: [] as string[],
    showLabel: [] as ReturnType<typeof capabilityLabel>[],
    logs: [] as string[],
    disposed: 0,
  };
  const disp = (): Disposable => ({ dispose: () => void calls.disposed++ });
  const deps: HostFsMountDeps = {
    registerProvider: (scheme, isReadonly) => {
      calls.registerProvider.push({ scheme, isReadonly });
      return disp();
    },
    addFolder: (scheme) => void calls.addFolder.push(scheme),
    showLabel: (label) => {
      calls.showLabel.push(label);
      return disp();
    },
    log: (m) => void calls.logs.push(m),
  };
  return { calls, deps };
}

describe("#1267 mount policy — the scheme + the fleet-client gate (AC6)", () => {
  it("the dedicated scheme is amico-host (never an override of file:)", () => {
    expect(HOST_SCHEME).toBe("amico-host");
  });

  it("a fleet client mounts", () => {
    expect(shouldMountHostFs({ isFleetClient: true })).toEqual({ mount: true, reason: "fleet-client" });
  });

  it("standalone / server (not a fleet client) does NOT mount", () => {
    expect(shouldMountHostFs({ isFleetClient: false }).mount).toBe(false);
    expect(shouldMountHostFs({ isFleetClient: false }).reason).toBe("not-fleet-client");
  });

  it("an explicit opt-out (ssh-default / setting) does NOT mount even for a fleet client", () => {
    expect(shouldMountHostFs({ isFleetClient: true, disabled: true }).mount).toBe(false);
    expect(shouldMountHostFs({ isFleetClient: true, disabled: true }).reason).toBe("host-explorer-disabled");
  });
});

describe("#1267 capability label — the mandatory disclosure (AC4)", () => {
  it("discloses Explorer=host while terminal / LSP / source control / search = local, and points to Remote-SSH", () => {
    const label = capabilityLabel();
    expect(label.text.length).toBeGreaterThan(0); // a visible, non-empty status label
    const tip = label.tooltip.toLowerCase();
    expect(tip).toContain("host"); // Explorer shows HOST files
    expect(tip).toContain("explorer");
    expect(tip).toContain("local"); // the local-machine caveats
    expect(tip).toContain("terminal");
    expect(tip.includes("language") || tip.includes("lsp")).toBe(true);
    expect(tip.includes("source control") || tip.includes("scm") || tip.includes("git")).toBe(true);
    expect(tip).toContain("search");
    expect(tip).toContain("remote-ssh"); // the pointer to full host-native tooling
  });
});

describe("#1267 mount wiring — mounts only in fleet-client posture (AC6), with the label (AC4)", () => {
  it("in fleet-client posture: registers the provider under amico-host (writable), adds the folder, shows the label", () => {
    const { calls, deps } = recordingDeps();
    const result = mountAmicoHostFs({ isFleetClient: true }, deps);
    expect(result.mounted).toBe(true);
    expect(calls.registerProvider).toEqual([{ scheme: "amico-host", isReadonly: false }]);
    expect(calls.addFolder).toEqual(["amico-host"]);
    expect(calls.showLabel.length).toBe(1);
    expect(calls.showLabel[0].tooltip.toLowerCase()).toContain("remote-ssh"); // the disclosure was shown
    expect(result.disposables.length).toBe(2); // provider + label, both disposable
  });

  it("standalone posture: registers NOTHING, adds NO folder, shows NO label (AC6 — no regression)", () => {
    const { calls, deps } = recordingDeps();
    const result = mountAmicoHostFs({ isFleetClient: false }, deps);
    expect(result.mounted).toBe(false);
    expect(calls.registerProvider).toEqual([]);
    expect(calls.addFolder).toEqual([]);
    expect(calls.showLabel).toEqual([]);
    expect(result.disposables).toEqual([]);
  });

  it("ssh-default (disabled) fleet client: unmounted — the provider is simply absent (AC6)", () => {
    const { calls, deps } = recordingDeps();
    const result = mountAmicoHostFs({ isFleetClient: true, disabled: true }, deps);
    expect(result.mounted).toBe(false);
    expect(calls.registerProvider).toEqual([]);
    expect(calls.addFolder).toEqual([]);
    expect(calls.showLabel).toEqual([]);
  });
});
