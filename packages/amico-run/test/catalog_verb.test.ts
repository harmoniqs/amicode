// `amico catalog` (issue #111, slice B2) — the repertoire query + verified-ingest
// verb. Pure logic (repertoire.ts) is unit-tested against src; the query/ingest
// bodies are exercised end-to-end through the `dist/amico.js` bundle with
// $AMICO_CATALOG_DIR pointed at a seeded temp repertoire (mirrors amico.test.ts /
// subcommands.test.ts). Run: `pnpm --filter @amicode/amico-run test`.
import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readToml } from "./helpers.js";
import {
  loadRepertoire,
  queryIncumbent,
  beats,
  nextVersionId,
  comparePulses,
  type PulseRecord,
} from "../src/repertoire.js";

// ── seed helpers ──────────────────────────────────────────────────────────────
/** Write a `<pulses>/<id>/metadata.toml` (+ optional pulse.jld2) entry. */
function seedEntry(
  pulsesDir: string,
  id: string,
  fields: Record<string, string | number | boolean>,
  withPulse = true,
): void {
  const dir = join(pulsesDir, id);
  mkdirSync(dir, { recursive: true });
  const lines = Object.entries({ id, ...fields }).map(([k, v]) => `${k} = ${JSON.stringify(v)}`);
  writeFileSync(join(dir, "metadata.toml"), lines.join("\n") + "\n");
  if (withPulse) writeFileSync(join(dir, "pulse.jld2"), "fake-pulse-binary");
}

let pulses: string;
beforeEach(() => {
  pulses = join(mkdtempSync(join(tmpdir(), "amico-repertoire-")), "pulses");
  mkdirSync(pulses, { recursive: true });
});
afterEach(() => rmSync(join(pulses, ".."), { recursive: true, force: true }));

// ── pure logic (repertoire.ts) ─────────────────────────────────────────────────
describe("repertoire loader", () => {
  it("scans metadata.toml entries; skips dirs without one; never throws on missing root", () => {
    seedEntry(pulses, "transmon-X-v1", { platform: "transmon", gate: "X", fidelity: 0.999 });
    mkdirSync(join(pulses, "not-a-pulse"), { recursive: true }); // no metadata.toml
    expect(loadRepertoire(pulses)).toHaveLength(1);
    expect(loadRepertoire(join(pulses, "does-not-exist"))).toEqual([]);
  });
  it("skips records missing a discriminating field (no fidelity)", () => {
    seedEntry(pulses, "broken-v1", { platform: "transmon", gate: "X" }); // no fidelity
    expect(loadRepertoire(pulses)).toEqual([]);
  });
});

describe("queryIncumbent ranking (amico-catalog Version rule)", () => {
  it("ranks by fidelity desc; incumbent = best match on platform+gate", () => {
    seedEntry(pulses, "transmon-X-v1", { platform: "transmon", gate: "X", fidelity: 0.99 });
    seedEntry(pulses, "transmon-X-v2", { platform: "transmon", gate: "X", fidelity: 0.9999 });
    seedEntry(pulses, "rydberg-CZ-v1", { platform: "rydberg", gate: "CZ", fidelity: 0.9999999 });
    const { incumbent, candidates } = queryIncumbent(loadRepertoire(pulses), "transmon", "X");
    expect(candidates.map((c) => c.id)).toEqual(["transmon-X-v2", "transmon-X-v1"]);
    expect(incumbent?.id).toBe("transmon-X-v2");
  });
  it("fidelity tie → shorter duration wins", () => {
    seedEntry(pulses, "transmon-X-v1", { platform: "transmon", gate: "X", fidelity: 0.9999, duration_us: 0.05 });
    seedEntry(pulses, "transmon-X-v2", { platform: "transmon", gate: "X", fidelity: 0.9999, duration_us: 0.03 });
    expect(queryIncumbent(loadRepertoire(pulses), "transmon", "X").incumbent?.id).toBe("transmon-X-v2");
  });
  it("no match → undefined incumbent, empty candidates", () => {
    seedEntry(pulses, "transmon-X-v1", { platform: "transmon", gate: "X", fidelity: 0.99 });
    const q = queryIncumbent(loadRepertoire(pulses), "fluxonium", "Y");
    expect(q.incumbent).toBeUndefined();
    expect(q.candidates).toEqual([]);
  });
});

