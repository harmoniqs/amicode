import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gateSlowSuite } from "../slow_gate";

// #2180: the vetted pulse-designer template refuses to run on a stack older
// than the one it was vetted against. Run the template's OWN header (imports +
// version probe, everything above the FILL IN block) against the supplied Julia
// project, so a stale shipped environment fails here instead of on a beta
// user's first solve. The template itself is read, never edited.
const PROJECT = process.env.AMICO_TEST_JULIA_PROJECT;
const JULIA = process.env.AMICO_TEST_JULIA_BIN ?? "julia";
const TEMPLATE = join(__dirname, "..", "..", "scores", "pulse-designer", "templates", "solve.jl");
const FILL_IN = /^# ── FILL IN/m;

const GATE = gateSlowSuite("slow: pulse-designer version probe", ["AMICO_TEST_JULIA_PROJECT"]);

describe.skipIf(!GATE.run)("slow: pulse-designer template version probe (#2180)", () => {
  it("passes on the supplied Julia project", () => {
    const src = readFileSync(TEMPLATE, "utf8");
    const cut = src.search(FILL_IN);
    expect(cut, "FILL IN anchor missing from the template").toBeGreaterThan(0);
    const dir = mkdtempSync(join(tmpdir(), "pd-probe-"));
    const script = join(dir, "probe.jl");
    writeFileSync(
      script,
      src.slice(0, cut) + '\nprintln("AMICODE_PROBE_OK piccolo=", pkgversion(Piccolo))\n',
    );
    const out = execFileSync(JULIA, ["--startup-file=no", `--project=${PROJECT}`, script], {
      encoding: "utf8",
      timeout: 600_000,
    });
    // The probe `error()`s (non-zero exit, execFileSync throws) on an older stack.
    expect(out).toMatch(/AMICODE_PROBE_OK piccolo=/);
  }, 600_000);
});
