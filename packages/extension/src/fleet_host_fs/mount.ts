// mount.ts — #1267 the mount wiring seam (injectable, `vscode`-free).
//
// Turns the pure mount decision (mount_policy) into the three side effects a
// host-file Explorer needs — register the FileSystemProvider under amico-host,
// add the workspace folder, show the mandatory capability label — through
// INJECTED primitives. extension.ts supplies the real `vscode` implementations;
// tests supply recording fakes. Keeping this seam vscode-free lets AC4/AC6 be
// pinned without the editor host.
import { HOST_SCHEME, shouldMountHostFs, capabilityLabel, type HostFsMountInput, type CapabilityLabel } from "./mount_policy";

export interface Disposable {
  dispose(): void;
}

export interface HostFsMountDeps {
  /** Register the amico-host FileSystemProvider (production wraps
   *  vscode.workspace.registerFileSystemProvider(scheme, provider, {isReadonly})).
   *  Returns the registration's disposable. */
  registerProvider(scheme: string, isReadonly: boolean): Disposable;
  /** Add the amico-host workspace folder (production wraps
   *  vscode.workspace.updateWorkspaceFolders). */
  addFolder(scheme: string): void;
  /** Surface the mandatory capability label (production creates a persistent
   *  StatusBarItem). Returns its disposable. */
  showLabel(label: CapabilityLabel): Disposable;
  log?(msg: string): void;
}

export interface HostFsMountResult {
  mounted: boolean;
  reason: string;
  disposables: Disposable[];
}

/** Mount the host-file Explorer iff the posture calls for it (AC6). When it
 *  mounts, the mandatory disclosure label is shown in the SAME step (AC4) —
 *  never a hollow host Explorer without it. */
export function mountAmicoHostFs(input: HostFsMountInput, deps: HostFsMountDeps): HostFsMountResult {
  const decision = shouldMountHostFs(input);
  if (!decision.mount) {
    deps.log?.(`[fleet] amico-host Explorer not mounted (${decision.reason})`);
    return { mounted: false, reason: decision.reason, disposables: [] };
  }
  const providerDisposable = deps.registerProvider(HOST_SCHEME, /* isReadonly */ false);
  deps.addFolder(HOST_SCHEME);
  const labelDisposable = deps.showLabel(capabilityLabel());
  deps.log?.(`[fleet] amico-host Explorer mounted (${decision.reason}) — host files in the native Explorer`);
  return { mounted: true, reason: decision.reason, disposables: [providerDisposable, labelDisposable] };
}
