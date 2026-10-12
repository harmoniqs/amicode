// mount_policy.ts — #1267 (fleet client: amico-host:// FileSystemProvider).
//
// The PURE policy for the host-file Explorer mount: the dedicated scheme, the
// fleet-client gate (AC6), and the MANDATORY capability disclosure (AC4). No
// `vscode` import — the decision and the disclosure text are pinned independently
// of the editor host, and extension.ts consumes them at the wiring seam.

/** The dedicated virtual scheme. A Key Decision of #1267: NOT an override of
 *  `file:` — the local workspace stays intact and we do not fight VS Code's
 *  real-filesystem assumptions. */
export const HOST_SCHEME = "amico-host";

export interface HostFsMountInput {
  /** This machine rides the fleet as a thin CLIENT (relay), per the extension's
   *  isFleetClientGuard. A Remote-SSH client runs the extension host ON THE HOST,
   *  so it is NOT a fleet client here and never reaches this branch. */
  isFleetClient: boolean;
  /** An explicit opt-out — the ssh-default posture, or a user setting. When set,
   *  the provider stays unmounted even for a fleet client (AC6: ssh-default
   *  clients show no regression from the provider being absent). */
  disabled?: boolean;
}

export interface HostFsMountDecision {
  mount: boolean;
  reason: string;
}

/** Mount ONLY in fleet-client posture (AC6). standalone/server → never; an
 *  explicit opt-out → never, even for a fleet client. */
export function shouldMountHostFs(input: HostFsMountInput): HostFsMountDecision {
  if (input.disabled) return { mount: false, reason: "host-explorer-disabled" };
  if (!input.isFleetClient) return { mount: false, reason: "not-fleet-client" };
  return { mount: true, reason: "fleet-client" };
}

export interface CapabilityLabel {
  /** The short, always-visible status-bar text (carries a codicon). */
  text: string;
  /** The full disclosure shown on hover. */
  tooltip: string;
}

/** The MANDATORY disclosure (AC4). A hollow host Explorer with terminal / LSP /
 *  source control / search silently still on the client would be a worse failure
 *  than the reported split — so this ships WITH the mount, not later. The text
 *  states plainly that the Explorer (open + save) is on the HOST while the
 *  integrated terminal, language features, source control, and search remain on
 *  the LOCAL machine, and points users who need full host-native tooling at
 *  Remote-SSH. */
export function capabilityLabel(): CapabilityLabel {
  return {
    text: "$(remote-explorer) Explorer: Host files",
    tooltip: [
      "Amico fleet — host file surface",
      "",
      "The Explorer, open-in-editor, and save operate on the HOST filesystem (over the fleet relay).",
      "The integrated terminal, language features (LSP), source control, and search still operate on THIS local machine.",
      "",
      "For full host-native tooling (terminal + LSP + source control + search on the host), connect with Remote-SSH.",
    ].join("\n"),
  };
}
