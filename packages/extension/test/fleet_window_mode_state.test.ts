// #1272 — WINDOW MODE as its OWN field + writer/signature (mirrors #780's
// posture-state writer). Window mode (Remote-SSH vs editor-local) is an axis
// ORTHOGONAL to link-health posture: overloading the posture field would break
// its single-writer / transition-only contract and SILENTLY SWALLOW a
// window-mode-only change (the mode flips while hub reachability is unchanged,
// so the posture signature never moves and the posture writer never writes).
//
// So window mode gets its OWN field (values `remote-ssh | local`, never the
// link-health `standalone` token — AC1), its OWN writer with its OWN transition
// signature (the window-mode value, NOT the posture signature — AC2), and its
// OWN state file. This suite pins: the pure `remote-ssh | local` derivation
// from the editor's remote indicator, the issue-named schema, TRANSITION-ONLY
// write discipline, the atomic on-disk write at the ops-fleet path, the
// never-throw contract, and — the crux — cross-writer INDEPENDENCE: a
// window-mode-only transition writes even when the posture facts are unchanged,
// and the link-health posture writer is untouched by window-mode changes (AC4).
import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  FLEET_WINDOW_MODE_STATE_VERSION,
  fleetWindowModeStateFile,
  windowModeFromRemoteName,
  windowModeFacts,
  buildWindowModeRecord,
  WindowModeStateWriter,
  type WindowMode,
  type WindowModeFacts,
  type WindowModeStateFile,
} from "../src/fleet_window_mode_state";
import { FleetPostureStateWriter, type PostureFacts, type FleetPostureStateFile } from "../src/fleet_posture_state";

const FIXED_NOW = "2026-09-19T01:00:00.000Z";
const now = () => FIXED_NOW;

// ── AC1: the pure derivation from the editor's remote indicator ──────────────
// VS Code exposes the window's remote via `vscode.env.remoteName`: an
// `ssh-remote…` string under Remote-SSH, `undefined` when the editor is local.
// The mapping is a PURE function so it is TDD'd with no live editor, and it
// emits ONLY the two window-mode tokens — NEVER the link-health `standalone`.

describe("windowModeFromRemoteName — remote indicator → window mode (AC1)", () => {
  it("an ssh-remote indicator maps to remote-ssh (bare)", () => {
    expect(windowModeFromRemoteName("ssh-remote")).toBe("remote-ssh");
  });
  it("an ssh-remote+<host> indicator maps to remote-ssh (the real Remote-SSH shape)", () => {
    expect(windowModeFromRemoteName("ssh-remote+7b2f…hub")).toBe("remote-ssh");
  });
  it("undefined (editor-local, no remote) maps to local", () => {
    expect(windowModeFromRemoteName(undefined)).toBe("local");
  });
  it("an empty string maps to local", () => {
    expect(windowModeFromRemoteName("")).toBe("local");
  });
  it("a non-ssh remote (wsl, dev-container, tunnel) is NOT remote-ssh — it maps to local", () => {
    expect(windowModeFromRemoteName("wsl")).toBe("local");
    expect(windowModeFromRemoteName("dev-container")).toBe("local");
    expect(windowModeFromRemoteName("tunnel")).toBe("local");
  });
  it("NEVER emits the link-health `standalone` token — only the two window-mode values (AC1)", () => {
    const values: WindowMode[] = [
      windowModeFromRemoteName("ssh-remote+a"),
      windowModeFromRemoteName(undefined),
      windowModeFromRemoteName("wsl"),
    ];
    for (const v of values) {
      expect(v === "remote-ssh" || v === "local").toBe(true);
      expect(v).not.toBe("standalone");
    }
  });
});

// ── the schema: every field, honestly, remote_name provenance preserved ──────

