import { describe, expect, test, beforeEach, afterEach } from "bun:test"
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import {
  problemsBody,
  problemBody,
  runStatusBody,
  runCardsBody,
  synthesizeProblems,
  synthesizeProblem,
} from "@/server/amicode/problems"

let root: string
beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "amicode-problems-"))
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

function seedProblem(
  slug: string,
  extra?: {
    score?: unknown
    entities?: Record<string, unknown>
    events?: unknown[]
    runs?: unknown[]
    interviewScoreId?: string
  },
) {
  const dir = path.join(root, slug)
  mkdirSync(path.join(dir, "entities"), { recursive: true })
  writeFileSync(
    path.join(dir, "problem.json"),
    JSON.stringify({
      name: slug.toUpperCase(),
      slug,
      created: "2026-07-03T00:00:00Z",
      status: "designing",
      recorded: "2026-07-03T01:00:00Z",
      ...(extra?.score ? { score: extra.score } : {}),
    }),
  )
  for (const [kind, body] of Object.entries(extra?.entities ?? {}))
    writeFileSync(path.join(dir, "entities", `${kind}.json`), JSON.stringify(body))
  if (extra?.events)
    writeFileSync(path.join(dir, "events.jsonl"), extra.events.map((e) => JSON.stringify(e)).join("\n") + "\n")
  if (extra?.runs) writeFileSync(path.join(dir, "runs.json"), JSON.stringify({ runs: extra.runs }))
  if (extra?.interviewScoreId)
    writeFileSync(
      path.join(dir, "interview_state.json"),
      JSON.stringify({ score_id: extra.interviewScoreId, score_version: 3 }),
    )
}

const MANIFEST = {
  manifest: {
    id: "pulse-designer",
    version: 3,
    stages: [
      { id: "platform" },
      { id: "model", emits: ["system"] },
      { id: "formulate", emits: ["formulation"] },
      { id: "solve", emits: ["run", "pulse"] },
      { id: "hardware", emits: ["device_session"] },
    ],
  },
}

describe("problemsBody", () => {
  test("lists problems with active slug and entity kinds", () => {
    seedProblem("x-gate", { entities: { system: { platform: "transmon" } } })
    seedProblem("cz-gate")
    writeFileSync(path.join(root, "active"), "x-gate\n")
    const parsed = JSON.parse(problemsBody(root))
    expect(parsed.ok).toBe(true)
    expect(parsed.active).toBe("x-gate")
    const slugs = parsed.problems.map((p: any) => p.slug).sort()
    expect(slugs).toEqual(["cz-gate", "x-gate"])
    const xg = parsed.problems.find((p: any) => p.slug === "x-gate")
    expect(xg).toMatchObject({
      name: "X-GATE",
      status: "designing",
      recorded: "2026-07-03T01:00:00Z",
      entity_kinds: ["system"],
    })
  })
  test("missing root synthesizes no_problems_dir in the same shape", () => {
    const parsed = JSON.parse(problemsBody(path.join(root, "nope")))
    expect(parsed).toMatchObject({ ok: false, active: null, problems: [] })
    expect(parsed.error).toStartWith("no_problems_dir")
  })
  test("a dir with unparseable problem.json is skipped, not fatal", () => {
    seedProblem("good")
    mkdirSync(path.join(root, "bad"))
    writeFileSync(path.join(root, "bad", "problem.json"), "{nope")
    const parsed = JSON.parse(problemsBody(root))
    expect(parsed.ok).toBe(true)
    expect(parsed.problems.map((p: any) => p.slug)).toEqual(["good"])
  })
})

