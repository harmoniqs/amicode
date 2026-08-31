// SEAM 1 (amicode #680) — the MockSoc rehearsal behind the hardware stage.
//
// The rehearsal's TS side, three layers:
//   1. rehearsal.ts (opencode-plugin) — reads + validates the rehearsal.toml
//      artifact the Julia script writes (fixtures here mirror that format; the
//      slow E2E test drives the REAL script and closes the loop).
//   2. entities.ts — the additive [device_session.rehearsal] record (sim PINNED
//      true by the serializer — a rehearsal can never claim to be hardware)
//      + the outcome gate (rehearsalSatisfiesStage).
//   3. the import-surface scan (test/mocksoc_imports.test.ts — sibling file).
//
// Outcome-gating is the AC: `rehearsal_outcome == success` satisfies the
// hardware stage; a FAILED rehearsal is surfaced distinctly and does NOT
// satisfy it — the stage stays an honest stub until a rehearsal passes.
import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "smol-toml";
import {
  readRehearsalRecord,
  type ReadRehearsal,
} from "../opencode-plugin/rehearsal";
import {
  deviceSessionStubToml,
  rehearsalSatisfiesStage,
  type DeviceSessionStub,
} from "../opencode-plugin/entities";

const FIXTURES = join(__dirname, "fixtures", "mocksoc");
const SUCCESS = join(FIXTURES, "rehearsal-success.toml");
const FAILED = join(FIXTURES, "rehearsal-failed.toml");

function readOk(ref: ReadRehearsal) {
  if (!ref.ok) throw new Error(`expected ok, got: ${ref.problem}`);
  return ref.record;
}

describe("readRehearsalRecord — the artifact the Julia rehearsal writes", () => {
  it("parses a success artifact into the record (outcome, pulse content-hash, mismatch, step outcome)", () => {
    const rec = readOk(readRehearsalRecord(SUCCESS));
    expect(rec.kind).toBe("mocksoc");
    expect(rec.outcome).toBe("success");
    expect(rec.pulse_hash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(rec.mismatch).toBe("delta × 1.05 (mock truth vs nominal model)");
    expect(rec.step_outcome).toMatch(/IdentityStrategy step/);
    expect(rec.recorded).toBe("2026-08-31T21:28:34Z");
    // AC: the artifact is honestly labeled sim — a non-sim artifact is refused
    expect(readRehearsalRecord(SUCCESS).ok).toBe(true);
  });

  it("parses a failed artifact distinctly (outcome=failed + the error), and it does NOT satisfy the stage", () => {
    const rec = readOk(readRehearsalRecord(FAILED));
    expect(rec.outcome).toBe("failed");
    expect(rec.error).toMatch(/EOFError/);
    expect(rec.step_outcome).toBeUndefined();
    expect(rehearsalSatisfiesStage(rec)).toBe(false); // the honest-stub gate
  });

  it("a success artifact satisfies the stage gate", () => {
    expect(rehearsalSatisfiesStage(readOk(readRehearsalRecord(SUCCESS)))).toBe(true);
  });

  it("refuses a missing artifact honestly", () => {
    const r = readRehearsalRecord(join(FIXTURES, "not-there.toml"));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.problem).toMatch(/not-there|exist|found/i);
  });

  it("refuses malformed TOML with the parse problem, not a crash", () => {
    const dir = mkdtempSync(join(tmpdir(), "rehearsal-"));
    const f = join(dir, "bad.toml");
    writeFileSync(f, "this is [ not toml");
    const r = readRehearsalRecord(f);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.problem).toMatch(/parse/i);
    rmSync(dir, { recursive: true });
  });

  it("refuses an artifact with no [rehearsal] table", () => {
    const dir = mkdtempSync(join(tmpdir(), "rehearsal-"));
    const f = join(dir, "empty.toml");
    writeFileSync(f, 'schema_version = "1"\n');
    const r = readRehearsalRecord(f);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.problem).toMatch(/rehearsal/i);
    rmSync(dir, { recursive: true });
  });

  it("refuses an artifact that claims sim=false — the sim label is part of the trust chain, not a disclaimer", () => {
    const dir = mkdtempSync(join(tmpdir(), "rehearsal-"));
    const f = join(dir, "nonsim.toml");
    writeFileSync(f, readFileSync(SUCCESS, "utf8").replace("sim = true", "sim = false"));
    const r = readRehearsalRecord(f);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.problem).toMatch(/sim/i);
    rmSync(dir, { recursive: true });
  });

  it("refuses an unknown outcome (success/failed are the whole vocabulary)", () => {
    const dir = mkdtempSync(join(tmpdir(), "rehearsal-"));
    const f = join(dir, "typo.toml");
    writeFileSync(f, readFileSync(SUCCESS, "utf8").replace('outcome = "success"', 'outcome = "pass"'));
    const r = readRehearsalRecord(f);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.problem).toMatch(/outcome/i);
    rmSync(dir, { recursive: true });
  });

  it("refuses an unknown transport kind — only the Strumento MockSoc path is a rehearsal", () => {
    const dir = mkdtempSync(join(tmpdir(), "rehearsal-"));
    const f = join(dir, "kind.toml");
    writeFileSync(f, readFileSync(SUCCESS, "utf8").replace('kind = "mocksoc"', 'kind = "custom-sim"'));
    const r = readRehearsalRecord(f);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.problem).toMatch(/kind|mocksoc/i);
    rmSync(dir, { recursive: true });
  });

  it("refuses a success artifact without the step outcome — success must have PROVEN the strategy step", () => {
    const dir = mkdtempSync(join(tmpdir(), "rehearsal-"));
    const f = join(dir, "nostep.toml");
    writeFileSync(f, readFileSync(SUCCESS, "utf8").replace(/^step_outcome = .*\n/m, ""));
    const r = readRehearsalRecord(f);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.problem).toMatch(/step_outcome/i);
    rmSync(dir, { recursive: true });
  });

  it("refuses an artifact without the pulse content-hash or the mismatch declaration", () => {
    const dir = mkdtempSync(join(tmpdir(), "rehearsal-"));
    const noHash = join(dir, "nohash.toml");
    writeFileSync(noHash, readFileSync(SUCCESS, "utf8").replace(/^pulse_hash = .*\n/m, ""));
    const r1 = readRehearsalRecord(noHash);
    expect(r1.ok).toBe(false);
    if (!r1.ok) expect(r1.problem).toMatch(/pulse_hash/i);
    const noMismatch = join(dir, "nomismatch.toml");
    writeFileSync(noMismatch, readFileSync(SUCCESS, "utf8").replace(/^mismatch = .*\n/m, ""));
    const r2 = readRehearsalRecord(noMismatch);
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.problem).toMatch(/mismatch/i);
    rmSync(dir, { recursive: true });
  });

  it("refuses a malformed pulse content-hash (not sha256:<64 hex>)", () => {
    const dir = mkdtempSync(join(tmpdir(), "rehearsal-"));
    const f = join(dir, "weirdhash.toml");
    writeFileSync(
      f,
      readFileSync(SUCCESS, "utf8").replace(
        /^pulse_hash = .*$/m,
        'pulse_hash = "hash-of-the-pulse"',
      ),
    );
    const r = readRehearsalRecord(f);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.problem).toMatch(/pulse_hash/i);
    rmSync(dir, { recursive: true });
  });
});

