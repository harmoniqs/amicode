/**
 * @vitest-environment happy-dom
 */
import { describe, it, expect } from "vitest";
import { buildTopologyFromConfig } from "../src/fleet_topology_data";
import { computeNodePositions, buildPopoverContent } from "../media/ui/components/fleet_topology";
import type { FleetNode } from "../src/fleet_panel";

// ── Topology data (host-side) ───────────────────────────────────────────────

describe("buildTopologyFromConfig", () => {
  it("returns empty for standalone (no config)", () => {
    const { nodes, edges } = buildTopologyFromConfig(null);
    expect(nodes).toHaveLength(0);
    expect(edges).toHaveLength(0);
  });

  it("returns empty for standalone role", () => {
    const { nodes, edges } = buildTopologyFromConfig({ role: "standalone" });
    expect(nodes).toHaveLength(0);
    expect(edges).toHaveLength(0);
  });

  it("builds server + client for client role", () => {
    const { nodes, edges } = buildTopologyFromConfig(
      { role: "client", canonical: { host: "remote-server", port: 4096, sshAlias: "srv" } },
      { localHostname: "my-laptop", serverHealthy: true },
    );
    expect(nodes).toHaveLength(2);
    expect(nodes[0].role).toBe("server");
    expect(nodes[0].hostname).toBe("remote-server");
    expect(nodes[0].isLocal).toBe(false);
    expect(nodes[1].role).toBe("client");
    expect(nodes[1].hostname).toBe("my-laptop");
    expect(nodes[1].isLocal).toBe(true);
    expect(edges).toHaveLength(1);
    expect(edges[0].connected).toBe(true);
  });

  it("marks edge as disconnected when server is unhealthy", () => {
    const { edges } = buildTopologyFromConfig(
      { role: "client", canonical: { host: "srv", port: 4096 } },
      { localHostname: "me", serverHealthy: false },
    );
    expect(edges[0].connected).toBe(false);
  });

  it("builds server-only for server role (no client nodes from config alone)", () => {
    const { nodes, edges } = buildTopologyFromConfig(
      { role: "server", canonical: { host: "this-machine", port: 4096 } },
      { localHostname: "this-machine" },
    );
    expect(nodes).toHaveLength(1);
    expect(nodes[0].role).toBe("server");
    expect(nodes[0].isLocal).toBe(true);
    expect(edges).toHaveLength(0);
  });
});

// ── Node position computation (webview-side, pure math) ─────────────────────

describe("computeNodePositions", () => {
  it("places server at center", () => {
    const nodes: FleetNode[] = [
      { id: "srv", hostname: "server", role: "server", isLocal: true, healthy: true, sessionCount: 0 },
    ];
    const positions = computeNodePositions(nodes, 240, 180);
    const srvPos = positions.get("srv")!;
    expect(srvPos.x).toBe(120); // center x
    expect(srvPos.y).toBe(90); // center y
  });

  it("places clients around server", () => {
    const nodes: FleetNode[] = [
      { id: "srv", hostname: "server", role: "server", isLocal: false, healthy: true, sessionCount: 0 },
      { id: "c1", hostname: "client1", role: "client", isLocal: true, healthy: true, sessionCount: 0 },
      { id: "c2", hostname: "client2", role: "client", isLocal: false, healthy: true, sessionCount: 0 },
    ];
    const positions = computeNodePositions(nodes, 240, 180);
    expect(positions.size).toBe(3);

    // Clients should be at radius distance from center
    const srv = positions.get("srv")!;
    const c1 = positions.get("c1")!;
    const c2 = positions.get("c2")!;

    const distC1 = Math.sqrt((c1.x - srv.x) ** 2 + (c1.y - srv.y) ** 2);
    const distC2 = Math.sqrt((c2.x - srv.x) ** 2 + (c2.y - srv.y) ** 2);
    // Both should be at the same radius (within floating point)
    expect(distC1).toBeCloseTo(distC2, 5);
    // And at 35% of min(240, 180) = 63
    expect(distC1).toBeCloseTo(180 * 0.35, 5);
  });

  it("handles zero clients (server only)", () => {
    const nodes: FleetNode[] = [
      { id: "srv", hostname: "server", role: "server", isLocal: true, healthy: true, sessionCount: 0 },
    ];
    const positions = computeNodePositions(nodes, 240, 180);
    expect(positions.size).toBe(1);
  });
});

// ── Popover content ─────────────────────────────────────────────────────────

describe("buildPopoverContent", () => {
  it("renders hostname, role, health, and sessions", () => {
    const node: FleetNode = {
      id: "srv",
      hostname: "my-server",
      role: "server",
      isLocal: false,
      healthy: true,
      sessionCount: 3,
      lastSeen: "2 min ago",
    };
    const el = buildPopoverContent(node);
    const text = el.textContent ?? "";
    expect(text).toContain("my-server");
    expect(text).toContain("server");
    expect(text).toContain("healthy");
    expect(text).toContain("3");
    expect(text).toContain("2 min ago");
  });

  it("shows 'This machine' for local nodes", () => {
    const node: FleetNode = {
      id: "me",
      hostname: "local-machine",
      role: "client",
      isLocal: true,
      healthy: true,
      sessionCount: 0,
    };
    const el = buildPopoverContent(node);
    expect(el.textContent).toContain("This machine");
  });

  it("shows 'unreachable' for unhealthy nodes", () => {
    const node: FleetNode = {
      id: "x",
      hostname: "down-host",
      role: "client",
      isLocal: false,
      healthy: false,
      sessionCount: 0,
    };
    const el = buildPopoverContent(node);
    expect(el.textContent).toContain("unreachable");
  });
});
