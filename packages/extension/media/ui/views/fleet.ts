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
  .fleet-section { margin-bottom: var(--space-xl); }
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
                      gap: var(--space-sm); margin-bottom: var(--space-md); }
  .fleet-role-badge.standalone { color: var(--color-dim); }
  .fleet-role-badge.server { color: var(--color-ok); }
  .fleet-role-badge.client { color: var(--color-run); }
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

  // ── Create Fleet button (right under the badge in standalone) ────────────
  const createBtn = button("Create Fleet", () => {
    post({ type: "action", action: "createFleet" });
  });
  createBtn.enable(true);
  createBtn.el.style.marginBottom = "var(--space-md)";
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
    }
  }

  return { el, onMessage };
}