describe("beats + nextVersionId", () => {
  const rec = (id: string, f: number, d?: number): PulseRecord => ({
    id,
    platform: "transmon",
    gate: "X",
    fidelity: f,
    duration_us: d,
    dir: "",
  });
  it("beats: no incumbent → true; higher fidelity → true; equal → false", () => {
    expect(beats(rec("c", 0.99), undefined)).toBe(true);
    expect(beats(rec("c", 0.999), rec("i", 0.99))).toBe(true);
    expect(beats(rec("c", 0.99), rec("i", 0.999))).toBe(false);
    expect(beats(rec("c", 0.99), rec("i", 0.99))).toBe(false);
    expect(comparePulses(rec("c", 0.99, 0.03), rec("i", 0.99, 0.05))).toBeGreaterThan(0);
  });
  it("nextVersionId bumps the max existing version; no prior → v1", () => {
    seedEntry(pulses, "transmon-X-v1", { platform: "transmon", gate: "X", fidelity: 0.9 });
    seedEntry(pulses, "transmon-X-v3", { platform: "transmon", gate: "X", fidelity: 0.99 });
    const records = loadRepertoire(pulses);
    expect(nextVersionId(records, "transmon", "X")).toBe("transmon-X-v4");
    expect(nextVersionId(records, "rydberg", "CZ")).toBe("rydberg-CZ-v1");
  });
});

// ── verb bodies through the bundle ──────────────────────────────────────────────
const BUNDLE = join(__dirname, "..", "dist", "amico.js");
beforeAll(() => {
  execFileSync("node", [join(__dirname, "..", "esbuild.config.mjs")], { cwd: join(__dirname, "..") });
});
function run(args: string[], env: Record<string, string> = {}): { code: number; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync("node", [BUNDLE, ...args], { encoding: "utf8", env: { ...process.env, ...env } });
    return { code: 0, stdout, stderr: "" };
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string };
    return { code: err.status ?? -1, stdout: err.stdout ?? "", stderr: err.stderr ?? "" };
  }
}

describe("amico catalog query (bundle)", () => {
  it("returns the incumbent + ranked candidates for platform+gate", () => {
    seedEntry(pulses, "transmon-X-v1", { platform: "transmon", gate: "X", fidelity: 0.99 });
    seedEntry(pulses, "transmon-X-v2", { platform: "transmon", gate: "X", fidelity: 0.9999 });
    const r = run(["catalog", "query", "--platform", "transmon", "--kind", "X"], { AMICO_CATALOG_DIR: pulses });
    expect(r.code).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.count).toBe(2);
    expect(out.incumbent.id).toBe("transmon-X-v2");
    expect(out.incumbent.pulse_path).toMatch(/transmon-X-v2\/pulse\.jld2$/);
    expect(out.candidates.map((c: PulseRecord) => c.id)).toEqual(["transmon-X-v2", "transmon-X-v1"]);
  });
  it("--kind maps onto the repertoire `gate` field (e.g. CZ)", () => {
    seedEntry(pulses, "rydberg-CZ-v1", { platform: "rydberg", gate: "CZ", fidelity: 0.9999999 });
    const r = run(["catalog", "query", "--platform", "rydberg", "--kind", "CZ"], { AMICO_CATALOG_DIR: pulses });
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout).incumbent.id).toBe("rydberg-CZ-v1");
  });
  it("empty catalog → count 0, null incumbent", () => {
    const r = run(["catalog", "query", "--platform", "transmon", "--kind", "X"], { AMICO_CATALOG_DIR: pulses });
    expect(r.code).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.count).toBe(0);
    expect(out.incumbent).toBeNull();
  });
  it("missing --platform/--kind → 64", () => {
    expect(run(["catalog", "query", "--platform", "transmon"], { AMICO_CATALOG_DIR: pulses }).code).toBe(64);
  });
});

