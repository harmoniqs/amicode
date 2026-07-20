// #161 — the behavioral packaging gate (scripts/assert_packaged_cli.mjs).
// The gate enumerates the CLI package's DECLARED bins (packages/amico-run
// package.json `bin` map) and asserts, per staged bin, on BEHAVIOR:
//   (a) a remote-executor invocation does not die with the unknown-executor
//       rejection (the stale-bundle signature — asserted on failure MODE, not
//       success: the probe runs hermetically, no cloud, no network);
//   (b) the usage text lists `remote`;
//   (c) a declared-but-missing staged bin is a hard failure — absence and
//       staleness both red.
// The mutation direction is proven here with stub bins: a stale bundle, a
// missing bundle, and an impossible hermetic success all red the gate.
import { describe, it, expect } from "vitest";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { declaredBins, PROBES, runGate } from "../scripts/assert_packaged_cli.mjs";

const REAL_BIN_MAP = join(__dirname, "..", "..", "amico-run", "package.json");
const REAL_BIN_DIR = join(__dirname, "..", "bin");

// ── fixture helpers ─────────────────────────────────────────────────────────

interface StubSpec {
  /** bash body handling the probe argv; $@ is the invocation. */
  body: string;
}

/** A fresh (post-remote-merge) amico-run/amico stub: --help lists remote,
 *  a remote invocation fails config-class (script not found), never the
 *  unknown-executor rejection. */
const FRESH_LAUNCH = `
if [ "$1" = "--help" ] || { [ "$1" = "run" ] && [ "$2" = "--help" ]; }; then
  echo 'usage: amico-run <script.jl> [--executor local|remote] [--lab <id-or-path>]'
  exit 0
fi
echo "amico-run: script not found: $1" >&2
exit 64
`;

/** A STALE (pre-remote-merge) stub: rejects the remote executor and its help
 *  knows only local. */
const STALE_LAUNCH = `
if [ "$1" = "--help" ] || { [ "$1" = "run" ] && [ "$2" = "--help" ]; }; then
  echo 'usage: amico-run <script.jl> [--executor local] [--lab <id-or-path>]'
  exit 0
fi
echo "amico-run: unknown --executor remote (supported: local)" >&2
exit 64
`;

const FRESH_PASQAL = `
if [ "$1" = "--help" ]; then
  echo 'usage: amico-pasqal <connector-script.py> [args...]'
  exit 0
fi
echo "amico-pasqal: no connector script given" >&2
exit 64
`;

/** Stage a fake bin dir + bin map. stubs maps bin name → stub body (or null
 *  to declare the bin without staging it — the absence lane). */
function stageFixture(stubs: Record<string, StubSpec | null>): { binDir: string; binMapPath: string } {
  const root = mkdtempSync(join(tmpdir(), "cli-gate-"));
  const binDir = join(root, "bin");
  mkdirSync(join(binDir, "launcher"), { recursive: true });
  mkdirSync(join(binDir, "dist"), { recursive: true });
  const bin: Record<string, string> = {};
  for (const [name, stub] of Object.entries(stubs)) {
    bin[name] = `./launcher/${name}`;
    if (stub === null) continue;
    const launcher = join(binDir, "launcher", name);
    writeFileSync(launcher, `#!/usr/bin/env bash\n${stub.body}`);
    chmodSync(launcher, 0o755);
    writeFileSync(join(binDir, "dist", `${name}.js`), "// stub bundle\n");
  }
  const binMapPath = join(root, "package.json");
  writeFileSync(binMapPath, JSON.stringify({ name: "@amicode/amico-run", bin }));
  return { binDir, binMapPath };
}

function failing(results: { ok: boolean; bin: string; check: string; detail: string }[]) {
  return results.filter((r) => !r.ok);
}

// ── declared-bin enumeration ────────────────────────────────────────────────

