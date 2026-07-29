import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ingestRunDir,
  promoteEligibility,
  AMICODE_ITER_RE,
  parseAmicoNum,
  parsePulseMetaLine,
  parsePulseRecordLine,
  PulseStream,
  SinkDedup,
} from "../src/run_dir_reader"; // pure β.1-contract reader (vscode-free)

function stageRun(opts: {
  status: string;
  exit: number;
  iters: number[];
  fidelity?: number;
  tier?: string;
  agree?: boolean;
}): string {
  const root = mkdtempSync(join(tmpdir(), "runs-"));
  const runId = "r20260615-000000Z-ab12";
  const dir = join(root, runId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "run.toml"),
    `schema_version = "1"\nrun_id = "${runId}"\nscript_path = "/s.jl"\nlab = "default"\nlab_id = "default"\ncreated_at = "2026-06-15T00:00:00Z"\norchestrator_version = "0.1.0"\n[julia]\nbinary = "julia"\n`,
  );
  writeFileSync(
    join(dir, "run.log"),
    opts.iters.map((k) => `AMICODE_ITER iter=${k} f=0.1 inf_pr=1e-8 inf_du=1e-6`).join("\n") + "\n",
  );
  if (opts.fidelity !== undefined)
    writeFileSync(
      join(dir, "result.toml"),
      `schema_version = "1"\nfidelity = ${opts.fidelity}\niterations = ${Math.max(...opts.iters, 0)}\n`,
    );
  // spec C: a --spec launch persists solvespec.json; free tier gates promotion
  if (opts.tier !== undefined)
    writeFileSync(
      join(dir, "solvespec.json"),
      JSON.stringify({ schema_version: "2", script_path: "/s.jl", lab_id: "default", tier: opts.tier }),
    );
  if (opts.agree !== undefined)
    writeFileSync(join(dir, "verification.toml"), `schema_version = "1"\nagree = ${opts.agree}\n`);
  writeFileSync(join(dir, "FINISHED"), `status = "${opts.status}"\nexit_code = ${opts.exit}\n`);
  return dir;
}

const fakeSink = () => ({ iter: vi.fn(), run: vi.fn(), promote: vi.fn(), pulse: vi.fn() });

