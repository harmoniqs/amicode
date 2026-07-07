// Device Inspector view — a device-focused dashboard (Spec A §3): drive lines
// online, per-qubit rollup, latest T1/T2/fidelities with staleness, calibration
// params, and the ranked action list (qilc items locked/greyed when unentitled).
//
// Sibling to the Run Inspector view (media/ui/views/inspector.ts): same idioms —
// a device-KEYED message protocol shared with device_inspector.ts, ONE pane per
// device, the ACTIVE one shown (host sends `activate`), and each atom/component
// owns its style via constructable stylesheets. Theme-aware via VS Code CSS vars
// (brand.css) — NO external CDN.

import { defineStyle } from "../style";
import { mark } from "../atoms/icon";
import { text } from "../atoms/text";
import { button } from "../atoms/button";
import { metric } from "../components/metric";
import type { DeviceStatus, DriveLineStatus, MetricReading, NextAction, QubitRollup } from "../../../src/device_status";
import type { NodeStatus } from "../../../src/calibration_graph";

defineStyle("device-view", `
  body { margin: 0; height: 100vh; font-family: var(--text-font);
         font-size: var(--text-body); color: var(--vscode-foreground); }
  .brand { font-weight: 600; }
  .device-pane:not(.active) { display: none; }
  .device-pane.active { display: flex; }
  .device-name { font-weight: 600; }
  .section-label { font-size: var(--text-label); text-transform: uppercase;
                   letter-spacing: 0.6px; font-weight: 600; color: var(--color-dim);
                   margin-bottom: var(--space-xs); }
  /* status badge — the ONE enum, theme-aware colors from VS Code tokens. */
  .sbadge { font-size: var(--text-small); font-weight: 600; letter-spacing: 0.5px;
            text-transform: uppercase; padding: var(--space-xs) var(--space-md);
            border-radius: var(--border-radius-round);
            border: var(--border-width) solid currentColor;
            display: inline-flex; align-items: center; gap: var(--space-sm); }
  .sbadge::before { content: ""; width: var(--square-dot); height: var(--square-dot);
                    border-radius: 50%; background: currentColor; }
  .sbadge.calibrated    { color: var(--color-ok); }
  .sbadge.stale         { color: var(--color-dim); }
  .sbadge.suspect       { color: var(--color-run); }
  .sbadge.failed        { color: var(--color-fail); }
  .sbadge.uncharacterized { color: var(--color-dim); opacity: 0.8; }
  /* drive-line chips */
  .drive-line { display: inline-flex; align-items: center; gap: var(--space-sm);
                padding: var(--space-xs) var(--space-md);
                border: var(--border-width) solid var(--border-color);
                border-radius: var(--border-radius-round);
                background: var(--bg-box); font-size: var(--text-small); white-space: nowrap; }
  .drive-line::before { content: ""; width: var(--square-dot); height: var(--square-dot); border-radius: 50%; }
  .drive-line.online::before  { background: var(--color-ok); }
  .drive-line.offline { opacity: 0.6; }
  .drive-line.offline::before { background: var(--color-dim); }
  .drive-line .dl-kind { color: var(--color-dim); }
  /* action rows */
  .action { display: flex; align-items: center; gap: var(--space-md);
            padding: var(--space-sm) var(--space-md);
            border: var(--border-width) solid var(--border-color);
            border-radius: var(--border-radius); background: var(--bg-box); }
  .action .act-node { font-family: var(--text-mono); font-weight: 600; }
  .action .act-verb { color: var(--color-dim); font-size: var(--text-small);
                      text-transform: uppercase; letter-spacing: 0.5px; }
  .action.locked { opacity: 0.55; }
  .action.locked .act-node::before { content: "🔒 "; }
  .action .act-fallback { color: var(--color-dim); font-size: var(--text-small); font-style: italic; }
  .metric-age { color: var(--color-dim); font-size: var(--text-small); }
  .params { font-family: var(--text-mono); font-size: var(--text-small); color: var(--color-dim);
            display: flex; flex-wrap: wrap; gap: var(--space-md); }
`);

