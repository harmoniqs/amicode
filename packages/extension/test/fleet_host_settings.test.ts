import { describe, it, expect } from "vitest";
import {
  validateHostSettings,
  settingsNeedingRestart,
  RESTART_REQUIRED_SETTINGS,
  type HostSettings,
} from "../src/fleet_host_settings";

const VALID: HostSettings = {
  dbPath: "/home/user/.amico/ops/sessions.db",
  port: 4096,
  binaryPath: "/usr/local/bin/opencode",
  logDir: "/var/log/amico",
};

describe("validateHostSettings", () => {
  it("passes for valid settings", () => {
    expect(validateHostSettings(VALID)).toEqual([]);
  });

  it("rejects port below 1024", () => {
    const errors = validateHostSettings({ ...VALID, port: 80 });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("Port must be");
  });

  it("rejects port above 65535", () => {
    const errors = validateHostSettings({ ...VALID, port: 70000 });
    expect(errors).toHaveLength(1);
  });

  it("rejects non-integer port", () => {
    const errors = validateHostSettings({ ...VALID, port: 4096.5 });
    expect(errors).toHaveLength(1);
  });

  it("rejects relative dbPath", () => {
    const errors = validateHostSettings({ ...VALID, dbPath: "relative/path" });
    expect(errors).toContain("Database path must be absolute");
  });

  it("rejects relative binaryPath", () => {
    const errors = validateHostSettings({ ...VALID, binaryPath: "opencode" });
    expect(errors).toContain("Binary path must be absolute");
  });

  it("rejects relative logDir", () => {
    const errors = validateHostSettings({ ...VALID, logDir: "logs/" });
    expect(errors).toContain("Log directory must be absolute");
  });

  it("allows undefined fields (partial validation)", () => {
    expect(validateHostSettings({})).toEqual([]);
  });
});

describe("settingsNeedingRestart", () => {
  it("returns empty when nothing changed", () => {
    expect(settingsNeedingRestart(VALID, VALID)).toEqual([]);
  });

  it("detects port change", () => {
    const updated = { ...VALID, port: 5000 };
    const needs = settingsNeedingRestart(VALID, updated);
    expect(needs).toContain("port");
  });

  it("detects binaryPath change", () => {
    const updated = { ...VALID, binaryPath: "/new/path/opencode" };
    const needs = settingsNeedingRestart(VALID, updated);
    expect(needs).toContain("binaryPath");
  });

  it("detects dbPath change", () => {
    const updated = { ...VALID, dbPath: "/new/db/path" };
    const needs = settingsNeedingRestart(VALID, updated);
    expect(needs).toContain("dbPath");
  });

  it("does NOT require restart for logDir change", () => {
    const updated = { ...VALID, logDir: "/different/logs" };
    const needs = settingsNeedingRestart(VALID, updated);
    expect(needs).not.toContain("logDir");
  });
});

describe("RESTART_REQUIRED_SETTINGS", () => {
  it("includes dbPath, port, binaryPath but not logDir", () => {
    expect(RESTART_REQUIRED_SETTINGS).toContain("dbPath");
    expect(RESTART_REQUIRED_SETTINGS).toContain("port");
    expect(RESTART_REQUIRED_SETTINGS).toContain("binaryPath");
    expect(RESTART_REQUIRED_SETTINGS).not.toContain("logDir");
  });
});