describe("ingestRunDir — β.1 contract reading (replay)", () => {
  it("completed run: identity from manifest, run.log→iter, FINISHED→completed, promote on F≥0.99", () => {
    const sink = fakeSink();
    ingestRunDir(stageRun({ status: "completed", exit: 0, iters: [1, 7, 142], fidelity: 0.9991 }), sink);
    expect(sink.iter).toHaveBeenCalledWith(expect.objectContaining({ iter: 142 })); // run.log parsed on REPLAY
    expect(sink.run).toHaveBeenCalledWith(expect.objectContaining({ status: "completed", fidelity: 0.9991 }));
    expect(sink.promote).toHaveBeenCalled();
  });
  it("failed run: FINISHED→failed, no promote", () => {
    const sink = fakeSink();
    ingestRunDir(stageRun({ status: "failed", exit: 3, iters: [1], fidelity: 0.4 }), sink);
    expect(sink.run).toHaveBeenCalledWith(expect.objectContaining({ status: "failed" }));
    expect(sink.promote).not.toHaveBeenCalled();
  });
  it("aborted run: FINISHED→aborted, no promote", () => {
    const sink = fakeSink();
    ingestRunDir(stageRun({ status: "aborted", exit: 143, iters: [] }), sink);
    expect(sink.run).toHaveBeenCalledWith(expect.objectContaining({ status: "aborted" }));
    expect(sink.promote).not.toHaveBeenCalled();
  });
  it("completed but F<0.99: no promote", () => {
    const sink = fakeSink();
    ingestRunDir(stageRun({ status: "completed", exit: 0, iters: [1], fidelity: 0.5 }), sink);
    expect(sink.promote).not.toHaveBeenCalled();
  });

  // spec C: rendering stays tier-blind (sink.run always fires); promotion is gated
  describe("free-tier verification gates promotion (spec C)", () => {
    it("(a) no solvespec.json (bare run) → promote fires, unchanged", () => {
      const sink = fakeSink();
      ingestRunDir(stageRun({ status: "completed", exit: 0, iters: [1], fidelity: 0.999 }), sink);
      expect(sink.promote).toHaveBeenCalled();
    });
    it("(b) tier=free, no verification.toml → NO promote, but run STILL rendered (tier-blind)", () => {
      const sink = fakeSink();
      ingestRunDir(stageRun({ status: "completed", exit: 0, iters: [1], fidelity: 0.999, tier: "free" }), sink);
      expect(sink.run).toHaveBeenCalled();
      expect(sink.promote).not.toHaveBeenCalled();
    });
    it("(c) tier=free + agree=true → promote", () => {
      const sink = fakeSink();
      ingestRunDir(
        stageRun({ status: "completed", exit: 0, iters: [1], fidelity: 0.999, tier: "free", agree: true }),
        sink,
      );
      expect(sink.promote).toHaveBeenCalled();
    });
    it("(d) tier=free + agree=false → NO promote", () => {
      const sink = fakeSink();
      ingestRunDir(
        stageRun({ status: "completed", exit: 0, iters: [1], fidelity: 0.999, tier: "free", agree: false }),
        sink,
      );
      expect(sink.promote).not.toHaveBeenCalled();
    });
    it("(e) tier=vetted, no verification → promote (only free is gated)", () => {
      const sink = fakeSink();
      ingestRunDir(stageRun({ status: "completed", exit: 0, iters: [1], fidelity: 0.999, tier: "vetted" }), sink);
      expect(sink.promote).toHaveBeenCalled();
    });
    it("promoteEligibility: eligible / pending_verification / suppressed / eligible-when-agree", () => {
      expect(promoteEligibility(stageRun({ status: "completed", exit: 0, iters: [1], fidelity: 0.999 }))).toBe(
        "eligible",
      );
      expect(
        promoteEligibility(stageRun({ status: "completed", exit: 0, iters: [1], fidelity: 0.999, tier: "free" })),
      ).toBe("pending_verification");
      expect(
        promoteEligibility(
          stageRun({ status: "completed", exit: 0, iters: [1], fidelity: 0.999, tier: "free", agree: false }),
        ),
      ).toBe("suppressed");
      expect(
        promoteEligibility(
          stageRun({ status: "completed", exit: 0, iters: [1], fidelity: 0.999, tier: "free", agree: true }),
        ),
      ).toBe("eligible");
    });
  });
  it("returns the run.log byte offset (so the live tailer attaches without skipping iters)", () => {
    const sink = fakeSink();
    const bytes = ingestRunDir(stageRun({ status: "completed", exit: 0, iters: [1, 2], fidelity: 0.999 }), sink);
    expect(bytes).toBeGreaterThan(0); // = byte length of run.log consumed during replay
  });

  it("pulse lines on replay: forwards the meta plus ONLY the newest record (no history burst at the webview)", () => {
    const sink = fakeSink();
    const dir = stageRun({ status: "completed", exit: 0, iters: [1, 2, 3], fidelity: 0.999 });
    writeFileSync(
      join(dir, "run.log"),
      'AMICODE_PULSE_META drives=1 knots=2 labels="u_1" bounds=-0.2:0.2\n' +
        "AMICODE_PULSE iter=1 dt=0.2 a=0.1,0.2\n" +
        "AMICODE_ITER iter=1 f=0.1 inf_pr=1e-8 inf_du=1e-6\n" +
        "AMICODE_PULSE iter=2 dt=0.2 a=0.3,0.4\n" +
        "AMICODE_PULSE iter=3 dt=0.2 a=0.5,0.6\n",
    );
    ingestRunDir(dir, sink);
    expect(sink.pulse).toHaveBeenCalledTimes(2);
    expect(sink.pulse).toHaveBeenNthCalledWith(1, expect.objectContaining({ type: "meta" }));
    expect(sink.pulse).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ type: "record", record: expect.objectContaining({ iter: 3 }) }),
    );
  });

  it("pulse-less run.log: sink.pulse never fires (runs render exactly as today)", () => {
    const sink = fakeSink();
    ingestRunDir(stageRun({ status: "completed", exit: 0, iters: [1], fidelity: 0.999 }), sink);
    expect(sink.pulse).not.toHaveBeenCalled();
  });
});

