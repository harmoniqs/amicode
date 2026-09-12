import { describe, expect, test } from "bun:test"
import { frontier, type QNode } from "./frontier"

const graph: QNode[] = [
  { id: "platform", prereqs: [], batchable: false },
  { id: "count", prereqs: ["platform"], batchable: true },
  { id: "homogeneous", prereqs: ["count"], batchable: true },
  // topology is only RELEVANT when there is more than one component (value predicate)
  { id: "topology", prereqs: ["count"], relevant: (a) => Number(a.count) > 1, batchable: true },
  // the gate's options are generated from the platform's VALUE (value-dependent)
  { id: "gate", prereqs: ["platform"], optionsFrom: ["platform"], batchable: false },
]

describe("frontier DAG scheduler (spec §4.1)", () => {
  test("with no answers, only prereq-free nodes are answerable", () => {
    expect(frontier(graph, {}).map((n) => n.id)).toEqual(["platform"])
  })

  test("answering platform unlocks count + gate (gate's optionsFrom now satisfied); platform drops out", () => {
    const ids = frontier(graph, { platform: "transmon" }).map((n) => n.id)
    expect(ids).toContain("count")
    expect(ids).toContain("gate")
    expect(ids).not.toContain("platform")
  })

  test("value-dependent guardrail: a node stays out until its optionsFrom source is answered", () => {
    const g: QNode[] = [
      { id: "platform", prereqs: [], batchable: false },
      { id: "gate", prereqs: [], optionsFrom: ["platform"], batchable: false },
    ]
    expect(frontier(g, {}).map((n) => n.id)).toEqual(["platform"]) // gate blocked by optionsFrom
    expect(frontier(g, { platform: "transmon" }).map((n) => n.id)).toContain("gate")
  })

  test("relevance-pruning: topology is OUT when count=1 though its prereq is met; IN when count>1", () => {
    const single = frontier(graph, { platform: "transmon", count: 1 }).map((n) => n.id)
    expect(single).not.toContain("topology")
    expect(single).toContain("homogeneous") // prereq met, no relevance gate → still in
    const multi = frontier(graph, { platform: "transmon", count: 2 }).map((n) => n.id)
    expect(multi).toContain("topology")
  })

  test("answered nodes are excluded", () => {
    const ids = frontier(graph, {
      platform: "transmon",
      count: 2,
      homogeneous: true,
      topology: "linear-chain",
    }).map((n) => n.id)
    expect(ids).not.toContain("platform")
    expect(ids).not.toContain("count")
    expect(ids).not.toContain("topology")
    expect(ids).toContain("gate") // still unanswered, optionsFrom(platform) satisfied
  })

  test("batchable flag partitions the frontier (mechanical batched, semantic singular)", () => {
    const f = frontier(graph, { platform: "transmon", count: 2 })
    const batched = f.filter((n) => n.batchable).map((n) => n.id)
    const singular = f.filter((n) => !n.batchable).map((n) => n.id)
    expect(batched).toContain("homogeneous")
    expect(batched).toContain("topology")
    expect(singular).toContain("gate")
  })
})
