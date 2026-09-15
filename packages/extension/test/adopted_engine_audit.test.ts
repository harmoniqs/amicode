// #1190 (ADR 0020, parent #1142): wire the stale-engine safeguard.
// The adoption gate keys on protocolVersion only, not binaryHash — so a reload
// adopts a live server running an OLD binary whenever the protocol is unchanged.
// #1148 designed detect+notice (adopt-then-notice, to keep in-flight turns) but
// left it unwired. These two helpers are the wireable, testable core:
//   auditAdoptedEngine   — compare adopted-vs-on-disk hashes + surface the notice
//   restartAdoptedEngine — a restart that is CORRECT for an adopted server
//                          (no serverManager): reclaim port → delete handshake → reload
import { describe, it, expect } from "vitest";
import {
  auditAdoptedEngine,
  restartAdoptedEngine,
  type StaleNoticeDeps,
} from "../src/server_lifecycle";

describe("auditAdoptedEngine — detect + notice on the adopted path (#1190)", () => {
  it("returns undefined and shows nothing when there are no recorded (adopted) hashes", async () => {
    const shown: string[] = [];
    const notify: StaleNoticeDeps = {
      showInformationMessage: async (m: string) => { shown.push(m); return undefined; },
      onRestartRequested: async () => {},
    };
    const r = await auditAdoptedEngine(undefined, { binaryPath: "/bin/x", configContent: "cfg" }, {
      hashFile: async () => "whatever",
      hashString: () => "whatever",
      notify,
    });
    expect(r).toBeUndefined();
    expect(shown).toHaveLength(0);
  });

  it("hashes the on-disk binary + config and reports not-stale when they match the record", async () => {
    const seen: { path?: string; cfg?: string } = {};
    const shown: string[] = [];
    const notify: StaleNoticeDeps = {
      showInformationMessage: async (m: string) => { shown.push(m); return undefined; },
      onRestartRequested: async () => {},
    };
    const r = await auditAdoptedEngine(
      { binaryHash: "BIN", configHash: "CFG" },
      { binaryPath: "/opt/opencode", configContent: "the-config" },
      {
        hashFile: async (p) => { seen.path = p; return "BIN"; },
        hashString: (s) => { seen.cfg = s; return "CFG"; },
        notify,
      },
    );
    expect(seen.path).toBe("/opt/opencode");     // hashed the right binary path
    expect(seen.cfg).toBe("the-config");         // hashed the right config content
    expect(r?.stale).toBe(false);
    expect(shown).toHaveLength(0);               // no notice when versions agree
  });

  it("surfaces a notice naming the binary when the on-disk binary differs, and Restart invokes the callback", async () => {
    const shown: string[] = [];
    let restarts = 0;
    const notify: StaleNoticeDeps = {
      // user clicks "Restart Engine"
      showInformationMessage: async (m: string) => { shown.push(m); return "Restart Engine"; },
      onRestartRequested: async () => { restarts++; },
    };
    const r = await auditAdoptedEngine(
      { binaryHash: "OLD", configHash: "CFG" },
      { binaryPath: "/opt/opencode", configContent: "cfg" },
      { hashFile: async () => "NEW", hashString: () => "CFG", notify },
    );
    await new Promise((res) => setTimeout(res, 0));
    expect(r?.stale).toBe(true);
    expect(r?.binaryChanged).toBe(true);
    expect(shown).toHaveLength(1);
    expect(shown[0]).toContain("binary");
    expect(restarts).toBe(1);
  });

  it("surfaces a config-changed notice when only the config differs", async () => {
    const shown: string[] = [];
    const notify: StaleNoticeDeps = {
      showInformationMessage: async (m: string) => { shown.push(m); return undefined; },
      onRestartRequested: async () => {},
    };
    const r = await auditAdoptedEngine(
      { binaryHash: "BIN", configHash: "OLD" },
      { binaryPath: "/opt/opencode", configContent: "new-cfg" },
      { hashFile: async () => "BIN", hashString: () => "NEW", notify },
    );
    await new Promise((res) => setTimeout(res, 0));
    expect(r?.stale).toBe(true);
    expect(r?.configChanged).toBe(true);
    expect(shown[0]).toContain("config");
  });
});

describe("restartAdoptedEngine — correct restart for an adopted (no serverManager) server (#1190)", () => {
  it("reclaims the port, deletes the handshake, then reloads the window — in that order", async () => {
    const order: string[] = [];
    await restartAdoptedEngine({
      port: 43117,
      reclaimPort: async (p) => { order.push(`reclaim:${p}`); return true; },
      deleteHandshake: () => { order.push("delete"); },
      reloadWindow: () => { order.push("reload"); },
    });
    expect(order).toEqual(["reclaim:43117", "delete", "reload"]);
  });

  it("still deletes the handshake and reloads even if the port could not be reclaimed (idempotent)", async () => {
    let deleted = false;
    let reloaded = false;
    await restartAdoptedEngine({
      port: 43117,
      reclaimPort: async () => false,   // couldn't free it
      deleteHandshake: () => { deleted = true; },
      reloadWindow: () => { reloaded = true; },
    });
    expect(deleted).toBe(true);
    expect(reloaded).toBe(true);
  });
});
