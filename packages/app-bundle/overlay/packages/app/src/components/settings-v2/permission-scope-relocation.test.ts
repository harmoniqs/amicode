import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"

// ============================================================================
// The auto-accept-permissions toggle moved from the General tab to the
// Permissions tab (#940) — it is a permissions control and belongs with the
// other permission settings, not general app preferences. Three coordinated
// changes make this real: the component definition + its usage move out of
// general.tsx and into permissions.tsx, and sessionID (which the moved
// controller needs) is threaded from the dialog shell to the Permissions
// tab, which previously never received it.
//
// No @solidjs/testing-library render harness exists in this codebase, so —
// following the same source-scanning pattern already used for the
// "outer relay script forwards preview-file to the iframe" structural test
// — this verifies the move via source content rather than a rendered DOM.
// ============================================================================

const here = dirname(fileURLToPath(import.meta.url))
const generalSrc = () => readFileSync(join(here, "general.tsx"), "utf8")
const permissionsSrc = () => readFileSync(join(here, "permissions.tsx"), "utf8")
const dialogSrc = () => readFileSync(join(here, "dialog-settings-v2.tsx"), "utf8")

/** Extract the JSX block for a given TabsV2.Content value, for a scoped assertion. */
function extractTabContent(src: string, tabValue: string): string {
  const start = src.indexOf(`<TabsV2.Content value="${tabValue}"`)
  if (start === -1) throw new Error(`tab content for "${tabValue}" not found`)
  const end = src.indexOf("</TabsV2.Content>", start)
  return src.slice(start, end)
}

describe("auto-accept permissions toggle relocation (#940)", () => {
  test("general.tsx no longer defines or renders PermissionScopeSetting", () => {
    expect(generalSrc()).not.toContain("PermissionScopeSetting")
  })

  test("general.tsx no longer creates a permission-scope controller", () => {
    expect(generalSrc()).not.toContain("createPermissionScopeController")
  })

  test("permissions.tsx defines and renders PermissionScopeSetting", () => {
    const src = permissionsSrc()
    expect(src).toContain("PermissionScopeSetting")
    expect(src).toContain("createPermissionScopeController")
  })

  test("the dialog shell threads sessionID into the Permissions tab", () => {
    const permissionsTab = extractTabContent(dialogSrc(), "permissions")
    expect(permissionsTab).toContain("SettingsPermissionsV2")
    expect(permissionsTab).toContain("sessionID")
  })
})