describe("declaredBins", () => {
  it("reads the REAL bin map: amico-run, amico, amico-pasqal all declared", () => {
    const names = declaredBins(REAL_BIN_MAP).map((b) => b.name);
    expect(names).toContain("amico-run");
    expect(names).toContain("amico");
    expect(names).toContain("amico-pasqal");
  });
  it("maps each bin to its staged launcher + dist bundle", () => {
    const run = declaredBins(REAL_BIN_MAP).find((b) => b.name === "amico-run")!;
    expect(run.launcher).toBe(join("launcher", "amico-run"));
    expect(run.dist).toBe(join("dist", "amico-run.js"));
  });
  it("an empty/missing bin map is an error, never a vacuous pass", () => {
    const root = mkdtempSync(join(tmpdir(), "cli-gate-empty-"));
    const p = join(root, "package.json");
    writeFileSync(p, JSON.stringify({ name: "x" }));
    expect(() => declaredBins(p)).toThrow(/bin/);
  });
  it("every bin declared in the REAL map has a behavioral probe (fail-closed tripwire)", () => {
    for (const b of declaredBins(REAL_BIN_MAP)) {
      expect(PROBES[b.name], `no probe for declared bin ${b.name} — add one to assert_packaged_cli.mjs`).toBeDefined();
    }
  });
});

// ── gate verdicts on stub bins (the mutation direction) ─────────────────────

describe("runGate", () => {
  it("passes a fresh staged set (remote accepted, usage lists remote, all bins present)", async () => {
    const { binDir, binMapPath } = stageFixture({
      "amico-run": { body: FRESH_LAUNCH },
      amico: { body: FRESH_LAUNCH },
      "amico-pasqal": { body: FRESH_PASQAL },
    });
    const { ok, results } = await runGate({ binDir, binMapPath });
    expect(failing(results)).toEqual([]);
    expect(ok).toBe(true);
  });

  it("REDS on a stale bundle: the unknown-executor rejection is the failure signature", async () => {
    const { binDir, binMapPath } = stageFixture({ "amico-run": { body: STALE_LAUNCH } });
    const { ok, results } = await runGate({ binDir, binMapPath });
    expect(ok).toBe(false);
    const bad = failing(results);
    expect(bad.some((r) => r.check === "accepts remote executor" && /unknown --executor/.test(r.detail))).toBe(true);
    // the stale stub's help also lacks `remote` → the usage check reds too
    expect(bad.some((r) => r.check === "usage lists remote")).toBe(true);
  });

  it("REDS on a declared-but-missing staged bin (absence lane)", async () => {
    const { binDir, binMapPath } = stageFixture({
      "amico-run": { body: FRESH_LAUNCH },
      "amico-pasqal": null, // declared in the map, absent from the staged set
    });
    const { ok, results } = await runGate({ binDir, binMapPath });
    expect(ok).toBe(false);
    expect(failing(results).some((r) => r.bin === "amico-pasqal" && /missing/.test(r.detail))).toBe(true);
  });

  it("REDS on a hermetic success: exit 0 with no cloud config means the probe proved nothing", async () => {
    const { binDir, binMapPath } = stageFixture({
      "amico-run": {
        body: `
if [ "$1" = "--help" ]; then echo 'usage: amico-run <script.jl> [--executor local|remote]'; exit 0; fi
exit 0`,
      },
    });
    const { ok, results } = await runGate({ binDir, binMapPath });
    expect(ok).toBe(false);
    expect(failing(results).some((r) => r.check === "accepts remote executor" && /exit 0/.test(r.detail))).toBe(true);
  });

  it("REDS (fail-closed) on a declared bin the gate has no probe for", async () => {
    const { binDir, binMapPath } = stageFixture({ "amico-new": { body: FRESH_LAUNCH } });
    const { ok, results } = await runGate({ binDir, binMapPath });
    expect(ok).toBe(false);
    expect(failing(results).some((r) => /no behavioral probe/.test(r.detail))).toBe(true);
  });

  it("REDS on a staged launcher whose dist bundle is missing", async () => {
    const { binDir, binMapPath } = stageFixture({ "amico-run": { body: FRESH_LAUNCH } });
    const { rmSync } = await import("node:fs");
    rmSync(join(binDir, "dist", "amico-run.js"));
    const { ok, results } = await runGate({ binDir, binMapPath });
    expect(ok).toBe(false);
    expect(failing(results).some((r) => r.check === "dist bundle staged")).toBe(true);
  });
});

// ── the real staged set (CI runs this after `pnpm -r run build`) ────────────

describe.skipIf(!existsSync(REAL_BIN_DIR))("runGate against the really staged bins", () => {
  it("the freshly staged CLI passes every check for every declared bin", async () => {
    const { ok, results } = await runGate({ binDir: REAL_BIN_DIR, binMapPath: REAL_BIN_MAP });
    expect(failing(results)).toEqual([]);
    expect(ok).toBe(true);
  }, 60_000);
});
