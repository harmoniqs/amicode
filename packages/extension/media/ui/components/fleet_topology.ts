// Fleet topology graph — SVG star-topology renderer with clickable nodes and
// connection lines. Solid = connected, dotted = configured-but-offline. Node
// badges: healthy (green), degraded (yellow), unreachable (red).
//
// Part of #353 (Fleet Panel: SVG topology graph with clickable nodes).

import { defineStyle } from "../style";
import type { FleetNode, FleetEdge } from "../../../src/fleet_panel";

defineStyle(
  "fleet-topology",
  `
  .fleet-topology { position: relative; width: 100%; }
  .fleet-topology svg { width: 100%; height: 100%; }
  .fleet-topology .node { cursor: pointer; }
  .fleet-topology .node circle { stroke-width: 2; fill: var(--bg-box, #1e1e1e); }
  .fleet-topology .node circle.healthy { stroke: var(--color-ok); }
  .fleet-topology .node circle.degraded { stroke: var(--color-run); }
  .fleet-topology .node circle.unreachable { stroke: var(--color-fail); }
  .fleet-topology .node text { fill: var(--vscode-foreground); font-size: 10px;
                               text-anchor: middle; dominant-baseline: central;
                               pointer-events: none; }
  .fleet-topology .node .node-label { font-size: 9px; fill: var(--color-dim);
                                      dominant-baseline: hanging; }
  .fleet-topology .node .this-machine { font-size: 8px; fill: var(--color-accent-ink);
                                        font-weight: 600; }
  .fleet-topology .edge-line { stroke: var(--border-color); stroke-width: 1.5; }
  .fleet-topology .edge-line.connected { stroke-dasharray: none; }
  .fleet-topology .edge-line.disconnected { stroke-dasharray: 4 3; opacity: 0.6; }
  .fleet-topology .standalone-label { fill: var(--color-dim); font-size: 11px;
                                      font-style: italic; text-anchor: middle; }
  .fleet-popover { position: absolute; background: var(--bg-box);
                   border: var(--border-width) solid var(--border-color);
                   border-radius: var(--border-radius); padding: var(--space-sm) var(--space-md);
                   font-size: var(--text-small); min-width: 140px; z-index: 100;
                   box-shadow: 0 2px 8px rgba(0,0,0,0.3); }
  .fleet-popover .pop-title { font-weight: 600; margin-bottom: var(--space-xs); }
  .fleet-popover .pop-row { color: var(--color-dim); margin-bottom: 2px; }
  .fleet-popover .pop-row .pop-val { color: var(--vscode-foreground); }
`,
);

export interface TopologyGraph {
  el: HTMLElement;
  update(nodes: FleetNode[], edges: FleetEdge[]): void;
}

/** Compute node positions for a star topology: server at center, clients around it. */
export function computeNodePositions(
  nodes: FleetNode[],
  width: number,
  height: number,
): Map<string, { x: number; y: number }> {
  const positions = new Map<string, { x: number; y: number }>();
  const cx = width / 2;
  const cy = height / 2;
  const radius = Math.min(width, height) * 0.35;

  const server = nodes.find((n) => n.role === "server");
  const clients = nodes.filter((n) => n.role === "client");

  if (server) {
    positions.set(server.id, { x: cx, y: cy });
  }

  clients.forEach((client, i) => {
    const angle = (2 * Math.PI * i) / Math.max(clients.length, 1) - Math.PI / 2;
    positions.set(client.id, {
      x: cx + radius * Math.cos(angle),
      y: cy + radius * Math.sin(angle),
    });
  });

  return positions;
}

/** Build the popover content for a node. */
export function buildPopoverContent(node: FleetNode): HTMLElement {
  const el = document.createElement("div");
  el.className = "fleet-popover";

  const title = document.createElement("div");
  title.className = "pop-title";
  title.textContent = node.hostname;
  el.appendChild(title);

  const roleRow = document.createElement("div");
  roleRow.className = "pop-row";
  roleRow.innerHTML = `Role: <span class="pop-val">${node.role}</span>`;
  el.appendChild(roleRow);

  const healthRow = document.createElement("div");
  healthRow.className = "pop-row";
  healthRow.innerHTML = `Health: <span class="pop-val">${node.healthy ? "healthy" : "unreachable"}</span>`;
  el.appendChild(healthRow);

  if (node.lastSeen) {
    const lastSeenRow = document.createElement("div");
    lastSeenRow.className = "pop-row";
    lastSeenRow.innerHTML = `Last seen: <span class="pop-val">${node.lastSeen}</span>`;
    el.appendChild(lastSeenRow);
  }

  const sessionsRow = document.createElement("div");
  sessionsRow.className = "pop-row";
  sessionsRow.innerHTML = `Sessions: <span class="pop-val">${node.sessionCount}</span>`;
  el.appendChild(sessionsRow);

  if (node.isLocal) {
    const localRow = document.createElement("div");
    localRow.className = "pop-row";
    localRow.innerHTML = `<span class="pop-val" style="color: var(--color-accent-ink);">This machine</span>`;
    el.appendChild(localRow);
  }

  return el;
}

