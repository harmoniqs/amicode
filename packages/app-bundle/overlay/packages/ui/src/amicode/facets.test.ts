import { describe, it, expect } from "bun:test"
import { compactValue, setDiff, modeBadges, systemReceiptPieces, formulationReceiptPieces, formatSci } from "./facets"

const byKind = (t: { kind: string; label?: string }, i: number) => `${t.kind}:${t.label ?? i}`

describe("formatSci", () => {
  it("renders integer π-multiples as Nπ (drive/detuning bounds)", () => {
    expect(formatSci(125.66370614359172)).toBe("40π") // 40π
    expect(formatSci(62.83185307179586)).toBe("20π") // 20π
    expect(formatSci(Math.PI)).toBe("π")
    expect(formatSci(-Math.PI)).toBe("-π")
  })
  it("trims non-π values to ~4 significant figures", () => {
    expect(formatSci(0.2)).toBe("0.2")
    expect(formatSci(28.9)).toBe("28.9")
    expect(formatSci(0.005)).toBe("0.005")
    expect(formatSci(4.83729)).toBe("4.837")
  })
  it("handles 0 and non-finite defensively", () => {
    expect(formatSci(0)).toBe("0")
    expect(formatSci(NaN)).toBe("NaN")
  })
})

describe("compactValue", () => {
  it("passes scalars through unchanged", () => {
    expect(compactValue("gate")).toBe("gate")
    expect(compactValue(3)).toBe("3")
    expect(compactValue(true)).toBe("true")
  })
  it("renders null/undefined as em-dash", () => {
    expect(compactValue(null)).toBe("—")
    expect(compactValue(undefined)).toBe("—")
  })
  it("summarizes arrays by count + head, never raw JSON", () => {
    const out = compactValue([{ id: "q1" }, { id: "q2" }, { id: "q3" }, { id: "q4" }])
    expect(out).not.toContain("{") // no JSON blob
    expect(out).toContain("4") // count present
    expect(out).toContain("q1") // head label present
  })
  it("summarizes objects compactly, never raw JSON", () => {
    const out = compactValue({ arch: "global", n: 2 })
    expect(out).not.toContain('"') // no JSON quotes
    expect(out).toContain("arch")
  })
})

describe("setDiff", () => {
  it("detects added / removed by unique key", () => {
    const d = setDiff([{ kind: "reg_u" }], [{ kind: "reg_u" }, { kind: "reg_du" }], byKind)
    expect(d.added.map((x) => x.kind)).toEqual(["reg_du"])
    expect(d.removed).toEqual([])
  })
  it("does NOT collide two same-kind terms (label disambiguates)", () => {
    const from = [{ kind: "custom", label: "a" }, { kind: "custom", label: "b" }]
    const to = [{ kind: "custom", label: "a" }]
    const d = setDiff(from, to, byKind)
    expect(d.removed).toEqual([{ kind: "custom", label: "b" }])
    expect(d.added).toEqual([])
  })
  it("reports per-field changes for matched keys", () => {
    const d = setDiff([{ kind: "reg_u", params: { R: 1e-4 } }], [{ kind: "reg_u", params: { R: 1e-5 } }], byKind)
    expect(d.changed).toHaveLength(1)
    expect(d.changed[0].changes[0]).toMatchObject({ field: "params.R", from: 1e-4, to: 1e-5 })
  })
})

describe("modeBadges", () => {
  const full = {
    trajectory_type: "gate",
    time_mode: "min_time",
    parameterization: "cubic_spline",
    robustness: { kind: "ensemble" },
    free_phase: true,
    leakage: false,
  }
  it("emits type / time / param / robustness / flag badges", () => {
    const b = modeBadges(full)
    const has = (pred: (x: { label: string; value: string }) => boolean) => b.some(pred)
    expect(has((x) => x.label === "type" && x.value === "gate")).toBe(true)
    expect(has((x) => /min.?time/.test(x.value + x.label))).toBe(true)
    expect(has((x) => x.value === "ensemble")).toBe(true)
    expect(has((x) => /free.?phase/.test(x.label))).toBe(true)
  })
  it("omits false flags, none-robustness, and fixed time", () => {
    const b = modeBadges({ trajectory_type: "ket", time_mode: "fixed", robustness: { kind: "none" }, free_phase: false, leakage: false })
    expect(b.some((x) => /leakage/.test(x.label))).toBe(false)
    expect(b.some((x) => /robust/.test(x.label))).toBe(false)
    expect(b.some((x) => /min.?time/.test(x.value + x.label))).toBe(false)
  })
})