describe("deviceSessionStubToml — the additive rehearsal record in the device session", () => {
  const successRecord = readOk(readRehearsalRecord(SUCCESS));
  const failedRecord = readOk(readRehearsalRecord(FAILED));

  it("round-trips a rehearsal under [device_session.rehearsal], sim PINNED true", () => {
    const doc = parse(
      deviceSessionStubToml({
        pulse_ref: "/runs/r/pulse.jld2",
        rehearsal: successRecord,
      }),
    ) as any;
    const reh = doc.device_session.rehearsal;
    expect(reh).toBeDefined();
    expect(reh.kind).toBe("mocksoc");
    expect(reh.sim).toBe(true); // pinned by the serializer — the record has no sim field to lie with
    expect(reh.outcome).toBe("success");
    expect(reh.pulse_hash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(reh.mismatch).toContain("delta × 1.05");
    expect(reh.step_outcome).toMatch(/IdentityStrategy/);
  });

  it("round-trips a FAILED rehearsal distinctly (outcome + error, no costume of progress)", () => {
    const doc = parse(
      deviceSessionStubToml({ rehearsal: failedRecord }),
    ) as any;
    const reh = doc.device_session.rehearsal;
    expect(reh.outcome).toBe("failed");
    expect(reh.error).toMatch(/EOFError/);
    expect(reh.step_outcome).toBeUndefined();
    expect(reh.sim).toBe(true); // still labeled sim — a failed sim is not a hardware claim either
  });

  it("emits no rehearsal table when the stub carries none (additive, not a reshape)", () => {
    const doc = parse(deviceSessionStubToml({})) as any;
    expect(doc.device_session.rehearsal).toBeUndefined();
    expect(doc.device_session.gate).toBe("pending-human-signoff"); // untouched
    expect(doc.device_session.checks).toHaveLength(4); // untouched
  });

  it("escapes quotes/newlines in the mismatch + step_outcome strings (round-trip exact)", () => {
    const stub: DeviceSessionStub = {
      rehearsal: {
        kind: "mocksoc",
        outcome: "success",
        pulse_hash: "sha256:" + "a".repeat(64),
        mismatch: 'δ "quoted" \\ and\nnewline',
        step_outcome: "step",
      },
    };
    const doc = parse(deviceSessionStubToml(stub)) as any;
    expect(doc.device_session.rehearsal.mismatch).toBe('δ "quoted" \\ and\nnewline');
  });
});
