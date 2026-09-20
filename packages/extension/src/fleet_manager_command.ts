// fleet_manager_command.ts — the Fleet Manager Work Column tab's command
// routing (#1322, AC5). The standalone Fleet & Versions webview panel is
// RETIRED (see fleet_panel.ts); its command and the sidebar's Manage affordance
// both route to the TAB by broadcasting an `open-fleet-manager` message to the
// live chat webview(s) (ChatPanel.postToAll). The Versions route carries the
// `amico doctor` report so the tab's Versions section renders the same content
// the retired panel showed.
import * as vscode from "vscode";
import { ChatPanel } from "./chat_panel";
import { runDoctor, resolveAmicoCli, type DoctorOutcome, type DoctorReport } from "./fleet_panel";

/** The message kind the app listens for to open the Fleet Manager tab. */
export const OPEN_FLEET_MANAGER_KIND = "open-fleet-manager" as const;

/** The section the tab lands on when opened. */
export type FleetManagerSection = "devices" | "machine" | "hub" | "versions";

/** The open-fleet-manager envelope (matches the app-side bridge listener). */
export interface OpenFleetManagerMessage {
  source: "amicode";
  kind: typeof OPEN_FLEET_MANAGER_KIND;
  section?: FleetManagerSection;
  localMachineId?: string;
  /** This machine's window-mode axis (remote-ssh | local) — its OWN field,
   *  never overloaded onto link-health posture (ADR 0025 #4). */
  windowMode?: string;
  report?: DoctorReport;
}

/** Build the open-fleet-manager envelope — omits absent optional fields so a
 *  bare open (no section, no local id) stays a minimal, honest message. */
export function buildOpenFleetManagerMessage(opts: {
  section?: FleetManagerSection;
  localMachineId?: string | null;
  windowMode?: string | null;
  report?: DoctorReport | null;
}): OpenFleetManagerMessage {
  const msg: OpenFleetManagerMessage = { source: "amicode", kind: OPEN_FLEET_MANAGER_KIND };
  if (opts.section) msg.section = opts.section;
  if (typeof opts.localMachineId === "string") msg.localMachineId = opts.localMachineId;
  if (typeof opts.windowMode === "string") msg.windowMode = opts.windowMode;
  if (opts.report) msg.report = opts.report;
  return msg;
}

/** Injectable seams (defaults wire the real ChatPanel broadcast + doctor CLI). */
export interface FleetManagerCommandDeps {
  /** Broadcast the open message to every live chat webview. */
  postToAll?: (msg: OpenFleetManagerMessage) => void;
  /** This machine's roster id, for the local-row editability (single-writer). */
  localMachineId?: () => string | null;
  /** This machine's window-mode (remote-ssh | local) — the separate axis. */
  windowMode?: () => string | null;
  /** `amico doctor` runner — its report rides the Versions route. */
  doctor?: () => Promise<DoctorOutcome>;
}

/** Register the tab-routing commands:
 *   - amicode.openFleetManager — the sidebar Manage affordance + generic open.
 *   - amicode.fleet.versions — the RETIRED Fleet & Versions panel's command,
 *     now routing to the tab's Versions section with the doctor report.
 *  Both broadcast an open-fleet-manager message to the live chat webviews. */
export function registerFleetManagerCommands(
  ctx: vscode.ExtensionContext,
  deps: FleetManagerCommandDeps = {},
): void {
  const postToAll = deps.postToAll ?? ((msg) => ChatPanel.postToAll(msg));
  const localMachineId = deps.localMachineId ?? (() => null);
  const windowMode = deps.windowMode ?? (() => null);
  const doctor =
    deps.doctor ??
    (() => runDoctor({ amicoBin: resolveAmicoCli(ctx.extensionUri.fsPath) }));

  ctx.subscriptions.push(
    vscode.commands.registerCommand("amicode.openFleetManager", () => {
      postToAll(buildOpenFleetManagerMessage({ localMachineId: localMachineId(), windowMode: windowMode() }));
    }),
  );

  ctx.subscriptions.push(
    vscode.commands.registerCommand("amicode.fleet.versions", async () => {
      // Run doctor so the tab's Versions section renders the same content the
      // retired panel showed; on any failure the route still opens (honest —
      // the section shows its own no-report state).
      let report: DoctorReport | null = null;
      try {
        report = (await doctor()).report;
      } catch {
        report = null;
      }
      postToAll(
        buildOpenFleetManagerMessage({
          section: "versions",
          localMachineId: localMachineId(),
          windowMode: windowMode(),
          report,
        }),
      );
    }),
  );
}