describe("systemReceiptPieces", () => {
  it("creation (components.from empty) → chip mode with a reconstructed entity", () => {
    const r = systemReceiptPieces({
      platform: { from: null, to: "transmon" },
      components: { from: null, to: [{ id: "q1", role: "qubit", levels: 3 }, { id: "q2", role: "qubit", levels: 3 }] },
      "drive.arch": { from: null, to: "per-component" },
    })
    expect(r.kind).toBe("chip")
    if (r.kind === "chip") {
      expect(Array.isArray(r.entity.components)).toBe(true)
      expect((r.entity.drive as { arch: string }).arch).toBe("per-component")
    }
  })
  it("add-component → a '+ q2' piece", () => {
    const r = systemReceiptPieces({
      components: { from: [{ id: "q1", role: "qubit", levels: 3 }], to: [{ id: "q1", role: "qubit", levels: 3 }, { id: "q2", role: "qubit", levels: 3 }] },
    })
    expect(r.kind).toBe("pieces")
    if (r.kind === "pieces") expect(r.pieces.some((p) => p.text.includes("+ q2") && p.tone === "add")).toBe(true)
  })
  it("param-change → a 'q1 delta …→…' change piece", () => {
    const r = systemReceiptPieces({
      components: { from: [{ id: "q1", role: "qubit", params: { delta: -0.2 } }], to: [{ id: "q1", role: "qubit", params: { delta: -0.25 } }] },
    })
    expect(r.kind).toBe("pieces")
    if (r.kind === "pieces") expect(r.pieces.some((p) => p.text.includes("q1") && p.text.includes("delta") && p.tone === "change")).toBe(true)
  })
  it("elided set key (…) → chip mode", () => {
    const r = systemReceiptPieces({ "…": { from: null, to: "2 more fields" }, "drive.arch": { from: "global", to: "zoned" } })
    expect(r.kind).toBe("chip")
  })
})

describe("formulationReceiptPieces", () => {
  it("creation (trajectory_type.from null) → chip mode", () => {
    const r = formulationReceiptPieces({
      trajectory_type: { from: null, to: "gate" },
      time_mode: { from: null, to: "min_time" },
      target: { from: null, to: "CZ" },
    })
    expect(r.kind).toBe("chip")
  })
  it("mode transition → 'type: ket → gate'", () => {
    const r = formulationReceiptPieces({ trajectory_type: { from: "ket", to: "gate" } })
    expect(r.kind).toBe("pieces")
    if (r.kind === "pieces") expect(r.pieces.some((p) => /type: ket → gate/.test(p.text))).toBe(true)
  })
  it("flag add → '+ free-phase'", () => {
    const r = formulationReceiptPieces({ free_phase: { from: false, to: true } })
    expect(r.kind).toBe("pieces")
    if (r.kind === "pieces") expect(r.pieces.some((p) => p.text === "+ free-phase" && p.tone === "add")).toBe(true)
  })
  it("added constraint → '+ …' via setDiff", () => {
    const r = formulationReceiptPieces({
      constraints: { from: [], to: [{ kind: "leakage_c", label: "leakage ≤1e-3" }] },
    })
    expect(r.kind).toBe("pieces")
    if (r.kind === "pieces") expect(r.pieces.some((p) => p.text.includes("+ leakage ≤1e-3") && p.tone === "add")).toBe(true)
  })
})