const IDLE_HINT = "No device selected — open a device from the Amicode chat or the device picker.";

export interface DeviceInspectorView {
  el: HTMLElement;
  onMessage(msg: unknown): void;
}

const STATUS_LABEL: Record<NodeStatus, string> = {
  calibrated: "calibrated",
  stale: "stale",
  suspect: "suspect",
  failed: "failed",
  uncharacterized: "uncharacterized",
};

const SEVERITY: Record<NodeStatus, number> = { calibrated: 0, uncharacterized: 1, stale: 2, suspect: 3, failed: 4 };

function statusBadge(status: NodeStatus): HTMLElement {
  const el = document.createElement("span");
  el.className = `sbadge ${status}`;
  el.textContent = STATUS_LABEL[status];
  return el;
}

/** Human staleness label, e.g. "3h ago" / "just now" / "never". */
function ageLabel(ageSeconds: number): string {
  if (!Number.isFinite(ageSeconds)) return "never";
  if (ageSeconds < 60) return "just now";
  if (ageSeconds < 3600) return `${Math.round(ageSeconds / 60)}m ago`;
  if (ageSeconds < 86400) return `${Math.round(ageSeconds / 3600)}h ago`;
  return `${Math.round(ageSeconds / 86400)}d ago`;
}

interface Pane {
  el: HTMLElement;
  applyStatus(status: DeviceStatus): void;
  applyActions(actions: NextAction[]): void;
  setActive(active: boolean): void;
}

function section(labelText: string): { el: HTMLElement; body: HTMLElement } {
  const el = document.createElement("div");
  el.className = "stack gap-sm";
  const label = document.createElement("div");
  label.className = "section-label";
  label.textContent = labelText;
  const body = document.createElement("div");
  body.className = "row wrap";
  el.append(label, body);
  return { el, body };
}

function createPane(device: string, post: (msg: unknown) => void): Pane {
  const nameEl = text("device-name", device);
  const rollup = document.createElement("span");

  const brand = document.createElement("div");
  brand.className = "row gap-sm brand";
  brand.append(mark(), text("", "Device Inspector").el);

  const refreshBtn = button("↻ Refresh", () => post({ type: "control", action: "refresh", device }));
  refreshBtn.el.classList.add("push-end");

  const topbar = document.createElement("div");
  topbar.className = "row wrap";
  topbar.append(brand, nameEl.el, rollup, refreshBtn.el);

  const drive = section("Drive lines");
  const qubits = section("Qubits");
  const metrics = section("Latest metrics");
  const params = section("Calibration params");
  params.body.classList.add("params");
  const actions = section("Recommended actions");
  actions.body.className = "stack gap-sm"; // action rows stack vertically

  const el = document.createElement("div");
  el.className = "device-pane stack pad-lg scroll-y";
  el.style.height = "100vh";
  el.append(topbar, drive.el, qubits.el, metrics.el, params.el, actions.el);

  const clear = (n: HTMLElement) => { while (n.firstChild) n.removeChild(n.firstChild); };

  const overallStatus = (qs: QubitRollup[]): NodeStatus =>
    qs.reduce<NodeStatus>((acc, q) => (SEVERITY[q.status] > SEVERITY[acc] ? q.status : acc), "calibrated");

  return {
    el,
    setActive(active: boolean): void {
      el.classList.toggle("active", active);
    },
    applyStatus(status: DeviceStatus): void {
      // overall rollup badge
      clear(rollup);
      rollup.className = "push-end";
      rollup.append(statusBadge(status.qubits.length ? overallStatus(status.qubits) : "uncharacterized"));

      // drive lines
      clear(drive.body);
      for (const d of status.driveLines) drive.body.append(driveLineChip(d));

      // qubits
      clear(qubits.body);
      for (const q of status.qubits) {
        const wrap = document.createElement("span");
        wrap.className = "row gap-sm";
        wrap.append(text("mono", q.qubit).el, statusBadge(q.status));
        qubits.body.append(wrap);
      }

      // latest metrics (only the measured ones — honesty rule)
      clear(metrics.body);
      metrics.body.className = "metric-row";
      const keys = Object.keys(status.metrics).sort();
      if (keys.length === 0) metrics.body.append(text("dim", "no measured values yet").el);
      for (const key of keys) metrics.body.append(metricCard(key, status.metrics[key]));

      // calibration params
      clear(params.body);
      const pkeys = Object.keys(status.calibrationParams).sort();
      if (pkeys.length === 0) params.body.append(text("dim", "—").el);
      for (const k of pkeys) params.body.append(text("", `${k}=${formatVal(status.calibrationParams[k])}`).el);
    },
    applyActions(list: NextAction[]): void {
      clear(actions.body);
      if (list.length === 0) { actions.body.append(text("dim", "all calibrated — nothing to do").el); return; }
      for (const a of list) actions.body.append(actionRow(a));
    },
  };
}