describe("problemBody", () => {
  test("returns problem + entities + events window + runs", () => {
    const events = Array.from({ length: 60 }, (_, i) => ({ seq: i + 1, ts: "t", entity: "system", action: "updated" }))
    seedProblem("x-gate", {
      entities: { system: { platform: "transmon", levels: 4 } },
      events,
      runs: [{ run_id: "r1", lab: "default", tier: "vetted", recorded: "t" }],
    })
    writeFileSync(path.join(root, "active"), "x-gate")
    const parsed = JSON.parse(problemBody(root, undefined)) // undefined slug → active
    expect(parsed.ok).toBe(true)
    expect(parsed.problem.slug).toBe("x-gate")
    expect(parsed.entities.system.levels).toBe(4)
    expect(parsed.events).toHaveLength(50) // last-50 window
    expect(parsed.events[0].seq).toBe(11) // oldest retained
    expect(parsed.events[49].seq).toBe(60)
    expect(parsed.runs).toEqual([{ run_id: "r1", lab: "default", tier: "vetted", recorded: "t" }])
  })
  test("unknown slug → not_found synthesized", () => {
    seedProblem("x-gate")
    const parsed = JSON.parse(problemBody(root, "zz"))
    expect(parsed.ok).toBe(false)
    expect(parsed.error).toStartWith("not_found:")
  })
  test("corrupt entity sidecar → bad_json:<file> synthesized", () => {
    seedProblem("x-gate")
    writeFileSync(path.join(root, "x-gate", "entities", "system.json"), "{nope")
    const parsed = JSON.parse(problemBody(root, "x-gate"))
    expect(parsed.ok).toBe(false)
    expect(parsed.error).toStartWith("bad_json")
  })
  test("score_stages resolves through interview_state when problem.score is absent", () => {
    writeFileSync(path.join(root, "score_manifest.json"), JSON.stringify(MANIFEST))
    seedProblem("x-gate", { interviewScoreId: "pulse-designer" })
    const parsed = JSON.parse(problemBody(root, "x-gate"))
    expect(parsed.score_stages).toEqual(["system", "formulation", "run", "pulse", "device_session"])
  })
  test("score id mismatch / missing manifest / no score id → []", () => {
    seedProblem("a", { interviewScoreId: "other-score" })
    seedProblem("b", { interviewScoreId: "pulse-designer" }) // manifest removed below
    seedProblem("c") // no score anywhere
    writeFileSync(path.join(root, "score_manifest.json"), JSON.stringify(MANIFEST))
    expect(JSON.parse(problemBody(root, "a")).score_stages).toEqual([])
    expect(JSON.parse(problemBody(root, "c")).score_stages).toEqual([])
    rmSync(path.join(root, "score_manifest.json"))
    expect(JSON.parse(problemBody(root, "b")).score_stages).toEqual([])
  })
})

describe("runStatusBody", () => {
  function seedRun(
    runsRoot: string,
    lab: string,
    id: string,
    opts: { finished?: boolean | string; result?: string; log?: string },
  ) {
    const dir = path.join(runsRoot, lab, id)
    mkdirSync(dir, { recursive: true })
    writeFileSync(path.join(dir, "run.toml"), `run_id = "${id}"\nlab = "${lab}"\n`)
    if (opts.finished)
      writeFileSync(
        path.join(dir, "FINISHED"),
        typeof opts.finished === "string" ? opts.finished : 'status = "completed"\nexit_code = 0\n',
      )
    if (opts.result !== undefined) writeFileSync(path.join(dir, "result.toml"), opts.result)
    if (opts.log !== undefined) writeFileSync(path.join(dir, "run.log"), opts.log)
  }

  test("finished / solving / failed derivation per run ref", () => {
    const runs = mkdtempSync(path.join(tmpdir(), "amicode-runs-"))
    seedProblem("x-gate", {
      runs: [
        { run_id: "r-done", lab: "default", tier: "vetted", recorded: "t" },
        { run_id: "r-live", lab: "default", recorded: "t" },
        { run_id: "r-dead", lab: "default", recorded: "t" },
      ],
    })
    seedRun(runs, "default", "r-done", { finished: true, result: "fidelity = 0.9998\niterations = 60\n" })
    seedRun(runs, "default", "r-live", { log: "noise\nAMICODE_ITER iter=12 f=3.2e-02 inf_pr=1e-9\n" })
    seedRun(runs, "default", "r-dead", { finished: 'status = "failed"\nexit_code = 1\n' }) // failed says so in FINISHED
    const parsed = JSON.parse(runStatusBody(root, runs, "x-gate"))
    expect(parsed.ok).toBe(true)
    expect(parsed.runs).toEqual([
      { run_id: "r-done", status: "finished", fidelity: 0.9998, iteration: 60 },
      { run_id: "r-live", status: "solving", fidelity: 0.032, iteration: 12 },
      { run_id: "r-dead", status: "failed", fidelity: null, iteration: null },
    ])
    rmSync(runs, { recursive: true, force: true })
  })
  // #2055 (A2): the dead state. The exhaustive table lives in the extension's
  // run_liveness_lockstep test (shared fixture, both copies); these pin the
  // engine copy inside the engine's own suite.
  test("run.lock heartbeat > 90 s with no FINISHED → dead; fresh heartbeat + cold log → stalled; FINISHED wins", () => {
    const runs = mkdtempSync(path.join(tmpdir(), "amicode-runs-"))
    seedProblem("x-gate", {
      runs: ["r-dead", "r-quiet", "r-won", "r-nolock"].map((run_id) => ({ run_id, lab: "default", recorded: "t" })),
    })
    const lock = (id: string, ageS: number) =>
      JSON.stringify({ schema: 1, run_id: id, heartbeat_at: new Date(Date.now() - ageS * 1000).toISOString(), ended: false })
    const cold = new Date(Date.now() - 700_000)
    for (const [id, ageS, finished] of [
      ["r-dead", 120, false],
      ["r-quiet", 10, false],
      ["r-won", 600, true],
    ] as const) {
      seedRun(runs, "default", id, { log: "AMICODE_ITER iter=2 f=1.0e-02\n", finished })
      writeFileSync(path.join(runs, "default", id, "run.lock"), lock(id, ageS))
    }
    utimesSync(path.join(runs, "default", "r-quiet", "run.log"), cold, cold)
    seedRun(runs, "default", "r-nolock", { log: "AMICODE_ITER iter=2 f=1.0e-02\n" })
    utimesSync(path.join(runs, "default", "r-nolock", "run.log"), cold, cold)
    const parsed = JSON.parse(runStatusBody(root, runs, "x-gate"))
    expect(parsed.runs.map((r: { run_id: string; status: string }) => [r.run_id, r.status])).toEqual([
      ["r-dead", "dead"],
      ["r-quiet", "stalled"],
      ["r-won", "finished"],
      ["r-nolock", "stalled"],
    ])
    rmSync(runs, { recursive: true, force: true })
  })
  test("missing run dir → stalled (ghost ref, never solving-forever); unknown slug → not_found", () => {
    const runs = mkdtempSync(path.join(tmpdir(), "amicode-runs-"))
    seedProblem("x-gate", { runs: [{ run_id: "r-gone", lab: "default", recorded: "t" }] })
    const parsed = JSON.parse(runStatusBody(root, runs, "x-gate"))
    expect(parsed.runs).toEqual([{ run_id: "r-gone", status: "stalled", fidelity: null, iteration: null }])
    expect(JSON.parse(runStatusBody(root, runs, "zz")).error).toStartWith("not_found:")
    rmSync(runs, { recursive: true, force: true })
  })
})

