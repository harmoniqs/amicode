// Fleet Panel view — the TS-composed DOM for the Fleet Panel webview.
// Renders topology, profiles, and stats sections. Initially shows the
// standalone empty state with section headers.
//
// Follows the Device Inspector view pattern (media/ui/views/device_inspector.ts).

import { defineStyle } from "../style";
import { button } from "../atoms/button";
import { createTopologyGraph } from "../components/fleet_topology";
import { createProfilesView } from "../components/fleet_profiles_view";
import type { FleetHostMessage, FleetWebviewMessage } from "../../../src/fleet_panel";

defineStyle(
  "fleet-view",
  `
  body { margin: 0; min-height: 100vh; font-family: var(--text-font);
         font-size: var(--text-body); color: var(--vscode-foreground);
         padding: var(--space-lg); }
  .fleet-section { margin-bottom: 24px; }
  .fleet-section + .fleet-section { padding-top: 4px; }
  .section-label { font-size: var(--text-label); text-transform: uppercase;
                   letter-spacing: 0.6px; font-weight: 600; color: var(--color-dim);
                   margin-bottom: var(--space-xs); }
  .standalone-hint { color: var(--color-dim); font-style: italic;
                     margin: var(--space-md) 0; }
  .fleet-role-badge { font-size: var(--text-small); font-weight: 600;
                      text-transform: uppercase; letter-spacing: 0.5px;
                      padding: var(--space-xs) var(--space-md);
                      border-radius: var(--border-radius-round);
                      border: var(--border-width) solid currentColor;
                      display: inline-flex; align-items: center;
                      gap: var(--space-sm); margin-bottom: 16px; }
  .fleet-root > .btn { display: block; margin-bottom: var(--space-md); }
  .fleet-root > .btn.create-fleet { border-color: var(--color-accent-ink);
                      box-shadow: 0 0 8px color-mix(in srgb, var(--color-accent-ink) 40%, transparent);
                      margin-bottom: 24px; }
  .fleet-role-badge.standalone { color: var(--color-dim); }
  .fleet-role-badge.server { color: var(--color-ok); }
  .fleet-role-badge.client { color: var(--color-run); }
  .fleet-compat-banner { font-size: var(--text-small); padding: var(--space-sm) var(--space-md);
                         border-radius: var(--border-radius); margin-bottom: 12px;
                         border: var(--border-width) solid; display: none; }
  .fleet-compat-banner.degraded { color: var(--color-run); border-color: var(--color-run);
                                   background: color-mix(in srgb, var(--color-run) 8%, transparent); }
  .fleet-compat-banner.incompatible { color: var(--color-fail); border-color: var(--color-fail);
                                       background: color-mix(in srgb, var(--color-fail) 8%, transparent); }
  .fleet-compat-banner .compat-action { font-weight: 600; cursor: pointer;
                                         text-decoration: underline; margin-left: var(--space-sm); }
`,
);

export interface FleetView {
  el: HTMLElement;
  onMessage(msg: unknown): void;
}