describe("AMICODE_ITER parsing — Inf/NaN are kept, not dropped", () => {
  it("matches blow-up / stagnation iters (Inf, -Inf, NaN), matching amico-run", () => {
    expect(AMICODE_ITER_RE.test("AMICODE_ITER iter=3 f=Inf inf_pr=NaN inf_du=-Inf")).toBe(true);
    expect(AMICODE_ITER_RE.test("AMICODE_ITER iter=4 f=1.2e-03 inf_pr=5e-9 inf_du=2.3")).toBe(true);
  });
  it("parseAmicoNum maps Julia Inf/NaN to JS values", () => {
    expect(parseAmicoNum("Inf")).toBe(Infinity);
    expect(parseAmicoNum("-Inf")).toBe(-Infinity);
    expect(Number.isNaN(parseAmicoNum("NaN"))).toBe(true);
    expect(parseAmicoNum("1.5e-3")).toBeCloseTo(0.0015);
  });
});

// Pulse-line grammar (#66) — the candidate GA format for client-side pulse
// rendering. Additive to the run.log stdout tee: consumers that don't know
// these lines ignore them (anchored regex no-match), so the β contract freeze
// is untouched.
describe("AMICODE_PULSE_META parsing (#66 pinned grammar)", () => {
  it("parses drives/knots/labels/bounds from a well-formed meta line (no interp= → zoh)", () => {
    const m = parsePulseMetaLine('AMICODE_PULSE_META drives=2 knots=50 labels="u_1","u_2" bounds=-0.2:0.2,-0.2:0.2');
    expect(m).toEqual({
      drives: 2,
      knots: 50,
      labels: ["u_1", "u_2"],
      bounds: [
        [-0.2, 0.2],
        [-0.2, 0.2],
      ],
      interp: "zoh",
    });
  });

  // interp= is a trailing optional field so the fork's tail-capture mirror
  // (problems.ts labels=([^\n]*)$) keeps matching lines that carry it.
  it("parses a trailing interp= field", () => {
    const linear = parsePulseMetaLine('AMICODE_PULSE_META drives=1 knots=3 labels="u_1" bounds=-0.2:0.2 interp=linear');
    expect(linear?.interp).toBe("linear");
    const cubic = parsePulseMetaLine('AMICODE_PULSE_META drives=1 knots=3 labels="u_1" bounds=-0.2:0.2 interp=cubic');
    expect(cubic?.interp).toBe("cubic");
    const zoh = parsePulseMetaLine('AMICODE_PULSE_META drives=1 knots=3 labels="u_1" bounds=-0.2:0.2 interp=zoh');
    expect(zoh?.interp).toBe("zoh");
  });

  it("coerces an unknown interp= value to zoh WITHOUT dropping the meta (degrade to stairs, never to NO_DATA)", () => {
    const m = parsePulseMetaLine('AMICODE_PULSE_META drives=1 knots=3 labels="u_1" bounds=-0.2:0.2 interp=bspline');
    expect(m).toBeDefined();
    expect(m?.interp).toBe("zoh");
  });
});

describe("AMICODE_PULSE record parsing (#66 pinned grammar)", () => {
  it("parses iter/dt and per-drive value lists (drives ;-separated, values ,-separated)", () => {
    const r = parsePulseRecordLine("AMICODE_PULSE iter=6 dt=0.204082 a=0.021,-0.013,1.2e-3;0.008,0.031,-4e-2");
    expect(r).toEqual({
      iter: 6,
      dt: 0.204082,
      values: [
        [0.021, -0.013, 0.0012],
        [0.008, 0.031, -0.04],
      ],
    });
  });
  it("keeps Inf/NaN values, matching the stats parser", () => {
    const r = parsePulseRecordLine("AMICODE_PULSE iter=3 dt=0.2 a=Inf,-Inf;NaN,0.5");
    expect(r!.values[0]).toEqual([Infinity, -Infinity]);
    expect(Number.isNaN(r!.values[1][0])).toBe(true);
    expect(r!.values[1][1]).toBe(0.5);
  });
});

