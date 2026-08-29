import { describe, expect, test } from "bun:test"
import { disconnectPlan } from "./provider-disconnect"

describe("disconnectPlan", () => {
  test("config-sourced provider on v1 takes the disable path — auth removal alone cannot drop it", () => {
    expect(disconnectPlan({ source: "config", configCustom: false, protocol: "v1" })).toBe("disable")
  })

  test("config-sourced provider has no disconnect path on v2", () => {
    expect(disconnectPlan({ source: "config", configCustom: false, protocol: "v2" })).toBe("none")
  })

  test("env-sourced providers can never be disconnected", () => {
    expect(disconnectPlan({ source: "env", configCustom: false, protocol: "v1" })).toBe("none")
    expect(disconnectPlan({ source: "env", configCustom: true, protocol: "v1" })).toBe("none")
  })

  test("custom config providers keep the v1 disable path and stay hidden on v2", () => {
    expect(disconnectPlan({ source: "custom", configCustom: true, protocol: "v1" })).toBe("disable")
    expect(disconnectPlan({ source: "custom", configCustom: true, protocol: "v2" })).toBe("none")
  })

  test("api-key providers disconnect via the auth store on both generations", () => {
    expect(disconnectPlan({ source: "api", configCustom: false, protocol: "v1" })).toBe("remove-auth")
    expect(disconnectPlan({ source: "api", configCustom: false, protocol: "v2" })).toBe("remove-auth")
  })

  test("non-custom plugin providers keep the legacy auth-store path", () => {
    expect(disconnectPlan({ source: "custom", configCustom: false, protocol: "v1" })).toBe("remove-auth")
    expect(disconnectPlan({ source: "custom", configCustom: false, protocol: "v2" })).toBe("remove-auth")
  })

  test("unknown source keeps the legacy auth-store path so existing rows stay disconnectable", () => {
    expect(disconnectPlan({ source: undefined, configCustom: false, protocol: "v1" })).toBe("remove-auth")
  })
})
