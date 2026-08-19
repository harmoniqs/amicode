import * as vscode from "vscode";

// ============================================================================
// Inspector bridge — extension → app postMessage fan-out for the Work Column
// inspector tabs (issue #351). The bottom-panel WebviewViewProvider is gone;
// RunsManager and the device poll loop post typed messages here, which fan out
// to every live ChatPanel (+ DeckPanel) webview. The outer relay (chat_panel.ts)
// forwards them into the iframed app (origin-checked lane 2), where SolidJS
// components buffer per-run/per-device and render the Work Column tabs.
// ============================================================================

export type RunBridgeMessage =
  | { kind: "run:iteration"; runId: string; iter: number; objective: number; inf_pr: number; inf_du: number }
  | { kind: "run:pulse-meta"; runId: string; drives: number; knots: number; labels: string[]; bounds: [number, number][]; interp?: string }
  | { kind: "run:pulse"; runId: string; iter: number; dt: number; values: number[][] }
  | { kind: "run:completion"; runId: string; fidelity: number; iterations: number; status: string }
  | { kind: "run:activate"; runId: string }
  | { kind: "run:timing"; runId: string; elapsed: number }
  | { kind: "run:label"; runId: string; label: string };

export type DeviceBridgeMessage =
  | { kind: "device:status"; device: string; status: unknown }
  | { kind: "device:actions"; device: string; actions: unknown[] }
  | { kind: "device:activate"; device: string };

export type InspectorBridgeMessage = RunBridgeMessage | DeviceBridgeMessage;
export type InspectorReverse =
  | { kind: "device:refresh"; device: string };

type Poster = (msg: unknown) => void;
const posters = new Set<Poster>();

/** Registered by ChatPanel / DeckPanel on creation — their `panel.webview.postMessage` bound. */
export function registerInspectorPoster(poster: Poster): vscode.Disposable {
  posters.add(poster);
  return { dispose: () => posters.delete(poster) };
}

function broadcast(msg: InspectorBridgeMessage): void {
  const envelope = { source: "amicode", ...msg };
  for (const p of posters) {
    try {
      p(envelope);
    } catch {
      /* disposed webview — ignore */
    }
  }
}

// -------- run surface (called by RunsManager) --------

export function postRunIteration(runId: string, iter: number, objective: number, inf_pr: number, inf_du: number): void {
  broadcast({ kind: "run:iteration", runId, iter, objective, inf_pr, inf_du });
}

export function postRunPulseMeta(
  runId: string,
  meta: { drives: number; knots: number; labels: string[]; bounds: [number, number][]; interp?: string },
): void {
  broadcast({ kind: "run:pulse-meta", runId, ...meta });
}

export function postRunPulse(runId: string, iter: number, dt: number, values: number[][]): void {
  broadcast({ kind: "run:pulse", runId, iter, dt, values });
}

export function postRunCompletion(runId: string, fidelity: number, iterations: number, status: string): void {
  broadcast({ kind: "run:completion", runId, fidelity, iterations, status });
}

export function postRunActivate(runId: string): void {
  broadcast({ kind: "run:activate", runId });
}

export function postRunLabel(runId: string, label: string): void {
  broadcast({ kind: "run:label", runId, label });
}

export function postRunTiming(runId: string, elapsed: number): void {
  broadcast({ kind: "run:timing", runId, elapsed });
}

// -------- device surface (called by extension.ts poll) --------

export function postDeviceStatus(device: string, status: unknown): void {
  broadcast({ kind: "device:status", device, status });
}

export function postDeviceActions(device: string, actions: unknown[]): void {
  broadcast({ kind: "device:actions", device, actions });
}

export function postDeviceActivate(device: string): void {
  broadcast({ kind: "device:activate", device });
}

/** Test seam: how many posters are registered. */
export function _posterCount(): number {
  return posters.size;
}

/** Test seam: clear all posters. */
export function _clearPosters(): void {
  posters.clear();
}