describe("buildWindowModeRecord — the record schema", () => {
  it("a remote-ssh fact produces a record with hostname, window_mode, remote_name provenance, updated_at", () => {
    const rec = buildWindowModeRecord(
      { hostname: "macbook", window_mode: "remote-ssh", remote_name: "ssh-remote+hub" },
      now,
    );
    expect(rec.schema_version).toBe(FLEET_WINDOW_MODE_STATE_VERSION);
    expect(rec.hostname).toBe("macbook");
    expect(rec.window_mode).toBe("remote-ssh");
    expect(rec.remote_name).toBe("ssh-remote+hub");
    expect(rec.updated_at).toBe(FIXED_NOW);
  });
  it("an absent remote_name (local window) is explicitly null, never undefined or a guess", () => {
    const rec = buildWindowModeRecord({ hostname: "mini", window_mode: "local" }, now);
    expect(rec.window_mode).toBe("local");
    expect(rec.remote_name).toBeNull();
  });
  it("windowModeFacts derives the mode + preserves the raw remote_name from a remote indicator", () => {
    const remote: WindowModeFacts = windowModeFacts("macbook", "ssh-remote+hub");
    expect(remote).toEqual({ hostname: "macbook", window_mode: "remote-ssh", remote_name: "ssh-remote+hub" });
    const local: WindowModeFacts = windowModeFacts("macbook", undefined);
    expect(local).toEqual({ hostname: "macbook", window_mode: "local", remote_name: null });
  });
});

// ── transition-only write discipline: the signature is the window-mode VALUE ──

describe("WindowModeStateWriter — transition-only write discipline", () => {
  function spyWriter(): { writer: WindowModeStateWriter; writes: WindowModeStateFile[] } {
    const writes: WindowModeStateFile[] = [];
    const writer = new WindowModeStateWriter({
      now,
      writeFile: (_file, text) => writes.push(JSON.parse(text) as WindowModeStateFile),
    });
    return { writer, writes };
  }

  it("the first record is a write (the initial window-mode observation)", () => {
    const { writer, writes } = spyWriter();
    const r = writer.record({ hostname: "macbook", window_mode: "local", remote_name: null });
    expect(r.wrote).toBe(true);
    expect(writes.length).toBe(1);
    expect(writes[0].window_mode).toBe("local");
  });

  it("identical observations after a write write NOTHING (not on every tick)", () => {
    const { writer, writes } = spyWriter();
    writer.record({ hostname: "macbook", window_mode: "local", remote_name: null });
    for (let i = 0; i < 20; i++)
      expect(writer.record({ hostname: "macbook", window_mode: "local", remote_name: null }).wrote).toBe(false);
    expect(writes.length).toBe(1);
  });

  it("a window-mode flip IS a transition: local → remote-ssh → local writes each time", () => {
    const { writer, writes } = spyWriter();
    writer.record({ hostname: "macbook", window_mode: "local", remote_name: null });
    writer.record({ hostname: "macbook", window_mode: "remote-ssh", remote_name: "ssh-remote+hub" });
    writer.record({ hostname: "macbook", window_mode: "local", remote_name: null });
    expect(writes.map((w) => w.window_mode)).toEqual(["local", "remote-ssh", "local"]);
  });

  it("the signature is the window-mode VALUE ALONE — a changed remote_name at the same mode is NOT a transition", () => {
    const { writer, writes } = spyWriter();
    writer.record({ hostname: "macbook", window_mode: "remote-ssh", remote_name: "ssh-remote+hubA" });
    // re-attached to a DIFFERENT ssh host, still remote-ssh → same window mode, no rewrite
    expect(
      writer.record({ hostname: "macbook", window_mode: "remote-ssh", remote_name: "ssh-remote+hubB" }).wrote,
    ).toBe(false);
    expect(writes.length).toBe(1);
  });
});

// ── the on-disk write: atomic, at the ops-fleet path, never throws ───────────

