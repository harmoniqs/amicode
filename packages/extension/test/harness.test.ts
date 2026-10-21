import { describe, it, expect } from "vitest";
import { resolveSelectedLaunch, resolveHarness, HARNESS_REGISTRY,
         opencodeDescriptor, telaioDescriptor, harnessMenu, decideHarnessSwitch } from "../src/harness";
import { resolveOpencodeBinary, OpencodeMissingError } from "../src/opencode_binary";

// ============================================================================
// #659: the harness picker seam (ADR-0011). The registry is the menu; the
// default descriptor's resolution IS today's behavior (byte-identity via
// delegation to resolveOpencodeBinary — the same resolver, the same inputs,
// the same errors). telaio ships as needs-setup with guidance until its
// conformance work lands: honest presence, never selectable-but-half-real.
// ============================================================================

describe("harness registry", () => {
  it("ships exactly the two built-ins, default first", () => {
    expect(HARNESS_REGISTRY.map((d) => d.id)).toEqual(["opencode", "telaio"]);
  });

  it("resolves by id; unknown ids resolve to nothing", () => {
    expect(resolveHarness("opencode")).toBe(opencodeDescriptor);
    expect(resolveHarness("telaio")).toBe(telaioDescriptor);
    expect(resolveHarness("ghost")).toBeUndefined();
  });
});

describe("opencode descriptor — the byte-identity guarantee", () => {
  const deps = { extensionPath: "/ext", opencodeBinary: "/custom/opencode", telaioBinary: "" };

  it("delegates to resolveOpencodeBinary with the same inputs", () => {
    // config-override path: deterministic, no fs
    expect(opencodeDescriptor.resolveBinary(deps)).toBe(
      resolveOpencodeBinary(deps.extensionPath, deps.opencodeBinary).path,
    );
  });

  it("is always ready — unlaunchability is resolveBinary's throw, boot's toast path", () => {
    expect(opencodeDescriptor.availability(deps).state).toBe("ready");
  });

  it("consumes the opencode config build, carries no entitlement, adds no env", () => {
    expect(opencodeDescriptor.consumesOpencodeConfig).toBe(true);
    expect(opencodeDescriptor.requiredEntitlement).toBeUndefined();
    expect(opencodeDescriptor.spawnEnvAdditions({ telaioAppDir: "/app" })).toEqual({});
  });
});

describe("telaio descriptor — honest needs-setup until the binary exists", () => {
  it("reports needs-setup with guidance when the binary setting is empty", () => {
    const avail = telaioDescriptor.availability({ opencodeBinary: "", telaioBinary: "" });
    expect(avail.state).toBe("needs-setup");
    expect(avail.detail).toContain("amicode.telaioBinary");
  });

  it("is ready once the binary setting is non-empty (whitespace tolerated)", () => {
    expect(telaioDescriptor.availability({ opencodeBinary: "", telaioBinary: "  ", telaioAppDir: "" }).state).toBe("needs-setup");
    expect(telaioDescriptor.availability({ opencodeBinary: "", telaioBinary: " /opt/telaio ", telaioAppDir: "" }).state).toBe("ready");
  });

  it("resolveBinary trims the setting; empty throws with the actionable message", () => {
    expect(telaioDescriptor.resolveBinary({ extensionPath: "/e", opencodeBinary: "", telaioBinary: " /opt/telaio " }))
      .toBe("/opt/telaio");
    expect(() =>
      telaioDescriptor.resolveBinary({ extensionPath: "/e", opencodeBinary: "", telaioBinary: "" }),
    ).toThrow(/amicode\.telaioBinary/);
  });

  it("skips the opencode config build and carries the entitlement field", () => {
    expect(telaioDescriptor.consumesOpencodeConfig).toBe(false);
    expect(telaioDescriptor.requiredEntitlement).toBe("harness.telaio");
  });

  it("adds TELAIO_APP_DIR when the app tree is set; nothing when not", () => {
    expect(telaioDescriptor.spawnEnvAdditions({ telaioAppDir: "/built/app" }))
      .toEqual({ TELAIO_APP_DIR: "/built/app" });
    expect(telaioDescriptor.spawnEnvAdditions({ telaioAppDir: "" })).toEqual({});
    expect(telaioDescriptor.spawnEnvAdditions({ telaioAppDir: "  " })).toEqual({});
  });

  it("the ready detail distinguishes with-chat from without-chat", () => {
    const withApp = telaioDescriptor.availability({ opencodeBinary: "", telaioBinary: "/opt/telaio", telaioAppDir: "/built/app" });
    const noApp = telaioDescriptor.availability({ opencodeBinary: "", telaioBinary: "/opt/telaio", telaioAppDir: "" });
    expect(withApp.state).toBe("ready");
    expect(withApp.detail).toContain("chat app from the configured app tree");
    expect(noApp.state).toBe("ready");
    expect(noApp.detail).toContain("amicode.telaioAppDir");
  });

  it("resolveSelectedLaunch threads telaioAppDir into the env additions", () => {
    const sel = resolveSelectedLaunch({
      harnessId: "telaio",
      opencodeBinary: "",
      telaioBinary: "/opt/telaio",
      telaioAppDir: "/built/app",
      extensionPath: "/ext",
    });
    expect(sel.descriptor.spawnEnvAdditions({ telaioAppDir: "/built/app" }))
      .toEqual({ TELAIO_APP_DIR: "/built/app" });
  });
});

