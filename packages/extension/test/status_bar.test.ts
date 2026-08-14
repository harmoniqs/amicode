import { describe, it, expect } from "vitest";
import { statusBarLabel } from "../src/status_bar";

describe("statusBarLabel", () => {
  it("booting when server not ready", () => {
    expect(statusBarLabel(false).text).toMatch(/booting/i);
  });
  it("ready shows Amicode", () => {
    expect(statusBarLabel(true).text).toMatch(/Amicode/);
  });
  it("ready tooltip mentions chat + Work Column", () => {
    expect(statusBarLabel(true).tooltip).toMatch(/Work Column/i);
  });
});
