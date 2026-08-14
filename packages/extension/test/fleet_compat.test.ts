import { describe, it, expect } from "vitest";
import {
  parseSemVer,
  checkCompatibility,
  buildServerVersionFile,
  KNOWN_CAPABILITIES,
  CLIENT_VERSION,
  type ServerInfo,
} from "../src/fleet_compat";

describe("parseSemVer", () => {
  it("parses a valid semver string", () => {
    expect(parseSemVer("0.2.1")).toEqual({ major: 0, minor: 2, patch: 1 });
    expect(parseSemVer("1.0.0")).toEqual({ major: 1, minor: 0, patch: 0 });
    expect(parseSemVer("2.15.3")).toEqual({ major: 2, minor: 15, patch: 3 });
  });

  it("handles version with extra suffix", () => {
    expect(parseSemVer("0.2.1-beta.1")).toEqual({ major: 0, minor: 2, patch: 1 });
  });

  it("returns null for invalid", () => {
    expect(parseSemVer("abc")).toBeNull();
    expect(parseSemVer("")).toBeNull();
    expect(parseSemVer("1.2")).toBeNull();
  });
});

describe("checkCompatibility", () => {
  const baseServer: ServerInfo = {
    version: "0.2.1",
    schema: 1,
    capabilities: ["sessions", "fleet-state", "fleet-action"],
  };

  it("returns compatible when versions match", () => {
    const result = checkCompatibility("0.2.1", baseServer);
    expect(result.state).toBe("compatible");
    expect(result.missingCapabilities).toEqual([]);
  });

  it("returns compatible when client is newer (same major)", () => {
    const result = checkCompatibility("0.3.0", { ...baseServer, version: "0.2.1" });
    expect(result.state).toBe("compatible");
  });

  it("returns degraded when server is newer (same major, higher minor)", () => {
    const result = checkCompatibility("0.2.1", { ...baseServer, version: "0.3.0" });
    expect(result.state).toBe("degraded");
    expect(result.message).toContain("rebuild extension");
  });

  it("returns degraded when server has unknown capabilities", () => {
    const serverWithNew: ServerInfo = {
      version: "0.2.1",
      schema: 1,
      capabilities: ["sessions", "fleet-state", "new-future-feature"],
    };
    const result = checkCompatibility("0.2.1", serverWithNew);
    expect(result.state).toBe("degraded");
    expect(result.missingCapabilities).toContain("new-future-feature");
  });

  it("returns incompatible on major version mismatch", () => {
    const result = checkCompatibility("0.2.1", { ...baseServer, version: "1.0.0" });
    expect(result.state).toBe("incompatible");
    expect(result.message).toContain("Go Standalone");
  });

  it("returns degraded when versions can't be parsed", () => {
    const result = checkCompatibility("bad", { ...baseServer, version: "also-bad" });
    expect(result.state).toBe("degraded");
    expect(result.message).toContain("Could not parse");
  });
});

describe("buildServerVersionFile", () => {
  it("produces valid JSON with version, schema, and capabilities", () => {
    const file = buildServerVersionFile("0.2.1");
    const parsed = JSON.parse(file);
    expect(parsed.version).toBe("0.2.1");
    expect(parsed.schema).toBe(1);
    expect(parsed.capabilities).toEqual([...KNOWN_CAPABILITIES]);
  });

  it("allows custom capabilities", () => {
    const file = buildServerVersionFile("1.0.0", ["sessions", "custom"]);
    const parsed = JSON.parse(file);
    expect(parsed.capabilities).toEqual(["sessions", "custom"]);
  });
});

describe("CLIENT_VERSION", () => {
  it("is a valid semver string", () => {
    expect(parseSemVer(CLIENT_VERSION)).not.toBeNull();
  });
});
