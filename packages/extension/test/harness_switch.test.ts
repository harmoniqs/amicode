import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  harnessSwitchFile,
  harnessOptionsFile,
  readHarnessSwitchState,
  writeHarnessReady,
  writeHarnessOptionsFile,
  watchHarnessSwitch,
} from "../src/harness_switch";
import { harnessMenu } from "../src/harness";

// ============================================================================
// #1549 — the harness handshake, the solver-mode file contract's twin. The
// engine route POSTs {harness, status:"switching"}; the extension watcher
// performs the real switch (the registry gate, the setting persist, the
// server restart) and only then settles status:"ready" — at the harness that
// ACTUALLY took effect, which is the previous one when the switch was refused.
// ============================================================================

describe("harness handshake files", () => {
  it("harnessSwitchFile and harnessOptionsFile live in the ops dir, overridable for tests", () => {
    const dir = mkdtempSync(join(tmpdir(), "hw-"));
    expect(harnessSwitchFile(dir)).toBe(join(dir, "harness.json"));
    expect(harnessOptionsFile(dir)).toBe(join(dir, "harness-options.json"));
  });

  it("readHarnessSwitchState defaults opencode/ready; tolerant of corrupt and off-shape files", () => {
    const dir = mkdtempSync(join(tmpdir(), "hw-"));
    const f = join(dir, "harness.json");
    expect(readHarnessSwitchState(f)).toEqual({ harness: "opencode", status: "ready" });
    writeFileSync(f, "not json {{{");
    expect(readHarnessSwitchState(f)).toEqual({ harness: "opencode", status: "ready" });
    writeFileSync(f, JSON.stringify({ harness: 42, status: "weird" }));
    expect(readHarnessSwitchState(f)).toEqual({ harness: "opencode", status: "ready" });
  });

  it("the ENGINE's switching write ({harness, status:switching}) is what the watcher reads", () => {
    const dir = mkdtempSync(join(tmpdir(), "hw-"));
    const f = join(dir, "harness.json");
    writeFileSync(f, JSON.stringify({ harness: "telaio", status: "switching" }));
    expect(readHarnessSwitchState(f)).toEqual({ harness: "telaio", status: "switching" });
  });

  it("writeHarnessReady round-trips with a switched_at stamp", () => {
    const dir = mkdtempSync(join(tmpdir(), "hw-"));
    const f = join(dir, "harness.json");
    writeHarnessReady("telaio", f);
    const parsed = JSON.parse(readFileSync(f, "utf8")) as Record<string, unknown>;
    expect(parsed.harness).toBe("telaio");
    expect(parsed.status).toBe("ready");
    expect(typeof parsed.switched_at).toBe("string");
    expect(readHarnessSwitchState(f)).toEqual({ harness: "telaio", status: "ready" });
  });

  it("writeHarnessOptionsFile publishes the registry menu verbatim, creating the dir", () => {
    const dir = join(mkdtempSync(join(tmpdir(), "hw-")), "nested");
    const menu = harnessMenu({ current: "opencode", entitlements: [], settingsBag: { opencodeBinary: "", telaioBinary: "", telaioAppDir: "" } });
    writeHarnessOptionsFile(menu, join(dir, "harness-options.json"));
    expect(JSON.parse(readFileSync(join(dir, "harness-options.json"), "utf8"))).toEqual(menu);
  });
});

describe("watchHarnessSwitch", () => {
  it("fires once per switching request and settles ready at the harness onSwitch reports", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hw-"));
    const f = join(dir, "harness.json");
    writeFileSync(f, JSON.stringify({ harness: "telaio", status: "switching" }));
    const calls: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const w = watchHarnessSwitch(
      async (harness) => {
        calls.push(harness);
        await gate;
        return harness;
      },
      f,
      20,
    );
    await new Promise((r) => setTimeout(r, 120));
    expect(calls).toEqual(["telaio"]);
    release();
    await new Promise((r) => setTimeout(r, 120));
    expect(readHarnessSwitchState(f)).toEqual({ harness: "telaio", status: "ready" });
    w.dispose();
  });

  it("the busy latch holds — a slow switch is never re-entered by the next tick", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hw-"));
    const f = join(dir, "harness.json");
    writeFileSync(f, JSON.stringify({ harness: "telaio", status: "switching" }));
    const calls: string[] = [];
    const w = watchHarnessSwitch(
      async (harness) => {
        calls.push(harness);
        await new Promise((r) => setTimeout(r, 300));
        return harness;
      },
      f,
      20,
    );
    await new Promise((r) => setTimeout(r, 150));
    expect(calls).toEqual(["telaio"]);
    w.dispose();
  });

  it("a REFUSED switch settles ready at the harness onSwitch returns — the honest state, never the refused one", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hw-"));
    const f = join(dir, "harness.json");
    writeFileSync(f, JSON.stringify({ harness: "telaio", status: "switching" }));
    const w = watchHarnessSwitch(
      async () => "opencode", // the watcher refuses: settle at the CURRENT harness
      f,
      20,
    );
    await new Promise((r) => setTimeout(r, 120));
    expect(readHarnessSwitchState(f)).toEqual({ harness: "opencode", status: "ready" });
    w.dispose();
  });

  it("a failing onSwitch settles ready at the CURRENT default rather than lying about the switch", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hw-"));
    const f = join(dir, "harness.json");
    writeFileSync(f, JSON.stringify({ harness: "telaio", status: "switching" }));
    const w = watchHarnessSwitch(
      async () => {
        throw new Error("restart failed");
      },
      f,
      20,
    );
    await new Promise((r) => setTimeout(r, 120));
    // the solver-mode watcher settles ready at the REQUESTED mode on failure;
    // harness switching has a cheaper truth — the setting is unchanged, so the
    // file reads the still-current default. Never a lie we can't tell.
    expect(readHarnessSwitchState(f)).toEqual({ harness: "opencode", status: "ready" });
    w.dispose();
  });

  it("an already-ready file never fires", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hw-"));
    const f = join(dir, "harness.json");
    writeHarnessReady("opencode", f);
    const onSwitch = vi.fn(async (h: string) => h);
    const w = watchHarnessSwitch(onSwitch, f, 20);
    await new Promise((r) => setTimeout(r, 120));
    expect(onSwitch).not.toHaveBeenCalled();
    w.dispose();
  });

  it("creates the ops dir when writing ready into a missing tree", () => {
    const dir = join(mkdtempSync(join(tmpdir(), "hw-")), "missing", "ops");
    writeHarnessReady("opencode", join(dir, "harness.json"));
    expect(readHarnessSwitchState(join(dir, "harness.json"))).toEqual({ harness: "opencode", status: "ready" });
  });

  it("watchHarnessSwitch tolerates a missing file between ticks (the pre-boot state)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hw-"));
    const f = join(dir, "harness.json");
    const onSwitch = vi.fn(async (h: string) => h);
    const w = watchHarnessSwitch(onSwitch, f, 20);
    await new Promise((r) => setTimeout(r, 80));
    expect(onSwitch).not.toHaveBeenCalled();
    writeFileSync(f, JSON.stringify({ harness: "opencode", status: "switching" }));
    await new Promise((r) => setTimeout(r, 120));
    expect(onSwitch).toHaveBeenCalledWith("opencode");
    w.dispose();
  });
});
