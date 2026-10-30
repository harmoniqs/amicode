import { describe, expect, test } from "bun:test"
import { amicoBrainRef } from "./brain-ref"

// #1673: the deleted `amico-run` bin (#1667) is retired on both sides of the UI's
// classification — a shell row running `amico run …` is an experiment touch.
describe("amicoBrainRef bash classification", () => {
  test("`amico run` is an experiment", () => {
    expect(amicoBrainRef("bash", { command: "amico run --spec s.json solve.jl", description: "launch" })?.type).toBe(
      "experiment",
    )
  })

  test("julia is still an experiment", () => {
    expect(amicoBrainRef("bash", { command: "julia --project solve.jl" })?.type).toBe("experiment")
  })

  test("the deleted `amico-run` token alone is not", () => {
    expect(amicoBrainRef("bash", { command: "amico-run solve.jl", description: "old" })?.type).toBe("resource")
  })
})