export function createFleetView(post: (msg: FleetWebviewMessage) => void): FleetView {
  const el = document.createElement("div");
  el.className = "fleet-root";

  // ── Role badge ───────────────────────────────────────────────────────────
  const roleBadge = document.createElement("span");
  roleBadge.className = "fleet-role-badge standalone";
  roleBadge.textContent = "Standalone";
  el.appendChild(roleBadge);

  // ── Compatibility banner (shown when degraded/incompatible) ──────────────
  const compatBanner = document.createElement("div");
  compatBanner.className = "fleet-compat-banner";
  el.appendChild(compatBanner);

  // ── Create Fleet button (right under the badge in standalone) ────────────
  const createBtn = button("Create Fleet", () => {
    post({ type: "action", action: "createFleet" });
  });
  createBtn.el.classList.add("create-fleet");
  createBtn.enable(true);
  el.appendChild(createBtn.el);

  // ── Topology section ─────────────────────────────────────────────────────
  const topoSection = document.createElement("div");
  topoSection.className = "fleet-section";
  const topoLabel = document.createElement("div");
  topoLabel.className = "section-label";
  topoLabel.textContent = "Topology";
  topoSection.appendChild(topoLabel);

  const topoGraph = createTopologyGraph();
  topoSection.appendChild(topoGraph.el);
  // In standalone mode, hide the graph entirely (no empty SVG taking space)
  topoGraph.el.style.display = "none";
  topoSection.style.display = "none";
  el.appendChild(topoSection);

  // ── Profiles section ─────────────────────────────────────────────────────
  const profilesSection = document.createElement("div");
  profilesSection.className = "fleet-section";
  const profilesLabel = document.createElement("div");
  profilesLabel.className = "section-label";
  profilesLabel.textContent = "Profiles";
  profilesSection.appendChild(profilesLabel);

  const profilesView = createProfilesView(post);
  profilesSection.appendChild(profilesView.el);
  el.appendChild(profilesSection);

  // ── Stats section ────────────────────────────────────────────────────────
  const statsSection = document.createElement("div");
  statsSection.className = "fleet-section";
  const statsLabel = document.createElement("div");
  statsLabel.className = "section-label";
  statsLabel.textContent = "Stats";
  statsSection.appendChild(statsLabel);

  const statsContent = document.createElement("div");
  statsContent.className = "standalone-hint";
  statsContent.textContent = "No active sessions";
  statsSection.appendChild(statsContent);
  el.appendChild(statsSection);

  // ── Message handler ──────────────────────────────────────────────────────
  function onMessage(msg: unknown): void {
    const m = msg as FleetHostMessage;
    if (!m || typeof m !== "object" || !("type" in m)) return;

    switch (m.type) {
      case "role":
        roleBadge.className = `fleet-role-badge ${m.role}`;
        roleBadge.textContent =
          m.role === "standalone" ? "Standalone" : m.role === "server" ? "Server" : "Client";
        if (m.role === "standalone") {
          topoGraph.el.style.display = "none";
          topoSection.style.display = "none";
          createBtn.enable(true);
          createBtn.el.style.display = "";
          if (m.hasCanonical) {
            createBtn.el.textContent = "Reconnect Fleet";
            createBtn.el.onclick = () => post({ type: "action", action: "reconnectFleet" });
          } else {
            createBtn.el.textContent = "Create Fleet";
            createBtn.el.onclick = () => post({ type: "action", action: "createFleet" });
          }
        } else {
          topoGraph.el.style.display = "";
          topoSection.style.display = "";
          topoGraph.update([], []);
          createBtn.enable(false);
          createBtn.el.style.display = "none";
        }
        break;

      case "topology":
        topoGraph.update(m.nodes, m.edges);
        break;

      case "profiles":
        profilesView.update(m.profiles);
        break;

      case "stats":
        if (m.stats.active === 0) {
          statsContent.textContent = "No active sessions";
        } else {
          statsContent.textContent = `${m.stats.active} active (${m.stats.running} running, ${m.stats.blocked} blocked) \u00B7 ${m.stats.tokensToday} tokens today`;
        }
        break;

      case "compat":
        if (m.state === "compatible") {
          compatBanner.style.display = "none";
        } else {
          compatBanner.className = `fleet-compat-banner ${m.state}`;
          compatBanner.style.display = "block";
          compatBanner.innerHTML = m.state === "incompatible"
            ? `${m.message} <span class="compat-action" data-action="goStandalone">Go Standalone</span>`
            : m.message;

          // Wire up Go Standalone action
          const action = compatBanner.querySelector(".compat-action");
          if (action) {
            action.addEventListener("click", () => {
              post({ type: "action", action: "goStandalone" });
            });
          }
        }
        break;
    }
  }

  return { el, onMessage };
}