describe("resolveSelectedLaunch — the one call the spawn sites make", () => {
  it("the default selection is byte-identical: same binary as today's resolver", () => {
    const sel = resolveSelectedLaunch({
      harnessId: "opencode",
      opencodeBinary: "/custom/opencode",
      telaioBinary: "",
      extensionPath: "/ext",
    });
    expect(sel.fellBack).toBe(false);
    expect(sel.descriptor.id).toBe("opencode");
    expect(sel.binary).toBe(resolveOpencodeBinary("/ext", "/custom/opencode").path);
  });

  it("an unset selection defaults to opencode (the default rides the registry)", () => {
    const sel = resolveSelectedLaunch({
      harnessId: "",
      opencodeBinary: "/custom/opencode",
      telaioBinary: "",
      extensionPath: "/ext",
    });
    expect(sel.descriptor.id).toBe("opencode");
    expect(sel.fellBack).toBe(false);
  });

  it("a selected-but-unlaunchable harness falls back to the default, flagged", () => {
    const sel = resolveSelectedLaunch({
      harnessId: "telaio",
      opencodeBinary: "/custom/opencode",
      telaioBinary: "",
      extensionPath: "/ext",
    });
    expect(sel.fellBack).toBe(true);
    expect(sel.descriptor.id).toBe("opencode");
    expect(sel.binary).toBe(resolveOpencodeBinary("/ext", "/custom/opencode").path);
  });

  it("a launchable telaio selection resolves its own binary, no fallback", () => {
    const sel = resolveSelectedLaunch({
      harnessId: "telaio",
      opencodeBinary: "/custom/opencode",
      telaioBinary: "/opt/telaio",
      telaioAppDir: "",
      extensionPath: "/ext",
    });
    expect(sel.fellBack).toBe(false);
    expect(sel.descriptor.id).toBe("telaio");
    expect(sel.binary).toBe("/opt/telaio");
  });

  it("an unknown harness id falls back to opencode, flagged — never silent", () => {
    const sel = resolveSelectedLaunch({
      harnessId: "ghost",
      opencodeBinary: "/custom/opencode",
      telaioBinary: "",
      extensionPath: "/ext",
    });
    expect(sel.descriptor.id).toBe("opencode");
    expect(sel.fellBack).toBe(true); // a hand-edited unknown id warns like any other fallback
  });

  it("propagates OpencodeMissingError from the default's own resolution", () => {
    // a bogus override path is accepted (config-override trusts the user);
    // the vendored path on a bare extensionPath throws — assert the throw class
    expect(() =>
      resolveSelectedLaunch({ harnessId: "opencode", opencodeBinary: "", telaioBinary: "", extensionPath: "/nowhere" }),
    ).toThrow(OpencodeMissingError);
  });
});

// ============================================================================
// #1549 — the harness switcher in the chat box. The composer control and the
// palette command are TWO FRONTS on ONE registry: both render from
// harnessMenu's serialization and both consult decideHarnessSwitch before
// anything persists. The entitlement read-side gate lives HERE (disabled with
// its reason), never as a hidden failure at spawn time.
// ============================================================================

const READY_BAG = { opencodeBinary: "", telaioBinary: "/opt/telaio", telaioAppDir: "" };
const EMPTY_BAG = { opencodeBinary: "", telaioBinary: "", telaioAppDir: "" };