describe("WindowModeStateWriter — persistence at the ops-fleet path", () => {
  it("fleetWindowModeStateFile defaults beside the fleet config and honors the env override", () => {
    expect(fleetWindowModeStateFile({} as NodeJS.ProcessEnv)).toMatch(/\.amico\/ops\/fleet\/window-mode\.json$/);
    expect(
      fleetWindowModeStateFile({ AMICO_FLEET_WINDOW_MODE_STATE: "/tmp/wm.json" } as NodeJS.ProcessEnv),
    ).toBe("/tmp/wm.json");
  });

  it("the window-mode file is DISTINCT from the posture-state file (own field, own file)", () => {
    expect(fleetWindowModeStateFile({} as NodeJS.ProcessEnv)).not.toMatch(/posture-state\.json$/);
  });

  it("a transition write lands parseable JSON on disk (mkdir -p, atomic)", () => {
    const dir = mkdtempSync(join(tmpdir(), "window-mode-"));
    const file = join(dir, "nested", "window-mode.json");
    try {
      const writer = new WindowModeStateWriter({ file, now });
      const r = writer.record({ hostname: "macbook", window_mode: "remote-ssh", remote_name: "ssh-remote+hub" });
      expect(r.wrote).toBe(true);
      expect(existsSync(file)).toBe(true);
      const onDisk = JSON.parse(readFileSync(file, "utf8")) as WindowModeStateFile;
      expect(onDisk.hostname).toBe("macbook");
      expect(onDisk.window_mode).toBe("remote-ssh");
      expect(onDisk.remote_name).toBe("ssh-remote+hub");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a write failure is swallowed (never throws) — a dead disk must not crash the attach loop", () => {
    const writer = new WindowModeStateWriter({
      now,
      writeFile: () => {
        throw new Error("EROFS: read-only file system");
      },
    });
    expect(() => writer.record({ hostname: "macbook", window_mode: "remote-ssh", remote_name: null })).not.toThrow();
    expect(writer.record({ hostname: "macbook", window_mode: "remote-ssh", remote_name: null }).wrote).toBe(false);
  });
});

// ── AC2 + AC4: cross-writer INDEPENDENCE (the crux) ──────────────────────────
// The whole reason for a separate writer/signature: a window-mode-only
// transition (the mode flips while hub reachability is unchanged) must be
// WRITTEN — not swallowed by the link-health posture signature. And the
// link-health posture writer's transition-only contract must be UNTOUCHED by
// window-mode changes.

describe("window mode vs link-health posture — separate writers, separate signatures", () => {
  const postureFacts = (over: Partial<PostureFacts> = {}): PostureFacts => ({
    hostname: "macbook",
    mode: "fleet",
    hub: { name: "amicissimo-hub", base_url: "http://127.0.0.1:4096" },
    reachable: true,
    last_ok: FIXED_NOW,
    last_rtt_ms: 12,
    ...over,
  });

  it("AC2: a window-mode-only transition IS written even when the posture facts are UNCHANGED", () => {
    const wmWrites: WindowModeStateFile[] = [];
    const postureWrites: FleetPostureStateFile[] = [];
    const wm = new WindowModeStateWriter({ now, writeFile: (_f, t) => wmWrites.push(JSON.parse(t)) });
    const posture = new FleetPostureStateWriter({ now, writeFile: (_f, t) => postureWrites.push(JSON.parse(t)) });

    // Steady state: attached (fleet) + local window.
    posture.record(postureFacts());
    wm.record({ hostname: "macbook", window_mode: "local", remote_name: null });
    expect(postureWrites.length).toBe(1);
    expect(wmWrites.length).toBe(1);

    // The user re-opens the SAME workspace over Remote-SSH: window mode flips
    // local → remote-ssh, but hub reachability is UNCHANGED (still fleet).
    const postureAfter = posture.record(postureFacts()); // identical posture facts
    const wmAfter = wm.record({ hostname: "macbook", window_mode: "remote-ssh", remote_name: "ssh-remote+hub" });

    // The posture signature never moved → posture writes NOTHING (would swallow it)…
    expect(postureAfter.wrote).toBe(false);
    expect(postureWrites.length).toBe(1);
    // …but the window-mode writer's OWN signature moved → the transition IS written.
    expect(wmAfter.wrote).toBe(true);
    expect(wmWrites.length).toBe(2);
    expect(wmWrites[1].window_mode).toBe("remote-ssh");
  });

  it("AC4: a window-mode change never perturbs the link-health posture writer (contract untouched)", () => {
    const postureWrites: FleetPostureStateFile[] = [];
    const posture = new FleetPostureStateWriter({ now, writeFile: (_f, t) => postureWrites.push(JSON.parse(t)) });
    const wm = new WindowModeStateWriter({ now, writeFile: () => {} });

    posture.record(postureFacts()); // 1 posture write (the attach)
    // Flip window mode back and forth — the posture writer is a different object
    // with a different signature; it must not write on any of these.
    wm.record({ hostname: "macbook", window_mode: "local", remote_name: null });
    wm.record({ hostname: "macbook", window_mode: "remote-ssh", remote_name: "ssh-remote+hub" });
    wm.record({ hostname: "macbook", window_mode: "local", remote_name: null });
    // Only a genuine posture transition writes posture:
    expect(posture.record(postureFacts()).wrote).toBe(false); // unchanged posture → no write
    expect(posture.record(postureFacts({ mode: "standalone", reachable: false })).wrote).toBe(true); // real posture transition
    expect(postureWrites.map((w) => w.mode)).toEqual(["fleet", "standalone"]);
  });
});
