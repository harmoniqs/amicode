// fleet_header_wiring.test.ts — #1764 structural checks for the activation
// wiring that activate() makes impossible to unit-construct: the shared
// chat-session launcher reaching both Troubleshoot entry points and Add
// machine, the focus host's change hook, and the focused-machine read seam.
// The skills the FLEET header routes to must ship in the extension's library.
import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const extSrc = readFileSync(resolve(__dirname, "..", "src", "extension.ts"), "utf8");

/** The `defaultFleetSectionDeps({ … })` call in activate(), up to the provider's close. */
function fleetDepsCall(): string {
  const start = extSrc.indexOf("new SidebarViewProvider(ctx.extensionUri, undefined, defaultFleetSectionDeps({");
  expect(start).toBeGreaterThan(-1);
  const end = extSrc.indexOf("registerWebviewViewProvider(\"amicode.workspace\"", start);
  expect(end).toBeGreaterThan(start);
  return extSrc.slice(start, end);
}

/** The boot-time fleet warning's Troubleshoot pick handler. */
function bootTroubleshootBlock(): string {
  const start = extSrc.indexOf('if (pick === "Troubleshoot")');
  expect(start).toBeGreaterThan(-1);
  return extSrc.slice(start, extSrc.indexOf("});", start));
}

describe("activation wiring — the shared chat-session launcher (#1764)", () => {
  it("activate() builds one launcher over the real ChatPanel open-or-reveal path", () => {
    expect(extSrc).toMatch(/const chatSessionLauncher = createChatSessionLauncher\(\{/);
    const start = extSrc.indexOf("const chatSessionLauncher = createChatSessionLauncher({");
    const block = extSrc.slice(start, extSrc.indexOf("\n  });", start));
    expect(block).toContain("isServerReady: () => !!opencodeReadyUrl");
    expect(block).toContain("ChatPanel.openOrReveal(ctx, frameUrl() ?? readyUrl, serverAuthToken(serverPassword), opencodeProject.projectDir)");
    expect(block).toContain("showWarningMessage");
  });

  it("the fleet section's launchSession (sidebar Troubleshoot + Add machine) is the launcher", () => {
    expect(fleetDepsCall()).toMatch(/launchSession: \(prompt\) => chatSessionLauncher\.launch\(prompt\)/);
  });

  it("the boot-warning Troubleshoot launches through the launcher, not the peek-only path", () => {
    const block = bootTroubleshootBlock();
    expect(block).toContain('chatSessionLauncher.launch("/troubleshoot-fleet")');
    expect(block).not.toContain("ChatPanel.peek()");
    expect(block).not.toContain("postMessage");
  });
});

describe("the FLEET header's routed skills ship in the extension's skill library (#1764)", () => {
  it.each(["create-a-fleet", "add-fleet-device", "troubleshoot-fleet"])("%s", (skill) => {
    const file = resolve(__dirname, "..", "skills", skill, "SKILL.md");
    expect(existsSync(file)).toBe(true);
    expect(readFileSync(file, "utf8")).toMatch(new RegExp(`^name:\\s*${skill}\\s*$`, "m"));
  });

  it("the skill library is not excluded from the packaged extension", () => {
    const ignore = readFileSync(resolve(__dirname, "..", ".vscodeignore"), "utf8");
    expect(ignore.split("\n").map((l) => l.trim())).not.toContain("skills/**");
  });
});
