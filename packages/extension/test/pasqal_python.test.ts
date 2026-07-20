// Pasqal python provisioning: the extension owns the interpreter its validator
// runs under. At activation it provisions a venv from the STAGED
// requirements.txt (hash-gated) and hands the venv python to the server spawn
// via AMICO_PYTHON — the override the fork's validator spawn already honors
// ($AMICO_PYTHON → bare `python3` from the child PATH, which on a fresh
// machine has no pasqal-cloud; that's the "Service unreachable" bug).
// Host-set $AMICO_PYTHON wins outright, matching the $AMICO_PASQAL_VALIDATOR
// override convention.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MSG_NO_PYTHON,
  MSG_PIP_FAILED,
  needsProvision,
  parsePythonVersion,
  pasqalVenvDir,
  provisionPasqalPython,
  requirementsHash,
  venvPython,
} from "../src/pasqal_python";

let savedOps: string | undefined;
beforeEach(() => {
  savedOps = process.env.AMICODE_OPS_DIR;
});
afterEach(() => {
  if (savedOps === undefined) delete process.env.AMICODE_OPS_DIR;
  else process.env.AMICODE_OPS_DIR = savedOps;
});

describe("parsePythonVersion", () => {
  it("accepts >= 3.10, rejects older/garbage — fail-safe not-ok on anything unparseable", () => {
    expect(parsePythonVersion("3.10\n")).toEqual({ ok: true, major: 3, minor: 10 });
    expect(parsePythonVersion("3.12")).toEqual({ ok: true, major: 3, minor: 12 });
    expect(parsePythonVersion("3.9\n")).toEqual({ ok: false });
    expect(parsePythonVersion("2.7")).toEqual({ ok: false });
    expect(parsePythonVersion("")).toEqual({ ok: false });
    expect(parsePythonVersion("Python was not found")).toEqual({ ok: false });
  });
});

/** Simulate #161 staging: put a requirements.txt where stagePasqalConnector would. */
function stageRequirements(opsDir: string, content = "pasqal-cloud==0.23.0\n"): string {
  const dir = join(opsDir, "scripts", "pasqal-connector");
  mkdirSync(dir, { recursive: true });
  const p = join(dir, "requirements.txt");
  writeFileSync(p, content);
  return p;
}

describe("needsProvision", () => {
  it("true on a fresh opsDir; false once the venv python exists with a matching stamp; true again when requirements change", () => {
    const opsDir = mkdtempSync(join(tmpdir(), "pasqal-venv-"));
    stageRequirements(opsDir);
    expect(needsProvision(opsDir)).toBe(true);

    // hand-build what a successful provision leaves behind
    const venv = pasqalVenvDir(opsDir);
    mkdirSync(join(venv, "bin"), { recursive: true });
    writeFileSync(venvPython(venv), "#!stub\n");
    writeFileSync(
      join(venv, ".requirements.sha256"),
      requirementsHash(join(opsDir, "scripts", "pasqal-connector", "requirements.txt")),
    );
    expect(needsProvision(opsDir)).toBe(false);

    stageRequirements(opsDir, "pasqal-cloud==0.24.0\n");
    expect(needsProvision(opsDir)).toBe(true);
  });
});

/** Recording spawn stub: scripted per-call results, argv + env captured. */
function recordingSpawn(script: (bin: string, argv: string[]) => { code: number; stdout: string }) {
  const calls: { bin: string; argv: string[]; env: Record<string, string> }[] = [];
  const spawn = async (bin: string, argv: string[], env: Record<string, string>) => {
    calls.push({ bin, argv, env });
    return script(bin, argv);
  };
  return { calls, spawn };
}

const FRESH = (bin: string, argv: string[]) =>
  argv[0] === "-c" ? { code: 0, stdout: "3.12\n" } : { code: 0, stdout: "" };