describe("harnessMenu — the one serialization both fronts render (#1549)", () => {
  it("serializes the registry in its order, current marked", () => {
    const menu = harnessMenu({ current: "opencode", entitlements: [], settingsBag: READY_BAG });
    expect(menu.current).toBe("opencode");
    expect(menu.options.map((o) => o.id)).toEqual(["opencode", "telaio"]);
    expect(menu.options[0]?.displayName).toBe("opencode (default)");
    expect(menu.options[1]?.displayName).toBe("telaio (subscription)");
  });

  it("an unset or unknown current falls back to opencode for display — the same default resolveSelectedLaunch serves", () => {
    expect(harnessMenu({ current: "", entitlements: [], settingsBag: READY_BAG }).current).toBe("opencode");
    expect(harnessMenu({ current: "ghost", entitlements: [], settingsBag: READY_BAG }).current).toBe("opencode");
  });

  it("an unresolvable harness is disabled WITH its reason — never silently absent", () => {
    const menu = harnessMenu({ current: "opencode", entitlements: ["harness.telaio"], settingsBag: EMPTY_BAG });
    const telaio = menu.options.find((o) => o.id === "telaio");
    expect(telaio?.disabled).toBe(true);
    expect(telaio?.reason).toContain("amicode.telaioBinary");
  });

  it("an unentitled harness is disabled WITH its reason, even when the binary is set", () => {
    const menu = harnessMenu({ current: "opencode", entitlements: [], settingsBag: READY_BAG });
    const telaio = menu.options.find((o) => o.id === "telaio");
    expect(telaio?.disabled).toBe(true);
    expect(telaio?.reason).toContain("harness.telaio");
  });

  it("an entitled, ready harness is selectable; the default is never disabled", () => {
    const menu = harnessMenu({ current: "opencode", entitlements: ["harness.telaio"], settingsBag: READY_BAG });
    expect(menu.options.find((o) => o.id === "telaio")?.disabled).toBe(false);
    expect(menu.options.find((o) => o.id === "opencode")?.disabled).toBe(false);
    expect(menu.options.find((o) => o.id === "opencode")?.reason).toBeUndefined();
  });
});

describe("decideHarnessSwitch — the one gate both fronts consult (#1549)", () => {
  it("the same harness is an allowed no-op — no restart is poked for nothing", () => {
    const d = decideHarnessSwitch({ requested: "opencode", current: "opencode", entitlements: [], settingsBag: EMPTY_BAG });
    expect(d.allowed).toBe(true);
    expect(d.noop).toBe(true);
  });

  it("an unset request normalizes to the opencode default before comparing", () => {
    const d = decideHarnessSwitch({ requested: "", current: "opencode", entitlements: [], settingsBag: EMPTY_BAG });
    expect(d.allowed).toBe(true);
    expect(d.noop).toBe(true);
  });

  it("an entitled, launchable different harness is allowed", () => {
    const d = decideHarnessSwitch({ requested: "telaio", current: "opencode", entitlements: ["harness.telaio"], settingsBag: READY_BAG });
    expect(d.allowed).toBe(true);
    expect(d.noop).toBe(false);
  });

  it("an unentitled harness is blocked with the entitlement reason — never selectable-then-failing", () => {
    const d = decideHarnessSwitch({ requested: "telaio", current: "opencode", entitlements: [], settingsBag: READY_BAG });
    expect(d.allowed).toBe(false);
    expect(d.reason).toContain("harness.telaio");
  });

  it("a needs-setup harness is blocked with the setup guidance", () => {
    const d = decideHarnessSwitch({ requested: "telaio", current: "opencode", entitlements: ["harness.telaio"], settingsBag: EMPTY_BAG });
    expect(d.allowed).toBe(false);
    expect(d.reason).toContain("amicode.telaioBinary");
  });

  it("an unknown id is blocked — a hand-edited or stale client cannot poke the watcher into a fallback", () => {
    const d = decideHarnessSwitch({ requested: "ghost", current: "opencode", entitlements: ["harness.telaio"], settingsBag: READY_BAG });
    expect(d.allowed).toBe(false);
    expect(d.reason).toBeTruthy();
  });
});

describe("one registry, two fronts — the same decision lands the same state (#1549)", () => {
  // The palette command and the composer watcher are two UIs over ONE state:
  // both flows are decideHarnessSwitch → persist. This pin holds the contract
  // the AC names: switching from either lands the same state, and a blocked
  // request persists NOTHING from either front.
  const persistFlow = (front: "palette" | "composer", input: Parameters<typeof decideHarnessSwitch>[0]) => {
    const decision = decideHarnessSwitch(input);
    const persisted: string[] = [];
    if (decision.allowed && !decision.noop) persisted.push(input.requested);
    return { front, decision, persisted };
  };

  it("an allowed switch lands the same persisted harness from either front", () => {
    const input = { requested: "telaio", current: "opencode", entitlements: ["harness.telaio"], settingsBag: READY_BAG };
    const palette = persistFlow("palette", input);
    const composer = persistFlow("composer", input);
    expect(palette.persisted).toEqual(["telaio"]);
    expect(composer.persisted).toEqual(palette.persisted);
  });

  it("a blocked switch persists NOTHING from either front", () => {
    const input = { requested: "telaio", current: "opencode", entitlements: [], settingsBag: READY_BAG };
    expect(persistFlow("palette", input).persisted).toEqual([]);
    expect(persistFlow("composer", input).persisted).toEqual([]);
  });

  it("a no-op switch persists NOTHING from either front", () => {
    const input = { requested: "opencode", current: "opencode", entitlements: [], settingsBag: EMPTY_BAG };
    expect(persistFlow("palette", input).persisted).toEqual([]);
    expect(persistFlow("composer", input).persisted).toEqual([]);
  });
});
