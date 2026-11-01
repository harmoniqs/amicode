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

describe("auditAdoptedEngine — persistent stale indicator (#1571)", () => {
  const mk = (indicator: (s: { detail: string } | undefined) => void, choice?: string): StaleNoticeDeps => ({
    showInformationMessage: async () => choice,
    onRestartRequested: async () => {},
    setStaleIndicator: indicator,
  });

  it("raises the indicator while stale — even when the toast is dismissed", async () => {
    const calls: Array<{ detail: string } | undefined> = [];
    const r = await auditAdoptedEngine(
      { binaryHash: "OLD", configHash: "CFG" },
      { binaryPath: "/opt/opencode", configContent: "cfg" },
      { hashFile: async () => "NEW", hashString: () => "CFG", notify: mk((s) => calls.push(s), undefined) },
    );
    await new Promise((res) => setTimeout(res, 0));
    expect(r?.stale).toBe(true);
    expect(calls).toEqual([{ detail: "engine binary" }]);
  });

  it("names binary+config when both diverge", async () => {
    const calls: Array<{ detail: string } | undefined> = [];
    await auditAdoptedEngine(
      { binaryHash: "OLD", configHash: "OLDC" },
      { binaryPath: "/opt/opencode", configContent: "cfg" },
      { hashFile: async () => "NEW", hashString: () => "NEWC", notify: mk((s) => calls.push(s)) },
    );
    expect(calls).toEqual([{ detail: "engine binary and config" }]);
  });

  it("clears the indicator when the engine is current", async () => {
    const calls: Array<{ detail: string } | undefined> = [];
    await auditAdoptedEngine(
      { binaryHash: "BIN", configHash: "CFG" },
      { binaryPath: "/opt/opencode", configContent: "cfg" },
      { hashFile: async () => "BIN", hashString: () => "CFG", notify: mk((s) => calls.push(s)) },
    );
    expect(calls).toEqual([undefined]);
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

describe("auditAdoptedEngine — self-heal when no turn is in flight (#1571)", () => {
  const stale = { binaryHash: "OLD", configHash: "CFG" };
  const disk = { binaryPath: "/opt/opencode", configContent: "cfg" };
  const tick = () => new Promise((res) => setTimeout(res, 0));

  function harness(opts: {
    inflight: () => boolean | Promise<boolean>;
    allow?: () => boolean;
  }) {
    const toasts: string[] = [];
    const restarts: number[] = [];
    const recorded: number[] = [];
    const quiesce = new Set<() => void>();
    const notify: StaleNoticeDeps = {
      showInformationMessage: async (m: string) => { toasts.push(m); return undefined; },
      onRestartRequested: async () => { restarts.push(1); },
      autoRestart: {
        hasInflightTurns: opts.inflight,
        onQuiesce: (cb) => { quiesce.add(cb); return () => { quiesce.delete(cb); }; },
        allow: opts.allow,
        record: () => { recorded.push(1); },
      },
    };
    const run = () => auditAdoptedEngine(stale, disk, { hashFile: async () => "NEW", hashString: () => "CFG", notify });
    return { toasts, restarts, recorded, quiesce, run };
  }

  it("restarts automatically — no toast, no click — when stale and nothing is in flight", async () => {
    const h = harness({ inflight: () => false });
    const r = await h.run();
    await tick();
    expect(r?.stale).toBe(true);
    expect(h.restarts).toHaveLength(1);
    expect(h.recorded).toHaveLength(1);
    expect(h.toasts).toHaveLength(0);
  });

  it("accepts an async hasInflightTurns", async () => {
    const h = harness({ inflight: async () => false });
    await h.run();
    await tick();
    expect(h.restarts).toHaveLength(1);
  });

  it("does NOT restart mid-turn: notifies instead, and retries the moment the turn ends", async () => {
    let busy = true;
    const h = harness({ inflight: () => busy });
    await h.run();
    await tick();
    expect(h.restarts).toHaveLength(0);
    expect(h.toasts).toHaveLength(1);
    expect(h.quiesce.size).toBe(1);
    busy = false;
    for (const cb of [...h.quiesce]) cb();
    await tick();
    expect(h.restarts).toHaveLength(1);
    expect(h.recorded).toHaveLength(1);
    expect(h.quiesce.size).toBe(0); // one-shot
  });

  it("a quiesce while another turn already restarted the world re-checks before acting", async () => {
    let busy = true;
    const h = harness({ inflight: () => busy });
    await h.run();
    for (const cb of [...h.quiesce]) cb(); // fires but a new turn is already busy
    await tick();
    expect(h.restarts).toHaveLength(0);
    expect(h.quiesce.size).toBe(1); // still armed for the next quiesce
  });

  it("an unknowable in-flight state (throws) is treated as in flight — never restart on a guess", async () => {
    const h = harness({ inflight: () => { throw new Error("no seam"); } });
    await h.run();
    await tick();
    expect(h.restarts).toHaveLength(0);
    expect(h.toasts).toHaveLength(1);
  });

  it("loop guard: when allow() is false, falls back to the toast and never auto-restarts", async () => {
    const h = harness({ inflight: () => false, allow: () => false });
    await h.run();
    await tick();
    expect(h.restarts).toHaveLength(0);
    expect(h.recorded).toHaveLength(0);
    expect(h.toasts).toHaveLength(1);
    expect(h.quiesce.size).toBe(0);
  });

  it("never auto-restarts a current engine", async () => {
    const h = harness({ inflight: () => false });
    const r = await auditAdoptedEngine(
      { binaryHash: "BIN", configHash: "CFG" }, disk,
      { hashFile: async () => "BIN", hashString: () => "CFG", notify: {
        showInformationMessage: async () => undefined,
        onRestartRequested: async () => { h.restarts.push(1); },
        autoRestart: { hasInflightTurns: () => false, onQuiesce: () => () => {} },
      } },
    );
    await tick();
    expect(r?.stale).toBe(false);
    expect(h.restarts).toHaveLength(0);
  });

  it("without an autoRestart seam the behavior is the original toast-only notice", async () => {
    const toasts: string[] = [];
    await auditAdoptedEngine(stale, disk, {
      hashFile: async () => "NEW", hashString: () => "CFG",
      notify: { showInformationMessage: async (m: string) => { toasts.push(m); return undefined; }, onRestartRequested: async () => {} },
    });
    expect(toasts).toHaveLength(1);
  });

  it("unarmed (hub) engines are never auto-restarted — shared with other windows", async () => {
    const h = harness({ inflight: () => false });
    const r = await auditAdoptedEngine(
      { binaryHash: "OLD", configHash: "" }, disk,
      { hashFile: async () => "NEW", hashString: () => "CFG", notify: {
        showInformationMessage: async (m: string) => { h.toasts.push(m); return undefined; },
        onRestartRequested: async () => { h.restarts.push(1); },
        autoRestart: { hasInflightTurns: () => false, onQuiesce: () => () => {} },
      } },
      true,
    );
    await tick();
    expect(r?.stale).toBe(true);
    expect(h.restarts).toHaveLength(0);
    expect(h.toasts).toHaveLength(1);
  });
});