describe("provisionPasqalPython", () => {
  it("probes the candidate, creates the venv, pip-installs the staged requirements, stamps, and returns the venv python", async () => {
    const opsDir = mkdtempSync(join(tmpdir(), "pasqal-venv-"));
    const reqPath = stageRequirements(opsDir);
    const rec = recordingSpawn(FRESH);
    const r = await provisionPasqalPython({ opsDir, env: {}, candidates: ["/stub/python3"], spawn: rec.spawn });

    const venv = pasqalVenvDir(opsDir);
    expect(r).toEqual({ ok: true, pythonPath: venvPython(venv), provisioned: true });
    expect(rec.calls.map((c) => [c.bin, c.argv[0]])).toEqual([
      ["/stub/python3", "-c"], // version probe
      ["/stub/python3", "-m"], // venv
      [venvPython(venv), "-m"], // pip, under the venv interpreter
    ]);
    expect(rec.calls[1].argv).toEqual(["-m", "venv", venv]);
    expect(rec.calls[2].argv).toEqual(["-m", "pip", "install", "-r", reqPath]);
    expect(readFileSync(join(venv, ".requirements.sha256"), "utf8").trim()).toBe(requirementsHash(reqPath));
    // no-op on the second call: stamp matches, zero subprocess work
    // (venv python must exist for the fast path — the stub venv didn't create it)
    mkdirSync(join(venv, "bin"), { recursive: true });
    writeFileSync(venvPython(venv), "#!stub\n");
    const rec2 = recordingSpawn(FRESH);
    const r2 = await provisionPasqalPython({ opsDir, env: {}, candidates: ["/stub/python3"], spawn: rec2.spawn });
    expect(r2).toEqual({ ok: true, pythonPath: venvPython(venv), provisioned: false });
    expect(rec2.calls.length).toBe(0);
  });
});

describe("provisionPasqalPython — failure lanes (fail closed, retry for free)", () => {
  it("no suitable python: every candidate rejected → not-ok, remedy names AMICO_PYTHON, no stamp", async () => {
    const opsDir = mkdtempSync(join(tmpdir(), "pasqal-venv-"));
    stageRequirements(opsDir);
    const rec = recordingSpawn((_, argv) =>
      argv[0] === "-c" ? { code: 0, stdout: "3.9\n" } : { code: 0, stdout: "" },
    );
    const r = await provisionPasqalPython({
      opsDir,
      env: {},
      candidates: ["/old/python3", "/older/python3"],
      spawn: rec.spawn,
    });
    expect(r).toEqual({ ok: false, message: MSG_NO_PYTHON });
    expect(rec.calls.length).toBe(2); // both probed, nothing else spawned
    expect(needsProvision(opsDir)).toBe(true); // retries next activation
  });

  it("pip failure: not-ok with the offline-aware remedy, no stamp written → needsProvision stays true", async () => {
    const opsDir = mkdtempSync(join(tmpdir(), "pasqal-venv-"));
    stageRequirements(opsDir);
    const rec = recordingSpawn((bin, argv) => {
      if (argv[0] === "-c") return { code: 0, stdout: "3.12\n" };
      if (argv[1] === "pip") return { code: 1, stdout: "" };
      return { code: 0, stdout: "" };
    });
    const r = await provisionPasqalPython({ opsDir, env: {}, candidates: ["/stub/python3"], spawn: rec.spawn });
    expect(r).toEqual({ ok: false, message: MSG_PIP_FAILED });
    expect(existsSync(join(pasqalVenvDir(opsDir), ".requirements.sha256"))).toBe(false);
    expect(needsProvision(opsDir)).toBe(true);
  });

  it("token safety: child env is exactly { PATH, HOME } — a poison PASQAL_TOKEN in the host env never rides spawns or the message", async () => {
    const opsDir = mkdtempSync(join(tmpdir(), "pasqal-venv-"));
    stageRequirements(opsDir);
    const POISON = "poison-token-8f2a";
    const rec = recordingSpawn(FRESH);
    const r = await provisionPasqalPython({
      opsDir,
      env: { PATH: "/stub", HOME: "/h", PASQAL_TOKEN: POISON, AMICO_CLOUD_URL: "https://x" },
      candidates: ["/stub/python3"],
      spawn: rec.spawn,
    });
    expect(r.ok).toBe(true);
    for (const c of rec.calls) {
      expect(Object.keys(c.env).sort()).toEqual(["HOME", "PATH"]);
      expect(JSON.stringify([c.bin, c.argv])).not.toContain(POISON);
    }
  });
});

