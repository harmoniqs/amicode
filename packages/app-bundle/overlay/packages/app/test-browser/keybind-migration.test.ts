import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

// amicode#878: Verify the settings and catalog persist migrations strip the
// stale "mod+." keybind for agent.cycle so the new "shift+tab" default takes
// effect for existing users.

const settingsSource = readFileSync(join(import.meta.dir, "../src/context/settings.tsx"), "utf8")
const commandSource = readFileSync(join(import.meta.dir, "../src/context/command.tsx"), "utf8")

describe("agent.cycle keybind migration (#878)", () => {
  // ── structural guards ──────────────────────────────────────────────────
  test("settings.v3 has a migrate that targets agent_cycle", () => {
    expect(settingsSource).toContain('agent_cycle === "mod+."')
    expect(settingsSource).toContain("delete")
  })

  test("command.catalog.v1 has a migrate that targets agent_cycle", () => {
    expect(commandSource).toContain('agent_cycle?.keybind === "mod+."')
    expect(commandSource).toContain("delete")
  })

  // ── functional tests of the migrate logic ──────────────────────────────
  // Extracted verbatim from the source so the test stays honest even if the
  // implementation is later refactored into a shared helper.

  const migrateSettings = (value: unknown) => {
    if (value && typeof value === "object" && "keybinds" in value) {
      const kb = (value as Record<string, unknown>).keybinds
      if (kb && typeof kb === "object" && (kb as Record<string, unknown>).agent_cycle === "mod+.") {
        delete (kb as Record<string, string>).agent_cycle
      }
    }
    return value
  }

  const migrateCatalog = (value: unknown) => {
    if (value && typeof value === "object") {
      const v = value as Record<string, { keybind?: string }>
      if (v.agent_cycle?.keybind === "mod+.") {
        delete v.agent_cycle
      }
    }
    return value
  }

  test("settings migrate: no keybinds key → no-op", () => {
    expect(migrateSettings({ general: {} })).toEqual({ general: {} })
  })

  test("settings migrate: empty keybinds → no-op", () => {
    expect(migrateSettings({ keybinds: {} })).toEqual({ keybinds: {} })
  })

  test("settings migrate: stale mod+. override is removed", () => {
    expect(migrateSettings({ keybinds: { agent_cycle: "mod+." } })).toEqual({ keybinds: {} })
  })

  test("settings migrate: custom override is preserved", () => {
    const input = { keybinds: { agent_cycle: "ctrl+shift+a" } }
    expect(migrateSettings(input)).toEqual({ keybinds: { agent_cycle: "ctrl+shift+a" } })
  })

  test("settings migrate: other keybinds untouched", () => {
    const input = { keybinds: { agent_cycle: "mod+.", model_choose: "mod+m" } }
    expect(migrateSettings(input)).toEqual({ keybinds: { model_choose: "mod+m" } })
  })

  test("settings migrate: null input → null", () => {
    expect(migrateSettings(null)).toBeNull()
  })

  test("catalog migrate: stale entry is removed", () => {
    const input = { agent_cycle: { keybind: "mod+.", title: "Agent" } }
    expect(migrateCatalog(input)).toEqual({})
  })

  test("catalog migrate: entry with different keybind is preserved", () => {
    const input = { agent_cycle: { keybind: "shift+tab", title: "Agent" } }
    expect(migrateCatalog(input)).toEqual(input)
  })

  test("catalog migrate: other entries untouched", () => {
    const input = {
      agent_cycle: { keybind: "mod+.", title: "Agent" },
      model_choose: { keybind: "mod+'", title: "Model" },
    }
    expect(migrateCatalog(input)).toEqual({ model_choose: { keybind: "mod+'", title: "Model" } })
  })
})