// PulseStream — the cross-line policy both delivery paths (replay ingest, live
// tail) feed lines through. Policy per #66 AC4: records before any meta are
// dropped; the last meta wins and resets state; count-mismatched records and
// internally-inconsistent metas are ignored.
describe("PulseStream — cross-line policy (#66)", () => {
  const META = 'AMICODE_PULSE_META drives=2 knots=3 labels="u_1","u_2" bounds=-0.2:0.2,-0.2:0.2';
  const REC = "AMICODE_PULSE iter=6 dt=0.2 a=0.1,0.2,0.3;0.4,0.5,0.6";

  it("drops records that arrive before any meta", () => {
    const ps = new PulseStream();
    expect(ps.onLine(REC)).toBeUndefined();
    expect(ps.onLine(META)).toMatchObject({ type: "meta" });
    expect(ps.onLine(REC)).toMatchObject({ type: "record", record: { iter: 6 } });
  });

  it("ignores records whose drive count or knot count disagree with the current meta", () => {
    const ps = new PulseStream();
    ps.onLine(META); // drives=2 knots=3
    expect(ps.onLine("AMICODE_PULSE iter=1 dt=0.2 a=0.1,0.2,0.3")).toBeUndefined(); // 1 drive ≠ 2
    expect(ps.onLine("AMICODE_PULSE iter=2 dt=0.2 a=0.1,0.2;0.3,0.4")).toBeUndefined(); // 2 knots ≠ 3
    expect(ps.onLine(REC)).toMatchObject({ type: "record" }); // conformant still flows
  });

  it("treats a meta whose label or bounds count disagrees with drives= as malformed (no state change)", () => {
    const ps = new PulseStream();
    expect(ps.onLine('AMICODE_PULSE_META drives=2 knots=3 labels="u_1" bounds=-0.2:0.2,-0.2:0.2')).toBeUndefined(); // 1 label ≠ 2 drives
    expect(ps.onLine('AMICODE_PULSE_META drives=2 knots=3 labels="u_1","u_2" bounds=-0.2:0.2')).toBeUndefined(); // 1 bound ≠ 2 drives
    expect(ps.onLine(REC)).toBeUndefined(); // bad metas did NOT arm the stream
  });

  it("last meta wins: a re-read meta (tailer truncation re-read) re-arms cleanly and its shape governs", () => {
    const ps = new PulseStream();
    ps.onLine(META);
    ps.onLine(REC);
    // duplicate meta (offset-0 re-read) — same shape, still fine
    expect(ps.onLine(META)).toMatchObject({ type: "meta" });
    expect(ps.onLine(REC)).toMatchObject({ type: "record" });
    // a NEW meta with a different shape governs subsequent records
    expect(ps.onLine('AMICODE_PULSE_META drives=1 knots=2 labels="u_1" bounds=-0.1:0.1')).toMatchObject({
      type: "meta",
    });
    expect(ps.onLine(REC)).toBeUndefined(); // old-shape record now ignored
    expect(ps.onLine("AMICODE_PULSE iter=9 dt=0.2 a=0.1,0.2")).toMatchObject({ type: "record", record: { iter: 9 } });
  });
});

// SinkDedup — the live sink's iteration high-water mark (status bar / completion).
describe("SinkDedup — iteration high-water mark", () => {
  it("high() tracks the max iter seen; out-of-order notes never regress it", () => {
    const d = new SinkDedup();
    expect(d.high).toBe(-1);
    d.noteIter(42);
    expect(d.high).toBe(42);
    d.noteIter(7);
    expect(d.high).toBe(42);
    d.noteIter(60);
    expect(d.high).toBe(60);
  });
});