describe("provisionPasqalPython — host $AMICO_PYTHON override", () => {
  it("wins outright: no probe, no venv, no pip — the override IS the interpreter (the $AMICO_PASQAL_VALIDATOR precedence convention)", async () => {
    const opsDir = mkdtempSync(join(tmpdir(), "pasqal-venv-"));
    stageRequirements(opsDir);
    const rec = recordingSpawn(FRESH);
    const r = await provisionPasqalPython({
      opsDir,
      env: { AMICO_PYTHON: "/my/python" },
      candidates: ["/stub/python3"],
      spawn: rec.spawn,
    });
    expect(r).toEqual({ ok: true, pythonPath: "/my/python", provisioned: false });
    expect(rec.calls.length).toBe(0);
    // blank override does NOT count (absent-not-empty, like the fork's lF())
    const rec2 = recordingSpawn(FRESH);
    const r2 = await provisionPasqalPython({
      opsDir,
      env: { AMICO_PYTHON: "  " },
      candidates: ["/stub/python3"],
      spawn: rec2.spawn,
    });
    expect(r2.ok).toBe(true);
    expect(rec2.calls.length).toBeGreaterThan(0); // fell through to provisioning
  });
});

// Real-interpreter lane: hermetic (EMPTY requirements → pip does no network),
// skipped where no python3 >= 3.10 exists on the test host's PATH.
import { execFileSync } from "node:child_process";
const hostPython310 = (() => {
  try {
    const out = execFileSync("python3", ["-c", "import sys; print('%d.%d' % sys.version_info[:2])"], {
      timeout: 10_000,
    }).toString();
    return parsePythonVersion(out).ok;
  } catch {
    return false;
  }
})();

describe.skipIf(!hostPython310)("provisionPasqalPython — real interpreter (hermetic, no network)", () => {
  it("provisions a real venv from an empty requirements.txt; the venv python runs; second call is a no-op", async () => {
    const opsDir = mkdtempSync(join(tmpdir(), "pasqal-venv-real-"));
    stageRequirements(opsDir, "# empty on purpose — hermetic\n");
    const r = await provisionPasqalPython({ opsDir, env: { PATH: process.env.PATH, HOME: process.env.HOME } });
    expect(r.ok, JSON.stringify(r)).toBe(true);
    if (!r.ok) return;
    expect(r.provisioned).toBe(true);
    expect(existsSync(r.pythonPath)).toBe(true);
    const probe = execFileSync(r.pythonPath, ["-c", "print('venv-alive')"], { timeout: 10_000 }).toString();
    expect(probe.trim()).toBe("venv-alive");
    const r2 = await provisionPasqalPython({ opsDir, env: { PATH: process.env.PATH, HOME: process.env.HOME } });
    expect(r2).toEqual({ ok: true, pythonPath: r.pythonPath, provisioned: false });
  }, 60_000);
});

describe("pasqalVenvDir", () => {
  it("is <opsDir>/venvs/pasqal-connector, defaulting opsDir to $AMICODE_OPS_DIR", () => {
    expect(pasqalVenvDir("/ops")).toBe(join("/ops", "venvs", "pasqal-connector"));
    const scratch = mkdtempSync(join(tmpdir(), "pasqal-venv-"));
    process.env.AMICODE_OPS_DIR = scratch;
    expect(pasqalVenvDir()).toBe(join(scratch, "venvs", "pasqal-connector"));
    expect(venvPython(pasqalVenvDir())).toBe(join(scratch, "venvs", "pasqal-connector", "bin", "python"));
  });
});