describe("synthesize", () => {
  test("both synthesizers emit their full success shape with ok:false", () => {
    expect(JSON.parse(synthesizeProblems("x", "d"))).toEqual({ ok: false, active: null, problems: [], error: "x: d" })
    expect(JSON.parse(synthesizeProblem("x", "d"))).toEqual({
      ok: false,
      problem: null,
      entities: {},
      score_stages: [],
      events: [],
      runs: [],
      error: "x: d",
    })
  })
})

describe("runCardsBody", () => {
  test("collects only completed runs with fidelity, shaped for the card renderer", () => {
    const runs = mkdtempSync(path.join(tmpdir(), "amicode-cards-"))
    seedProblem("cz-gate", {
      runs: [
        { run_id: "r20260707-010101Z-aaaa", lab: "default", recorded: "t" },
        { run_id: "r20260707-020202Z-bbbb", lab: "default", recorded: "t" },
      ],
    })
    writeFileSync(
      path.join(root, "cz-gate", "problem.json"),
      JSON.stringify({ slug: "cz-gate", name: "CZ on Rydberg" }),
    )
    mkdirSync(path.join(root, "cz-gate", "entities"), { recursive: true })
    writeFileSync(
      path.join(root, "cz-gate", "entities", "system.json"),
      JSON.stringify({ params: { platform: "rydberg" } }),
    )
    writeFileSync(path.join(root, "cz-gate", "entities", "run.json"), JSON.stringify({ params: { gate: "CZ" } }))
    const dirA = path.join(runs, "default", "r20260707-010101Z-aaaa")
    mkdirSync(dirA, { recursive: true })
    writeFileSync(path.join(dirA, "run.toml"), 'run_id = "r20260707-010101Z-aaaa"\n')
    writeFileSync(
      path.join(dirA, "run.log"),
      'AMICODE_ITER iter=1 f=5.0e-01\nAMICODE_PULSE_META drives=2 knots=3 labels=["I","Q"]\nAMICODE_PULSE iter=2 dt=0.5 a=1,2,3;4,5,6\nAMICODE_ITER iter=2 f=1.0e-04\n',
    )
    writeFileSync(path.join(dirA, "result.toml"), "fidelity = 0.9999\niterations = 2\n")
    writeFileSync(path.join(dirA, "FINISHED"), 'status = "completed"\nexit_code = 0\n')
    const dirB = path.join(runs, "default", "r20260707-020202Z-bbbb")
    mkdirSync(dirB, { recursive: true })
    writeFileSync(path.join(dirB, "FINISHED"), 'status = "failed"\nexit_code = 1\n') // failures stay out of the trophy case

    const parsed = JSON.parse(runCardsBody(root, runs))
    expect(parsed.ok).toBe(true)
    expect(parsed.cards).toHaveLength(1)
    const card = parsed.cards[0]
    expect(card).toMatchObject({
      slug: "cz-gate",
      problem: "CZ on Rydberg",
      platform: "rydberg",
      gate: "CZ",
      run_id: "r20260707-010101Z-aaaa",
      fidelity: 0.9999,
      iterations: 2,
    })
    expect(card.series).toHaveLength(2)
    expect(card.pulse.values).toEqual([1, 2, 3, 4, 5, 6])
    expect(card.pulse_meta.drives).toBe(2)
    rmSync(runs, { recursive: true, force: true })
  })
})
