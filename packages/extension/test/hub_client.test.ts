// #1760 P4 — the hub-host client posture: `amicode.hubServerUrl` arms a
// cross-platform "client of the hub" mode. The extension spawns NOTHING (no
// engine, no service) and every server resolution points at the configured hub
// URL (default http://127.0.0.1:4097 on the hub host itself, but any URL
// valid). The darwin-only fleet-client guard (isFleetClientGuard) must NOT
// gate this posture — erlich is a Linux remote-SSH extension host, which is
// exactly the machine that needs it.
import { describe, it, expect } from "vitest";
import { readHubClientConfig, bootPosture, guardReservedHubPort, RESERVED_HUB_PORTS } from "../src/hub_client";

describe("readHubClientConfig — the amicode.hubServerUrl setting (#1760 P4)", () => {
  it("arms with the normalized hub URL when set to a valid http(s) URL", () => {
    const cfg = readHubClientConfig("http://127.0.0.1:4097");
    expect(cfg.armed).toBe(true);
    expect(cfg.url).toBe("http://127.0.0.1:4097");
  });

  it("unarmed on empty/whitespace — today's base posture, byte-identical", () => {
    const cfg = readHubClientConfig("   ");
    expect(cfg.armed).toBe(false);
    expect(cfg.reason).toBe("no amicode.hubServerUrl configured");
  });

  it("refuses a non-http(s) or unparseable URL by failing to the base posture with a named reason", () => {
    const garbage = readHubClientConfig("not a url");
    expect(garbage.armed).toBe(false);
    expect(garbage.reason).toContain("not a valid URL");
    const ftp = readHubClientConfig("ftp://hub:4097");
    expect(ftp.armed).toBe(false);
    expect(ftp.reason).toContain("http(s)");
  });

  it("normalizes a trailing slash and preserves any host the operator names (any URL valid)", () => {
    expect(readHubClientConfig("http://10.0.0.4:4097/").url).toBe("http://10.0.0.4:4097");
    expect(readHubClientConfig("http://hub.lan:4097").armed).toBe(true);
  });
});

describe("bootPosture — which client posture activation takes (#1760 P4)", () => {
  it("hub armed wins on ANY platform — the darwin-only fleet guard must not gate it", () => {
    expect(
      bootPosture({ hubArmed: true, fleetClient: false, hasBinary: true }),
    ).toBe("hub-client");
    // The exact erlich shape: Linux remote-SSH host, no fleet guard, vendored binary.
    expect(
      bootPosture({ hubArmed: true, fleetClient: false, hasBinary: true }),
    ).toBe("hub-client");
  });

  it("the explicit setting outranks the inferred fleet-client guard when both would arm", () => {
    expect(
      bootPosture({ hubArmed: true, fleetClient: true, hasBinary: true }),
    ).toBe("hub-client");
  });

  it("unarmed: today's ladder is untouched — fleet client (with its guard binary), else local, else no chat", () => {
    expect(
      bootPosture({ hubArmed: false, fleetClient: true, hasBinary: true }),
    ).toBe("fleet-client");
    expect(
      bootPosture({ hubArmed: false, fleetClient: false, hasBinary: true }),
    ).toBe("local");
    expect(
      bootPosture({ hubArmed: false, fleetClient: false, hasBinary: false }),
    ).toBe("none");
    // The fleet guard without its binary never spawned either (today's shape).
    expect(
      bootPosture({ hubArmed: false, fleetClient: true, hasBinary: false }),
    ).toBe("none");
  });
});

describe("guardReservedHubPort — no port collisions ever (#1760 P4 requirement 3)", () => {
  const sinkLog = () => {
    const lines: string[] = [];
    return { lines, log: (l: string) => lines.push(l) };
  };

  it("refuses every reserved hub port (4094-4097) with a named log line, returning 0 (→ ephemeral)", () => {
    for (const port of RESERVED_HUB_PORTS) {
      const { lines, log } = sinkLog();
      expect(guardReservedHubPort(port, "amicode.opencodePort", log)).toBe(0);
      expect(lines.join("\n")).toContain(`amicode.opencodePort = ${port}`);
      expect(lines.join("\n")).toContain("reserved hub");
    }
  });

  it("passes any non-reserved port and 0 (unset) straight through — today's behavior untouched", () => {
    const { lines, log } = sinkLog();
    expect(guardReservedHubPort(43117, "amicode.opencodePort", log)).toBe(43117);
    expect(guardReservedHubPort(0, "amicode.opencodePort", log)).toBe(0);
    expect(lines).toEqual([]);
  });
});

