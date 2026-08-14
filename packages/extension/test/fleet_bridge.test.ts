import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  buildFleetStateSnapshot,
  parseFleetAction,
  enqueueFleetSignal,
  FLEET_BRIDGE_KINDS,
  type FleetAction,
} from "../src/fleet_bridge";

describe("buildFleetStateSnapshot", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-bridge-"));
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("builds snapshot from TOML records", () => {
    fs.writeFileSync(
      path.join(tmp, "ses_abc.toml"),
      `state = "running"\ntokens = 42\nhost = "my-server"\ncurrent_step = "solving CZ gate"\nname = "researcher-opus"\n`,
    );
    const snapshot = buildFleetStateSnapshot(tmp);
    expect(snapshot.type).toBe("fleet-state");
    expect(snapshot.payload.sessions).toHaveLength(1);
    expect(snapshot.payload.sessions[0].session_id).toBe("ses_abc");
    expect(snapshot.payload.sessions[0].state).toBe("running");
    expect(snapshot.payload.sessions[0].tokens).toBe(42);
    expect(snapshot.payload.sessions[0].host).toBe("my-server");
    expect(snapshot.payload.sessions[0].current_step).toBe("solving CZ gate");
    expect(snapshot.payload.sessions[0].profile_name).toBe("researcher-opus");
  });

  it("returns empty sessions for missing directory", () => {
    const snapshot = buildFleetStateSnapshot("/nonexistent");
    expect(snapshot.payload.sessions).toEqual([]);
  });

  it("skips dot-files", () => {
    fs.writeFileSync(path.join(tmp, ".tmp.toml"), `state = "running"\ntokens = 1\n`);
    const snapshot = buildFleetStateSnapshot(tmp);
    expect(snapshot.payload.sessions).toHaveLength(0);
  });
});

describe("parseFleetAction", () => {
  it("parses a valid fleet-action message", () => {
    const action = parseFleetAction({
      type: "fleet-action",
      verb: "stop",
      session_id: "ses_abc123",
      params: {},
    });
    expect(action).not.toBeNull();
    expect(action!.verb).toBe("stop");
    expect(action!.session_id).toBe("ses_abc123");
  });

  it("accepts all valid verbs", () => {
    for (const verb of ["steer", "stop", "re-tier", "view-details"]) {
      const action = parseFleetAction({ type: "fleet-action", verb, session_id: "ses_x", params: {} });
      expect(action).not.toBeNull();
      expect(action!.verb).toBe(verb);
    }
  });

  it("rejects invalid verb", () => {
    expect(parseFleetAction({ type: "fleet-action", verb: "explode", session_id: "ses_x" })).toBeNull();
  });

  it("rejects missing session_id", () => {
    expect(parseFleetAction({ type: "fleet-action", verb: "stop", session_id: "" })).toBeNull();
  });

  it("rejects wrong type", () => {
    expect(parseFleetAction({ type: "not-fleet", verb: "stop", session_id: "ses_x" })).toBeNull();
  });

  it("rejects non-object", () => {
    expect(parseFleetAction(null)).toBeNull();
    expect(parseFleetAction("string")).toBeNull();
    expect(parseFleetAction(42)).toBeNull();
  });
});

describe("enqueueFleetSignal", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-signal-"));
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("creates a signal file in the session signal directory", () => {
    const action: FleetAction = {
      type: "fleet-action",
      verb: "stop",
      session_id: "ses_abc123",
      params: {},
    };
    const signalPath = enqueueFleetSignal(action, tmp);
    expect(fs.existsSync(signalPath)).toBe(true);
    expect(signalPath).toContain("ses_abc123.signal.d");
    expect(signalPath).toContain("stop-");
    const content = JSON.parse(fs.readFileSync(signalPath, "utf8"));
    expect(content.verb).toBe("stop");
    expect(content.ts).toBeTruthy();
  });

  it("creates the signal directory if absent", () => {
    const action: FleetAction = {
      type: "fleet-action",
      verb: "steer",
      session_id: "ses_new",
      params: { instruction: "focus on fidelity" },
    };
    enqueueFleetSignal(action, tmp);
    expect(fs.existsSync(path.join(tmp, "ses_new.signal.d"))).toBe(true);
  });
});

describe("FLEET_BRIDGE_KINDS", () => {
  it("declares inbound and outbound message types", () => {
    expect(FLEET_BRIDGE_KINDS.inbound).toBe("fleet-state");
    expect(FLEET_BRIDGE_KINDS.outbound).toBe("fleet-action");
  });
});
