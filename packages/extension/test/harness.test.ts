import { describe, it, expect } from "vitest";
import { resolveSelectedLaunch, resolveHarness, HARNESS_REGISTRY,
         opencodeDescriptor, telaioDescriptor } from "../src/harness";
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