describe("amico catalog ingest (bundle) — the promotion gate", () => {
  it("agree=true + beats incumbent → promotes a new versioned entry with lineage", () => {
    seedEntry(pulses, "transmon-X-v1", { platform: "transmon", gate: "X", fidelity: 0.99 });
    const newPulse = join(pulses, "..", "new-pulse.jld2");
    writeFileSync(newPulse, "better-pulse");
    const r = run(
      [
        "catalog", "ingest",
        "--platform", "transmon", "--kind", "X",
        "--artifact", newPulse, "--fidelity", "0.99999",
        "--duration-us", "0.03", "--agree", "true", "--tags", "seed,transmon",
      ],
      { AMICO_CATALOG_DIR: pulses },
    );
    expect(r.code).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out).toMatchObject({ promoted: true, id: "transmon-X-v2", warm_start: "transmon-X-v1" });
    // metadata written + pulse copied
    const meta = readToml(join(pulses, "transmon-X-v2", "metadata.toml"));
    expect(meta.id).toBe("transmon-X-v2");
    expect(meta.fidelity).toBe(0.99999);
    expect(meta.warm_start).toBe("transmon-X-v1");
    expect(meta.path).toBe("pulses/transmon-X-v2/pulse.jld2");
    expect(meta.tags).toEqual(["seed", "transmon"]);
    expect(existsSync(join(pulses, "transmon-X-v2", "pulse.jld2"))).toBe(true);
  });

  it("agree=false → BLOCKED, no write, exit 64", () => {
    const newPulse = join(pulses, "..", "p.jld2");
    writeFileSync(newPulse, "x");
    const r = run(
      ["catalog", "ingest", "--platform", "transmon", "--kind", "X", "--artifact", newPulse, "--fidelity", "0.9999", "--agree", "false"],
      { AMICO_CATALOG_DIR: pulses },
    );
    expect(r.code).toBe(64);
    const out = JSON.parse(r.stdout);
    expect(out).toMatchObject({ promoted: false, blocked: true, agree: false });
    expect(existsSync(join(pulses, "transmon-X-v1"))).toBe(false);
  });

  it("no verification evidence → BLOCKED, exit 64 (agree unknown ≠ true)", () => {
    const newPulse = join(pulses, "..", "p.jld2");
    writeFileSync(newPulse, "x");
    const r = run(
      ["catalog", "ingest", "--platform", "transmon", "--kind", "X", "--artifact", newPulse, "--fidelity", "0.9999"],
      { AMICO_CATALOG_DIR: pulses },
    );
    expect(r.code).toBe(64);
    expect(JSON.parse(r.stdout).blocked).toBe(true);
  });

  it("agree=true but does NOT beat the incumbent → promoted:false, exit 0 (no-op)", () => {
    seedEntry(pulses, "transmon-X-v1", { platform: "transmon", gate: "X", fidelity: 0.99999 });
    const newPulse = join(pulses, "..", "p.jld2");
    writeFileSync(newPulse, "x");
    const r = run(
      ["catalog", "ingest", "--platform", "transmon", "--kind", "X", "--artifact", newPulse, "--fidelity", "0.99", "--agree", "true"],
      { AMICO_CATALOG_DIR: pulses },
    );
    expect(r.code).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.promoted).toBe(false);
    expect(out.reason).toMatch(/does not beat/);
  });

  it("--from-run reads verification.toml (agree) + result.toml (fidelity), defaults the artifact", () => {
    const runDir = mkdtempSync(join(tmpdir(), "amico-run-fromrun-"));
    writeFileSync(join(runDir, "pulse.jld2"), "run-pulse");
    writeFileSync(join(runDir, "result.toml"), `fidelity = 0.999995\nduration_us = 0.04\n`);
    writeFileSync(join(runDir, "verification.toml"), `agree = true\nfidelity_rerolled = 0.999995\n`);
    const r = run(
      ["catalog", "ingest", "--platform", "transmon", "--kind", "X", "--from-run", runDir],
      { AMICO_CATALOG_DIR: pulses },
    );
    expect(r.code).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out).toMatchObject({ promoted: true, id: "transmon-X-v1", fidelity: 0.999995 });
    expect(existsSync(join(pulses, "transmon-X-v1", "pulse.jld2"))).toBe(true);
    rmSync(runDir, { recursive: true, force: true });
  });

  it("--from-run with verification agree=false → BLOCKED even though fidelity is high", () => {
    const runDir = mkdtempSync(join(tmpdir(), "amico-run-fromrun-block-"));
    writeFileSync(join(runDir, "pulse.jld2"), "run-pulse");
    writeFileSync(join(runDir, "result.toml"), `fidelity = 0.999999\n`);
    writeFileSync(join(runDir, "verification.toml"), `agree = false\n`);
    const r = run(
      ["catalog", "ingest", "--platform", "transmon", "--kind", "X", "--from-run", runDir],
      { AMICO_CATALOG_DIR: pulses },
    );
    expect(r.code).toBe(64);
    expect(JSON.parse(r.stdout).blocked).toBe(true);
    expect(existsSync(join(pulses, "transmon-X-v1"))).toBe(false);
    rmSync(runDir, { recursive: true, force: true });
  });

  it("--dry-run computes the decision without writing", () => {
    const newPulse = join(pulses, "..", "p.jld2");
    writeFileSync(newPulse, "x");
    const r = run(
      ["catalog", "ingest", "--platform", "transmon", "--kind", "X", "--artifact", newPulse, "--fidelity", "0.9999", "--agree", "true", "--dry-run"],
      { AMICO_CATALOG_DIR: pulses },
    );
    expect(r.code).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out).toMatchObject({ promoted: false, dry_run: true });
    expect(out.would_write.id).toBe("transmon-X-v1");
    expect(existsSync(join(pulses, "transmon-X-v1"))).toBe(false);
  });

  it("missing pulse artifact → 64", () => {
    const r = run(
      ["catalog", "ingest", "--platform", "transmon", "--kind", "X", "--artifact", join(pulses, "nope.jld2"), "--fidelity", "0.99", "--agree", "true"],
      { AMICO_CATALOG_DIR: pulses },
    );
    expect(r.code).toBe(64);
    expect(JSON.parse(r.stdout).error).toMatch(/not found/);
  });

  // ── SEAM 5 (amicode #681): the chain's provenance rides the catalog note ─────
  // The calibrate→pin→re-optimize chain's re-bank carries its fingerprint —
  // which calibration, which pin, which warm-start seed — as ADDITIVE metadata
  // fields (the note schema's open growth; the existing warm_start field IS the
  // seed). The chain stages this exact command; the recording path (extension
  // side, calib_chain.ts) later VERIFIES the fingerprint against these fields.
  it("--calibration-ref + --pin + --warm-start write the chain's fingerprint (which calibration, which pin, which seed); loadRepertoire reads all three back", () => {
    seedEntry(pulses, "transmon-X-v1", { platform: "transmon", gate: "X", fidelity: 0.98 });
    const newPulse = join(pulses, "..", "chain-pulse.jld2");
    writeFileSync(newPulse, "calibrated-pulse");
    const r = run(
      [
        "catalog", "ingest",
        "--platform", "transmon", "--kind", "X",
        "--artifact", newPulse, "--fidelity", "0.9995",
        "--agree", "true",
        "--warm-start", "transmon-X-v1",
        "--calibration-ref", "/problems/chain/entities/calib_chain.toml",
        "--pin", "delta=0.21",
      ],
      { AMICO_CATALOG_DIR: pulses },
    );
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout).promoted).toBe(true);
    const meta = readToml(join(pulses, "transmon-X-v2", "metadata.toml"));
    expect(meta.warm_start).toBe("transmon-X-v1"); // which seed (the existing lineage field)
    expect(meta.calibration_ref).toBe("/problems/chain/entities/calib_chain.toml"); // which calibration
    expect(meta.pinned_globals).toEqual({ delta: 0.21 }); // which pin
    // round-trip: the repertoire loader surfaces the fingerprint (additive fields)
    const rec = queryIncumbent(loadRepertoire(pulses), "transmon", "X").incumbent;
    expect(rec?.warm_start).toBe("transmon-X-v1");
    expect(rec?.calibration_ref).toBe("/problems/chain/entities/calib_chain.toml");
    expect(rec?.pinned_globals).toEqual({ delta: 0.21 });
  });

  it("--pin parses multi-global comma lists; a malformed pin value is refused honestly (exit 64, no write)", () => {
    const newPulse = join(pulses, "..", "p.jld2");
    writeFileSync(newPulse, "x");
    const r = run(
      [
        "catalog", "ingest",
        "--platform", "transmon", "--kind", "X",
        "--artifact", newPulse, "--fidelity", "0.9999", "--agree", "true",
        "--pin", "delta=0.21,omega=4.9",
      ],
      { AMICO_CATALOG_DIR: pulses },
    );
    expect(r.code).toBe(0);
    expect(readToml(join(pulses, "transmon-X-v1", "metadata.toml")).pinned_globals).toEqual({ delta: 0.21, omega: 4.9 });

    const bad = join(pulses, "..", "p2.jld2");
    writeFileSync(bad, "x");
    const r2 = run(
      [
        "catalog", "ingest",
        "--platform", "transmon", "--kind", "X",
        "--artifact", bad, "--fidelity", "0.99995", "--agree", "true",
        "--id", "transmon-X-v2",
        "--pin", "delta=not-a-number",
      ],
      { AMICO_CATALOG_DIR: pulses },
    );
    expect(r2.code).toBe(64);
    expect(JSON.parse(r2.stdout).error).toMatch(/--pin/);
    expect(existsSync(join(pulses, "transmon-X-v2"))).toBe(false);
  });
});