const SVG_NS = "http://www.w3.org/2000/svg";
const SVG_WIDTH = 240;
const SVG_HEIGHT = 180;
const NODE_RADIUS = 16;

export function createTopologyGraph(): TopologyGraph {
  const el = document.createElement("div");
  el.className = "fleet-topology";

  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", `0 0 ${SVG_WIDTH} ${SVG_HEIGHT}`);
  svg.setAttribute("preserveAspectRatio", "xMidYMid meet");
  el.appendChild(svg);

  let popover: HTMLElement | null = null;

  function dismissPopover(): void {
    if (popover) {
      popover.remove();
      popover = null;
    }
  }

  function showPopover(node: FleetNode, screenX: number, screenY: number): void {
    dismissPopover();
    popover = buildPopoverContent(node);
    popover.style.left = `${screenX}px`;
    popover.style.top = `${screenY + 10}px`;
    el.appendChild(popover);
  }

  // Dismiss on click-outside
  document.addEventListener("click", (e) => {
    if (popover && !popover.contains(e.target as Node)) {
      dismissPopover();
    }
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") dismissPopover();
  });

  function update(nodes: FleetNode[], edges: FleetEdge[]): void {
    dismissPopover();
    // Clear SVG
    while (svg.firstChild) svg.removeChild(svg.firstChild);

    if (nodes.length === 0) {
      // Standalone: single node, label
      const standaloneTxt = document.createElementNS(SVG_NS, "text");
      standaloneTxt.classList.add("standalone-label");
      standaloneTxt.setAttribute("x", String(SVG_WIDTH / 2));
      standaloneTxt.setAttribute("y", String(SVG_HEIGHT / 2));
      standaloneTxt.textContent = "Standalone \u2014 all local";
      svg.appendChild(standaloneTxt);
      return;
    }

    const positions = computeNodePositions(nodes, SVG_WIDTH, SVG_HEIGHT);

    // Draw edges first (behind nodes)
    for (const edge of edges) {
      const from = positions.get(edge.from);
      const to = positions.get(edge.to);
      if (!from || !to) continue;

      const line = document.createElementNS(SVG_NS, "line");
      line.classList.add("edge-line", edge.connected ? "connected" : "disconnected");
      line.setAttribute("x1", String(from.x));
      line.setAttribute("y1", String(from.y));
      line.setAttribute("x2", String(to.x));
      line.setAttribute("y2", String(to.y));
      svg.appendChild(line);
    }

    // Draw nodes
    for (const node of nodes) {
      const pos = positions.get(node.id);
      if (!pos) continue;

      const g = document.createElementNS(SVG_NS, "g");
      g.classList.add("node");
      g.setAttribute("data-node-id", node.id);

      // Circle with health badge color
      const circle = document.createElementNS(SVG_NS, "circle");
      circle.setAttribute("cx", String(pos.x));
      circle.setAttribute("cy", String(pos.y));
      circle.setAttribute("r", String(NODE_RADIUS));
      circle.classList.add(node.healthy ? "healthy" : "unreachable");
      g.appendChild(circle);

      // Role icon text (S for server, C for client)
      const roleText = document.createElementNS(SVG_NS, "text");
      roleText.setAttribute("x", String(pos.x));
      roleText.setAttribute("y", String(pos.y));
      roleText.textContent = node.role === "server" ? "S" : "C";
      g.appendChild(roleText);

      // Hostname label below
      const label = document.createElementNS(SVG_NS, "text");
      label.classList.add("node-label");
      label.setAttribute("x", String(pos.x));
      label.setAttribute("y", String(pos.y + NODE_RADIUS + 8));
      label.textContent = node.hostname.length > 12 ? node.hostname.slice(0, 11) + "\u2026" : node.hostname;
      g.appendChild(label);

      // "This machine" marker
      if (node.isLocal) {
        const marker = document.createElementNS(SVG_NS, "text");
        marker.classList.add("this-machine");
        marker.setAttribute("x", String(pos.x));
        marker.setAttribute("y", String(pos.y - NODE_RADIUS - 4));
        marker.textContent = "\u25CF you";
        g.appendChild(marker);
      }

      // Click handler for popover
      g.addEventListener("click", (e) => {
        e.stopPropagation();
        const svgRect = svg.getBoundingClientRect();
        const scaleX = svgRect.width / SVG_WIDTH;
        const relX = pos.x * scaleX;
        const relY = pos.y * (svgRect.height / SVG_HEIGHT);
        showPopover(node, relX, relY);
      });

      svg.appendChild(g);
    }
  }

  return { el, update };
}
