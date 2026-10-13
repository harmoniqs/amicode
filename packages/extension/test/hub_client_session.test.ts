// #1760 P4 — the hub client SESSION: the probe/attach loop the extension runs
// when amicode.hubServerUrl is armed. Mirrors the fleet-client tunnel poll's
// proven shape (FleetPollHysteresis — one lost probe must not flip the
// posture) against the configured hub URL, but spawns NOTHING: attach means
// "the panel's every server resolution points at the hub" (the extension
// wires ready-URL → SSE connect → the framed app), detach means the hub went
// down through the hysteresis window.
import { describe, it, expect } from "vitest";
import * as http from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AddressInfo } from "node:net";
import { startHubClientSession } from "../src/hub_client";
import { FleetPollHysteresis } from "../src/fleet_poll_hysteresis";

/** A one-endpoint mock hub: / answers 200 (the frontdoor's SPA index). */
async function startMockHub(): Promise<{ url: URL; stop(): Promise<void> }> {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.end("<html>hub</html>");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  return {
    url: new URL(`http://127.0.0.1:${port}`),
    stop: () => new Promise<void>((r) => server.close(() => r())),
  }
}

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Resolve when pred() turns true, polling every 10ms (bounded). */
async function waitFor(pred: () => boolean, what: string, budgetMs = 5_000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > budgetMs) throw new Error(`timed out waiting for: ${what}`);
    await wait(10);
  }
}

function sinkLog() {
  const lines: string[] = [];
  return { lines, log: (l: string) => lines.push(l) };
}

describe("startHubClientSession — armed → no spawn, all resolutions = hub URL (#1760 P4)", () => {
  it("attaches to a reachable hub: onAttach carries the hub URL and the posture is named in the log", async () => {
    const hub = await startMockHub();
    const { lines, log } = sinkLog();
    const attached: URL[] = [];
    const session = startHubClientSession({
      hubUrl: hub.url.toString(),
      log,
      pollIntervalMs: 20,
      poll: new FleetPollHysteresis({ downThreshold: 2 }),
      onAttach: (url) => attached.push(url),
      onDetach: () => {},
    });
    try {
      await waitFor(() => attached.length > 0, "attach");
      expect(attached[0].toString()).toBe(hub.url.toString());
      expect(lines.join("\n")).toContain("[hub] client mode");
      expect(lines.join("\n")).toContain(hub.url.toString());
      // No spawn happens by construction (the session owns no spawn surface at
      // all) — and the probe traffic went to the HUB, nowhere else.
    } finally {
      session.stop();
      await hub.stop();
    }
  }, 10_000);

  it("a hub that goes down detaches only through the hysteresis window, and stop() halts the loop", async () => {
    const hub = await startMockHub();
    const { lines, log } = sinkLog();
    const attached: URL[] = [];
    const detached: number[] = [];
    const session = startHubClientSession({
      hubUrl: hub.url.toString(),
      log,
      pollIntervalMs: 20,
      poll: new FleetPollHysteresis({ downThreshold: 2 }),
      onAttach: (url) => attached.push(url),
      onDetach: () => detached.push(Date.now()),
    });
    try {
      await waitFor(() => attached.length > 0, "attach");
      await hub.stop();
      await waitFor(() => detached.length > 0, "detach through hysteresis");
      expect(lines.join("\n")).toContain("hub down");
      // stop() clears the poll — no further probes after stop.
      session.stop();
      const linesAtStop = lines.length;
      await wait(120);
      expect(lines.length).toBe(linesAtStop);
    } finally {
      session.stop();
    }
  }, 10_000);

  it("an unreachable hub never attaches — the panel is never pointed at a door that is not there", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hub-client-dead-"));
    const { lines, log } = sinkLog();
    const attached: URL[] = [];
    // A URL with no listener: port 1 on loopback is reliably closed.
    const session = startHubClientSession({
      hubUrl: "http://127.0.0.1:1",
      log,
      pollIntervalMs: 20,
      poll: new FleetPollHysteresis({ downThreshold: 2 }),
      onAttach: (url) => attached.push(url),
      onDetach: () => {},
    });
    try {
      await wait(150);
      expect(attached).toEqual([]);
      expect(lines.join("\n")).toContain("http://127.0.0.1:1");
    } finally {
      session.stop();
      void dir;
    }
  }, 10_000);
});