function driveLineChip(d: DriveLineStatus): HTMLElement {
  const el = document.createElement("span");
  el.className = `drive-line ${d.online ? "online" : "offline"}`;
  el.append(text("mono", d.id).el);
  if (d.target) el.append(text("dl-kind", `· ${d.target}`).el);
  if (d.kind) el.append(text("dl-kind", `· ${d.kind}`).el);
  return el;
}

function metricCard(key: string, m: MetricReading): HTMLElement {
  const card = metric(key, { variant: "small" });
  card.value(String(m.value));
  const age = document.createElement("div");
  age.className = "metric-age";
  age.textContent = ageLabel(m.ageSeconds);
  card.el.append(age);
  return card.el;
}

function actionRow(a: NextAction): HTMLElement {
  const el = document.createElement("div");
  el.className = `action ${a.locked ? "locked" : ""}`.trim();
  el.append(statusBadge(a.status));
  el.append(text("act-node", a.node).el);
  el.append(text("act-verb", a.action).el);
  if (a.locked && a.recommendedNode !== a.node) el.append(text("act-fallback", `→ ${a.recommendedNode}`).el);
  return el;
}

function formatVal(v: unknown): string {
  if (typeof v === "number") return String(v);
  if (typeof v === "string") return v;
  return JSON.stringify(v);
}

export function createDeviceInspectorView(post: (msg: unknown) => void): DeviceInspectorView {
  const panes = new Map<string, Pane>();
  let active: string | undefined;

  const empty = text("dim", IDLE_HINT);
  empty.el.className = "pad-lg dim";

  const el = document.createElement("div");
  el.style.height = "100vh";
  el.append(empty.el);

  const paneFor = (device: string): Pane => {
    let p = panes.get(device);
    if (!p) {
      p = createPane(device, post);
      panes.set(device, p);
      el.append(p.el);
    }
    return p;
  };

  const activate = (device: string): void => {
    active = device;
    empty.el.style.display = "none";
    for (const [id, p] of panes) p.setActive(id === device);
    if (!panes.has(device)) paneFor(device).setActive(true);
  };

  return {
    el,
    onMessage(msg: unknown): void {
      if (!msg || typeof msg !== "object") return;
      const m = msg as Record<string, unknown>;
      if (m.type === "ping") { post({ type: "pong", seq: m.seq, t0: m.t0 }); return; }
      if (m.type === "activate") { if (typeof m.device === "string") activate(m.device); return; }
      const device = typeof m.device === "string" ? m.device : active;
      if (!device) return;
      const pane = paneFor(device);
      if (m.type === "device-status" && m.status) pane.applyStatus(m.status as DeviceStatus);
      else if (m.type === "actions" && Array.isArray(m.actions)) pane.applyActions(m.actions as NextAction[]);
    },
  };
}
