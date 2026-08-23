// FleetPanel — the Fleet & Versions settings section (#527, spec-20260823-094507
// D3): a pure VIEW over `amico doctor --json`'s report.
//
// The load-bearing invariant (view-over-CLI): the panel is replaceable, doctor
// is the truth. Every rendered fact — surface name, running version, source
// version, verdict chip — comes verbatim from the report object; a fact the
// panel shows that doctor didn't say is a bug. There is ZERO version
// comparison, staleness predicate, or probe logic here — ever. The single
// decision this module makes is the upgrade control's enabled state, derived
// from the verdict chip (stale and integrity-failure are the verb-repairable
// verdicts — view logic, not a parallel fact).
//
// Execution mechanics (spec D3): the extension host spawns the CLI verb via
// child_process (the amico-run launcher pattern — resolveAmicoRunBinDir); long
// upgrade verbs stream by showing the verb's live stdout; the receipt store
// (~/.amico/server/upgrade-receipts/, JSONL) is the upgrade's exit state of
// record — the panel may die mid-flight (the extension verb replaces the
// extension hosting it) and the receipt still tells the truth.

import * as vscode from "vscode";
import { spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// ─── the doctor report contract (structural mirror of the committed schema) ──
// The schema (packages/amico-run/schemas/doctor-report.schema.json, #525) is
// the contract — these local structural types mirror it rather than importing
// amico-run internals, keeping the panel a view over the JSON document.

export type FleetVerdict = "current" | "stale" | "integrity-failure" | "unknown";

export interface FleetSurfaceRecord {
  surface: string;
  /** installed/running version (or set digest); null = doctor couldn't say */
  version: string | null;
  /** source-of-truth version (or set digest); null = source unreachable */
  source_version: string | null;
  verdict: FleetVerdict;
  /** digests, version strings, reason codes — rendered verbatim */
  evidence: string[];
}

export interface DoctorReport {
  surfaces: FleetSurfaceRecord[];
}

// ─── the single decision the panel makes (view logic over the verdict) ───────

/** Upgrade-control enabled state: derived from the VERDICT alone. `stale` and
 *  `integrity-failure` are the verb-repairable verdicts (spec D2/D3); `current`
 *  needs nothing and `unknown` must never be upgraded ("never upgrade what you
 *  cannot judge"). This is a verdict-string comparison — the only kind of
 *  comparison allowed in this module. */
export function upgradeEnabled(verdict: FleetVerdict): boolean {
  return verdict === "stale" || verdict === "integrity-failure";
}

// ─── pure render: report → section HTML ──────────────────────────────────────

/** Escape for TEXT nodes (& < >): keeps quotes literal so JSON receipts and
 *  version strings read exactly as the report wrote them. */
function escapeText(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Escape for ATTRIBUTE values: also neutralizes quotes, so a hostile string
 *  from a report can never break out of data-* attributes. */
function escapeAttr(s: string): string {
  return escapeText(s).replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

/** Verdict chip class per verdict — styling keys off the verdict the report
 *  carries; colors come from the extension's theme-token conventions
 *  (--vscode-testing-icon* / editorWarning / disabledForeground, as
 *  onboarding_webview.ts). */
function chipClass(verdict: FleetVerdict): string {
  return `fleet-chip-${verdict}`;
}

const NULL_MARKER = "—"; // doctor's own human table marks null version fields this way

function renderSurfaceRow(s: FleetSurfaceRecord): string {
  const version = s.version === null ? NULL_MARKER : escapeText(s.version);
  const source = s.source_version === null ? NULL_MARKER : escapeText(s.source_version);
  const evidence = s.evidence
    .map((line) => `        <li>${escapeText(line)}</li>`)
    .join("\n");
  return `      <tr class="fleet-row" data-surface="${escapeAttr(s.surface)}">
        <td class="fleet-name">${escapeText(s.surface)}</td>
        <td class="fleet-version">${version}</td>
        <td class="fleet-source">${source}</td>
        <td class="fleet-verdict"><span class="fleet-chip ${chipClass(s.verdict)}" data-verdict="${escapeAttr(s.verdict)}">${escapeText(s.verdict)}</span></td>
        <td class="fleet-action"><button class="fleet-upgrade" data-action="upgrade" data-surface="${escapeAttr(s.surface)}"${upgradeEnabled(s.verdict) ? "" : " disabled"}>Upgrade</button></td>
      </tr>
      <tr class="fleet-evidence-row" data-surface="${escapeAttr(s.surface)}">
        <td colspan="5"><details class="fleet-evidence"><summary>evidence</summary>
          <ul>
${evidence}
          </ul>
        </details></td>
      </tr>`;
}

/** Render the Fleet & Versions section from a doctor report. PURE: every
 *  surface name, version, source version, verdict chip, and evidence line in
 *  the output traces verbatim to `report` — nothing is derived, compared,
 *  normalized, or invented. The upgrade buttons carry the `disabled` attribute
 *  exactly when the verdict is not verb-repairable. */
export function renderFleetSection(report: DoctorReport): string {
  const rows = report.surfaces.map(renderSurfaceRow).join("\n");
  return `<section class="fleet-section" id="fleet-section">
  <style>
    .fleet-section { color: var(--vscode-foreground, #ccc); font-family: var(--vscode-font-family, system-ui); }
    .fleet-section table { border-collapse: collapse; width: 100%; }
    .fleet-section th { text-align: left; font-weight: 600; color: var(--vscode-descriptionForeground, #9d9d9d); padding: 4px 12px 4px 0; border-bottom: 1px solid var(--vscode-panel-border, #2b2b2b); }
    .fleet-section td { padding: 4px 12px 4px 0; vertical-align: top; font-family: var(--vscode-editor-font-family, monospace); font-size: 12px; }
    .fleet-section .fleet-name { font-weight: 600; }
    .fleet-chip { display: inline-block; padding: 1px 8px; border-radius: 9px; font-size: 11px; border: 1px solid transparent; }
    .fleet-chip-current { color: var(--vscode-testing-iconPassed, #73c991); border-color: var(--vscode-testing-iconPassed, #73c991); }
    .fleet-chip-stale { color: var(--vscode-editorWarning-foreground, #cca700); border-color: var(--vscode-editorWarning-foreground, #cca700); }
    .fleet-chip-integrity-failure { color: var(--vscode-testing-iconFailed, #f14c4c); border-color: var(--vscode-testing-iconFailed, #f14c4c); }
    .fleet-chip-unknown { color: var(--vscode-disabledForeground, #808080); border-color: var(--vscode-disabledForeground, #808080); }
    .fleet-section .fleet-evidence-row td { padding-top: 0; }
    .fleet-section .fleet-evidence summary { cursor: pointer; color: var(--vscode-descriptionForeground, #9d9d9d); font-size: 11px; }
    .fleet-section .fleet-evidence ul { margin: 4px 0; padding-left: 18px; }
    .fleet-section .fleet-evidence li { font-size: 11px; color: var(--vscode-descriptionForeground, #9d9d9d); }
    .fleet-section .fleet-upgrade { padding: 2px 10px; font-size: 11px; cursor: pointer; }
    .fleet-section .fleet-upgrade:disabled { cursor: default; opacity: 0.5; }
  </style>
  <div class="fleet-header">
    <h3>Fleet &amp; Versions</h3>
    <button class="fleet-refresh" data-action="refresh" title="Re-run amico doctor">Refresh</button>
  </div>
  <table class="fleet-table">
    <thead>
      <tr><th>Surface</th><th>Running version</th><th>Source version</th><th>Verdict</th><th></th></tr>
    </thead>
    <tbody>
${rows}
    </tbody>
  </table>
</section>`;
}

// ─── CLI invocation (the amico-run launcher pattern) ─────────────────────────

/** Injectable child-process seam — a trimmed child_process.spawn. The default
 *  wraps the real spawn; tests inject fakes so no `amico` binary is needed. */
export interface ChildProcessLike {
  stdout?: { on(event: "data", listener: (chunk: Buffer | string) => void): unknown };
  stderr?: { on(event: "data", listener: (chunk: Buffer | string) => void): unknown };
  // EventEmitter-shaped: the real ChildProcess.on and test fakes both fit
  on(event: string, listener: (...args: any[]) => void): unknown;
  kill?(signal?: NodeJS.Signals | number): unknown;
}

export type SpawnLike = (cmd: string, args: string[]) => ChildProcessLike;

const realSpawn: SpawnLike = (cmd, args) =>
  spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });

/** Resolve the `amico` CLI binary: the packaged launcher dir (staged by
 *  esbuild — the resolveAmicoRunBinDir pattern), the dev workspace sibling,
 *  then bare "amico" on PATH (the warrants.ts spawn pattern). */
export function resolveAmicoCli(extensionRoot: string): string {
  const staged = join(extensionRoot, "bin", "launcher", "amico");
  if (existsSync(staged)) return staged;
  const sibling = join(extensionRoot, "..", "amico-run", "launcher", "amico");
  if (existsSync(sibling)) return sibling;
  return "amico";
}

/** `amico doctor --json` — the machine contract invocation. */
export function buildDoctorArgv(): string[] {
  return ["doctor", "--json"];
}

/** `amico upgrade <surface>` — the surface argument is the surface string
 *  doctor's report named, verbatim. No aliasing or mapping lives here: the
 *  verb router (#S2) owns name normalization; the panel only repeats what the
 *  report said. */
export function buildUpgradeArgv(surface: string): string[] {
  return ["upgrade", surface];
}

/** The receipt store (spec D2): ~/.amico/server/upgrade-receipts/ — the exit
 *  state of record for upgrade verbs. */
export function defaultReceiptsDir(): string {
  return join(homedir(), ".amico", "server", "upgrade-receipts");
}

// ─── the receipt store reader ────────────────────────────────────────────────

export interface ReceiptStoreDeps {
  readdir?: (p: string) => string[];
  readFile?: (p: string) => string;
}

/** Last receipt for a surface from the JSONL store: scan the dir's `*.jsonl`
 *  files (name-sorted for determinism), take the LAST parseable line whose
 *  `surface` field matches; fall back to the last parseable line when nothing
 *  names the surface; null when the store is absent/unreadable/empty (e.g.
 *  verbs not yet installed) — honest absence, never a fabricated receipt.
 *  Tolerant by design: the verb slice owns the exact store layout; this reader
 *  only needs "the last receipt that names this surface". */
export function readLastReceipt(
  receiptsDir: string,
  surface: string,
  deps: ReceiptStoreDeps = {},
): Record<string, unknown> | null {
  const readdir = deps.readdir ?? readdirSync;
  const readFile = deps.readFile ?? ((p: string) => readFileSync(p, "utf8"));
  let files: string[];
  try {
    files = readdir(receiptsDir)
      .filter((f) => f.endsWith(".jsonl"))
      .sort();
  } catch {
    return null; // no store (verbs not installed) — honest null
  }
  let lastMatching: Record<string, unknown> | null = null;
  let lastAny: Record<string, unknown> | null = null;
  for (const f of files) {
    let body: string;
    try {
      body = readFile(join(receiptsDir, f));
    } catch {
      continue;
    }
    for (const line of body.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (trimmed === "") continue;
      try {
        const parsed = JSON.parse(trimmed) as Record<string, unknown>;
        lastAny = parsed;
        if (parsed.surface === surface) lastMatching = parsed;
      } catch {
        // unparseable line: skip, never fail the lookup
      }
    }
  }
  return lastMatching ?? lastAny;
}

// ─── the verb runners ────────────────────────────────────────────────────────

export interface DoctorOutcome {
  ok: boolean;
  report: DoctorReport | null;
  error: string | null;
}

export interface DoctorDeps {
  spawn?: SpawnLike;
  amicoBin?: string;
}

const DOCTOR_TIMEOUT_MS = 120_000; // doctor's own git fetches are bounded at 30s each

/** Run `amico doctor --json` to completion and parse the report. Never
 *  throws — failures resolve to {ok:false, error}. */
export function runDoctor(deps: DoctorDeps = {}): Promise<DoctorOutcome> {
  const doSpawn = deps.spawn ?? realSpawn;
  const bin = deps.amicoBin ?? "amico";
  return new Promise((resolve) => {
    let stdout = "";
    let settled = false;
    let child: ChildProcessLike;
    try {
      child = doSpawn(bin, buildDoctorArgv());
    } catch (e) {
      resolve({ ok: false, report: null, error: `spawn failed: ${(e as Error).message}` });
      return;
    }
    const finish = (r: DoctorOutcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(r);
    };
    const timer = setTimeout(() => {
      try {
        child.kill?.("SIGKILL");
      } catch {
        /* already gone */
      }
      finish({ ok: false, report: null, error: `doctor timed out after ${DOCTOR_TIMEOUT_MS}ms` });
    }, DOCTOR_TIMEOUT_MS);
    child.stdout?.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr?.on("data", () => {
      /* doctor's --json keeps stderr for humans; the contract is stdout */
    });
    child.on("error", (err: Error) => finish({ ok: false, report: null, error: err.message }));
    child.on("close", (code: number | null) => {
      if (code !== 0) {
        finish({ ok: false, report: null, error: `amico doctor exited ${code}` });
        return;
      }
      try {
        const parsed = JSON.parse(stdout) as DoctorReport;
        if (!Array.isArray(parsed.surfaces)) {
          throw new Error("report has no surfaces array");
        }
        finish({ ok: true, report: parsed, error: null });
      } catch (e) {
        finish({ ok: false, report: null, error: `doctor stdout is not a surfaces report: ${(e as Error).message}` });
      }
    });
  });
}

export interface UpgradeOutcome {
  /** the verb's exit code (null = spawn failure) */
  code: number | null;
  ok: boolean;
  /** the receipt of record, read from the store after the verb closed */
  receipt: Record<string, unknown> | null;
}

export interface UpgradeDeps {
  spawn?: SpawnLike;
  amicoBin?: string;
  receiptsDir?: string;
  /** live stdout/stderr line callback — the receipt-tailing seam (long verbs stream) */
  onLine?: (line: string) => void;
  readLastReceipt?: (receiptsDir: string, surface: string) => Record<string, unknown> | null;
}

/** Run `amico upgrade <surface>`, streaming the verb's live output via
 *  onLine; when the verb closes, read the LAST receipt for the surface from
 *  the store — the receipt is the exit state of record (spec D3): the panel
 *  may die mid-flight (the extension verb replaces the extension hosting it)
 *  and the receipt still tells the truth. No timeout by design — the verb
 *  owns its lifecycle (bounded build/verify steps) and its abort paths are
 *  receipted; killing it from the panel would orphan a legitimate run.
 *  On spawn failure no receipt is read: no verb ran, so the store would only
 *  hold a STALE receipt from an earlier upgrade. */
export function runUpgrade(surface: string, deps: UpgradeDeps = {}): Promise<UpgradeOutcome> {
  const doSpawn = deps.spawn ?? realSpawn;
  const bin = deps.amicoBin ?? "amico";
  const receiptsDir = deps.receiptsDir ?? defaultReceiptsDir();
  const readReceipt = deps.readLastReceipt ?? readLastReceipt;
  return new Promise((resolve) => {
    let child: ChildProcessLike;
    try {
      child = doSpawn(bin, buildUpgradeArgv(surface));
    } catch (e) {
      resolve({ code: null, ok: false, receipt: null });
      return;
    }
    const emit = (chunk: Buffer | string) => {
      for (const line of String(chunk).split(/\r?\n/)) {
        if (line.trim() !== "") deps.onLine?.(line);
      }
    };
    child.stdout?.on("data", emit);
    child.stderr?.on("data", emit);
    child.on("error", () => resolve({ code: null, ok: false, receipt: null }));
    child.on("close", (code: number | null) => {
      const receipt = readReceipt(receiptsDir, surface);
      resolve({ code, ok: code === 0, receipt });
    });
  });
}

// ─── the webview panel host (onboarding_panel.ts pattern) ────────────────────

let currentPanel: vscode.WebviewPanel | undefined;

/** Reset the singleton state. Exported for tests only. */
export function _resetFleetPanelForTesting(): void {
  if (currentPanel) currentPanel.dispose();
  currentPanel = undefined;
}

export interface FleetPanelDeps {
  /** doctor invocation (defaults to the real CLI spawn); injectable for tests */
  doctor?: () => Promise<DoctorOutcome>;
  /** upgrade invocation (defaults to the real CLI spawn); receives the live
   *  line callback so streamed verb output reaches the panel */
  upgrade?: (surface: string, onLine: (line: string) => void) => Promise<UpgradeOutcome>;
}

interface FleetPanelState {
  loading: boolean;
  error: string | null;
  report: DoctorReport | null;
  upgrade: {
    surface: string;
    lines: string[];
    running: boolean;
    receipt: Record<string, unknown> | null;
  } | null;
}

/** The full webview document: CSP + the loading/error/report states + the
 *  upgrade verb's live output and receipt of record. The click-proxy script is
 *  the only script — it maps [data-action] elements to postMessage envelopes
 *  the host handles; all rendering is host-side (pure functions above). */
function renderFleetDocument(
  state: FleetPanelState,
  cspSource: string,
  nonce: string,
): string {
  const body: string[] = [];
  if (state.loading) {
    body.push(`  <p class="fleet-status">Running amico doctor…</p>`);
  }
  if (state.error !== null) {
    body.push(`  <p class="fleet-error">amico doctor failed: ${escapeText(state.error)}</p>`);
  }
  if (state.report !== null) {
    body.push(renderFleetSection(state.report));
  }
  if (state.upgrade !== null) {
    const u = state.upgrade;
    const receipt =
      u.receipt === null
        ? ""
        : `    <div class="fleet-receipt"><span class="fleet-receipt-label">receipt of record</span>
      <pre>${escapeText(JSON.stringify(u.receipt, null, 2))}</pre>
    </div>`;
    body.push(`  <div class="fleet-upgrade-log" data-surface="${escapeAttr(u.surface)}">
    <h4>upgrade: ${escapeAttr(u.surface)} ${u.running ? "(running…)" : "(finished)"}</h4>
    <pre class="fleet-verb-output">${u.lines.map((l) => escapeText(l)).join("\n")}</pre>
${receipt}
  </div>`);
  }
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${nonce}'; style-src ${cspSource} 'unsafe-inline';">
<style>
  body { margin: 0; padding: 12px 20px; color: var(--vscode-foreground, #ccc); font-family: var(--vscode-font-family, system-ui); }
  .fleet-header { display: flex; align-items: center; justify-content: space-between; }
  .fleet-header h3 { margin: 8px 0; }
  .fleet-refresh { padding: 4px 14px; cursor: pointer; }
  .fleet-status, .fleet-error { padding: 8px 0; }
  .fleet-error { color: var(--vscode-testing-iconFailed, #f14c4c); }
  .fleet-upgrade-log { margin-top: 16px; border-top: 1px solid var(--vscode-panel-border, #2b2b2b); padding-top: 8px; }
  .fleet-upgrade-log h4 { margin: 4px 0; font-weight: 600; }
  .fleet-verb-output { font-family: var(--vscode-editor-font-family, monospace); font-size: 11px; color: var(--vscode-descriptionForeground, #9d9d9d); white-space: pre-wrap; margin: 4px 0; }
  .fleet-receipt-label { font-size: 11px; text-transform: uppercase; letter-spacing: 0.04em; color: var(--vscode-descriptionForeground, #9d9d9d); }
  .fleet-receipt pre { font-family: var(--vscode-editor-font-family, monospace); font-size: 11px; }
</style>
</head><body>
  <div id="fleet-root">
${body.join("\n")}
  </div>
  <script nonce="${nonce}">
    (function () {
      var vscode = acquireVsCodeApi();
      document.addEventListener("click", function (e) {
        var el = e.target && e.target.closest ? e.target.closest("[data-action]") : null;
        if (!el) return;
        if (el.dataset.action === "refresh") {
          vscode.postMessage({ type: "fleet-refresh" });
        } else if (el.dataset.action === "upgrade") {
          vscode.postMessage({ type: "fleet-upgrade", surface: el.dataset.surface });
        }
      });
    })();
  </script>
</body></html>`;
}

/** Register the "Amicode: Fleet & Versions" command. Call from extension.ts
 *  activate(). Singleton panel (onboarding pattern): re-open reveals. */
export function registerFleetPanel(ctx: vscode.ExtensionContext, deps: FleetPanelDeps = {}): void {
  const amicoBin = resolveAmicoCli(ctx.extensionUri.fsPath);
  const doctorFn = deps.doctor ?? (() => runDoctor({ amicoBin }));
  const upgradeFn =
    deps.upgrade ?? ((surface: string, onLine: (line: string) => void) => runUpgrade(surface, { amicoBin, onLine }));

  ctx.subscriptions.push(
    vscode.commands.registerCommand("amicode.fleet.versions", async () => {
      if (currentPanel) {
        currentPanel.reveal(vscode.ViewColumn.One);
        return;
      }
      const panel = vscode.window.createWebviewPanel(
        "amicode.fleet",
        "Fleet & Versions",
        vscode.ViewColumn.One,
        { enableScripts: true },
      );
      currentPanel = panel;
      const state: FleetPanelState = { loading: true, error: null, report: null, upgrade: null };
      const nonce = Math.random().toString(36).slice(2);
      const render = () => {
        panel.webview.html = renderFleetDocument(state, panel.webview.cspSource, nonce);
      };
      const refresh = async (): Promise<void> => {
        state.loading = true;
        state.error = null;
        render();
        const r = await doctorFn();
        state.loading = false;
        state.report = r.report;
        state.error = r.error;
        render();
      };
      panel.webview.onDidReceiveMessage(
        async (msg: { type?: string; surface?: string }) => {
          if (msg?.type === "fleet-refresh") {
            await refresh();
          } else if (msg?.type === "fleet-upgrade" && typeof msg.surface === "string") {
            // Re-derive repairability from the CURRENT report — the button's
            // disabled attribute is UX, not the guard (a stale message from a
            // dead DOM must never upgrade a non-repairable surface).
            const record = state.report?.surfaces.find((s) => s.surface === msg.surface);
            if (!record || !upgradeEnabled(record.verdict)) return;
            if (state.upgrade?.running) return; // one verb at a time — the CLI's flock is the real guard anyway
            state.upgrade = { surface: msg.surface, lines: [], running: true, receipt: null };
            render();
            const out = await upgradeFn(msg.surface, (line) => {
              state.upgrade?.lines.push(line);
              render();
            });
            if (state.upgrade) {
              state.upgrade.running = false;
              state.upgrade.receipt = out.receipt;
            }
            render();
            // the table follows the CLI's post-verb truth, not the receipt's claim
            await refresh();
          }
        },
        null,
        ctx.subscriptions,
      );
      panel.onDidDispose(
        () => {
          // Deliberately NOT killing a running upgrade child: the verb may be
          // replacing the extension hosting this panel (spec D3) — the receipt
          // store is the exit state of record, not the panel's survival.
          currentPanel = undefined;
        },
        null,
        ctx.subscriptions,
      );
      render();
      await refresh();
    }),
  );
}
