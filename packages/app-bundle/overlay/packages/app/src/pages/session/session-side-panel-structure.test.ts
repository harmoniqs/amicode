import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

// amicode#105 structural ACs, locked against resurrection on the next upstream
// merge (this file is merge-hot — the ADR names these deletions deliberately):
//   store_mirror_effects == 0  — no createEffect mirrors between the global
//                                vaultPanel store and the per-session reviewPanel
//   vault_sidepanel_hosts == 0 — the vault's only host is the global drawer;
//                                the side-panel tab is retired
// Behavioral consequence: the sidebar-right toggle's store has a single writer,
// so its pressed state cannot disagree with the screen.
const source = readFileSync(join(import.meta.dir, "session-side-panel.tsx"), "utf8")

describe("work column is vault-free (amicode#105)", () => {
  test("no vaultPanel store references (no mirror effects, no vault tab logic)", () => {
    expect(source).not.toContain("vaultPanel")
  })

  test("no vault tab trigger or content", () => {
    expect(source).not.toContain('value="vault"')
    expect(source).not.toContain("vaultOpen")
  })
})
