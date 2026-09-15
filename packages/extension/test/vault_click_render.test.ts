// amicode#447 regression: the knowledge-graph note click → rendered markdown
// chain, asserted end-to-end across the REAL client decisions and the REAL
// server resolver — the same modules the browser runs, imported here because
// they are pure (context-tree-data imports types only; vault-browser-model
// imports nothing).
//
// The reported break: clicking a vault note in the Obsidian-style graph opened
// the file pane but nothing rendered. On the standard fleet layout the click
// payload's mount identity (the vault DIRECTORY segment) is not the mount id
// the wire keys (the marker `name`), so the node rendered locked (dead click)
// or the drawer fetched a mount the server couldn't resolve → the file body
// never arrived → eternal "Loading…" (a blank pane; the named error states
// render only in the tree section, which a deep-link selection bypasses).

import { describe, expect, test } from "vitest"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { vaultFileBody } from "../src/amicode_service/vault_browser"
// the pure client modules, by overlay path (no runtime deps of their own).
// NOTE (fork pin v1.18.10-amicode.18): the .16 helpers `vaultNodeLocked` and
// `effectiveMount` no longer exist — the lock decision became the injected
// `opts.vaultLocked(mount)` callback in context-tree-data (covered by the
// fork's own context-tree-data.test.ts), and the deep-link mount choice was
// inlined into vault-browser.tsx's `mount` memo (chosen ?? mounts[0], with
// membership validation). The extension pins the surviving seam: path →
// vault ref, and the drawer's fetch rendering markdown.
import { vaultRefFromPath } from "../../app-bundle/overlay/packages/ui/src/amicode/context-tree-data"

const NOTE_PATH = "/Users/aaron/.amico/vaults/armonia-aaron-trowbridge/amicode/memory/MEMORY.md"

/** The /amicode/vaults wire as the fixed server emits it: marker-name ids,
 *  browsability, and the directory identity each mount's paths use. */
const WIRE_MOUNTS = [
  { id: "aaron", kind: "personal", writable: true, browsable: true, dirName: "armonia-aaron-trowbridge" },
  { id: "armonissima", kind: "team", writable: false, browsable: false, dirName: "armonissima" },
]

function fixtureRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "amico-vault-click-"))
  const personal = join(root, "armonia-aaron-trowbridge")
  mkdirSync(join(personal, "amicode", "memory"), { recursive: true })
  writeFileSync(join(personal, ".amico-vault.toml"), 'kind = "personal"\nname = "aaron"\n')
  writeFileSync(join(personal, "amicode", "memory", "MEMORY.md"), "# Memory index\n\n- note body here\n")
  return root
}

describe("knowledge-graph note click → rendered markdown (amicode#447)", () => {
  test("the path resolves to a vault ref carrying the directory identity", () => {
    expect(vaultRefFromPath(NOTE_PATH)).toEqual({
      mount: "armonia-aaron-trowbridge",
      rel: "amicode/memory/MEMORY.md",
    })
  })

  test("the drawer's fetch with that payload returns the markdown that renders", () => {
    const root = fixtureRoot()
    try {
      const mount = vaultRefFromPath(NOTE_PATH)
      expect(mount).toBeDefined()
      const body = JSON.parse(
        vaultFileBody(mount!.mount, mount!.rel, root),
      ) as { ok: boolean; content?: string }
      expect(body.ok).toBe(true)
      expect(body.content).toContain("# Memory index")
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
