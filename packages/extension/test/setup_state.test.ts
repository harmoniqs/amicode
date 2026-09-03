// Tests for the setup-state handoff (agent-driven tool setup): the extension
// writes ~/.amico/amicode/setup-state.json (src/setup_state.ts) and the
// amicode_context plugin renders a `## Setup state` section from it
// (opencode-plugin/setup_state.ts) — ONLY when something needs attention.
//
// Both modules are dependency-free; the tests are hermetic via the
// AMICODE_OPS_DIR env seam + a temp dir. The extension-side compute path is
// NOT exercised here (its julia probes shell out to the real toolchain —
// machine-dependent); the writer + reader + rendering contract is.
import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { writeSetupStateFile, type SetupState } from "../src/setup_state";
import { buildSetupStateSection } from "../opencode-plugin/setup_state";

const ENV_KEY = "AMICODE_OPS_DIR";
const savedEnv = process.env[ENV_KEY];
let tmp: string | undefined;

function mkTmp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "amicode-setup-state-"));
  process.env[ENV_KEY] = dir;
  tmp = dir;
  return dir;
}

afterEach(() => {
  if (savedEnv === undefined) delete process.env[ENV_KEY];
  else process.env[ENV_KEY] = savedEnv;
  if (tmp) {
    fs.rmSync(tmp, { recursive: true, force: true });
    tmp = undefined;
  }
});

function readyState(): SetupState {
  return {
    at: new Date().toISOString(),
    julia: {
      ready: true,
      juliaupPresent: true,
      channelPresent: true,
      projectInstantiated: true,
      channel: "1.12",
    },
    labToml: { state: "valid", path: "/tmp/lab.toml" },
  };
}

function notReadyState(): SetupState {
  return {
    ...readyState(),
    julia: {
      ready: false,
      juliaupPresent: true,
      channelPresent: false,
      projectInstantiated: false,
      channel: "1.12",
    },
  };
}

describe("setup state handoff", () => {
  it("writes the snapshot to <opsDir>/setup-state.json", () => {
    const dir = mkTmp();
    writeSetupStateFile(readyState(), dir);
    const raw = JSON.parse(fs.readFileSync(path.join(dir, "setup-state.json"), "utf8")) as SetupState;
    expect(raw.julia.ready).toBe(true);
    expect(raw.labToml.state).toBe("valid");
  });

  it("renders NO section when everything is ready (on-block only)", () => {
    mkTmp();
    writeSetupStateFile(readyState());
    expect(buildSetupStateSection()).toBeNull();
  });

  it("renders NO section when there is no snapshot (fresh install)", () => {
    mkTmp();
    expect(buildSetupStateSection()).toBeNull();
  });

  it("renders the Julia section with the missing pieces named", () => {
    mkTmp();
    writeSetupStateFile(notReadyState());
    const section = buildSetupStateSection() ?? "";
    expect(section).toContain("## Setup state");
    expect(section).toContain("channel 1.12 not installed");
    expect(section).toContain("Piccolo project not instantiated");
    expect(section).not.toContain("juliaup not installed");
    expect(section).toContain("Amicode: Set up Julia");
  });

  it("renders an invalid lab.toml with the first error + count", () => {
    mkTmp();
    const state = readyState();
    state.labToml = { state: "invalid", path: "/tmp/lab.toml", firstError: "qubits: expected number", errorCount: 3 };
    writeSetupStateFile(state);
    const section = buildSetupStateSection() ?? "";
    expect(section).toContain("lab.toml: INVALID");
    expect(section).toContain("qubits: expected number");
    expect(section).toContain("(+2 more)");
  });

  it("omits the stale-snapshot age when the timestamp is unparseable", () => {
    mkTmp();
    const state = notReadyState();
    state.at = "not-a-date";
    writeSetupStateFile(state);
    const section = buildSetupStateSection() ?? "";
    expect(section).toContain("## Setup state\n");
    expect(section).not.toContain("snapshot");
  });
});
