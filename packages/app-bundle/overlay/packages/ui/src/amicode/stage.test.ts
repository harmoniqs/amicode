import { describe, expect, test } from "bun:test"
import { amicodeStage } from "./stage"

describe("amicodeStage", () => {
  test("maps the four v0 interview tools to their stage labels", () => {
    expect(amicodeStage("amicode_pick_system")).toBe("System")
    expect(amicodeStage("amicode_set_model")).toBe("Model")
    expect(amicodeStage("amicode_formulate")).toBe("Formulation")
    expect(amicodeStage("amicode_solve")).toBe("Run")
  })

  test("falls back to a capitalized, de-underscored label for unknown amicode tools", () => {
    expect(amicodeStage("amicode_to_hardware")).toBe("To hardware")
    expect(amicodeStage("amicode_calibrate")).toBe("Calibrate")
  })

  test("degenerate names do not crash", () => {
    expect(amicodeStage("amicode_")).toBe("amicode_")
    expect(amicodeStage("weird")).toBe("Weird")
  })
})
