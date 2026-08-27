// amicode#447 regression: the knowledge-graph note click → rendered markdown
// chain breaks whenever a vault mount's DIRECTORY name differs from its
// marker `name` (the standard fleet personal layout: dir
// `armonia-aaron-trowbridge`, marker `name = "aaron"`).
//
// The click payload carries the DIRECTORY identity (vaultRefFromPath), but the
// server's mountDir() only resolved marker names, so:
//   - the drawer's /amicode/vault-file fetch for the unlisted id 404'd,
//   - the mounts wire carried no directory identity to reconcile with,
//     leaving path-derived vault nodes permanently locked or misrouted.
//
// These tests exercise the SERVER half with a fixture root that mirrors the
// real layout: `mountDir` must resolve BOTH identities, and the mounts wire
// must carry each mount's directory identity (dirName) so the client can
// reconcile a path-derived vault ref against the mount list.

import { describe, expect, test } from "vitest"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { annotateBrowsable } from "../src/amicode_service/vaults"
import { mountDir, vaultFileBody } from "../src/amicode_service/vault_browser"

/** Fixture root mirroring the fleet layout: the personal vault's directory
 *  name (what vault paths carry) differs from its marker id (what the wire
 *  keys mounts by), plus a name==dir team mount for contrast. */
function fixtureRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "amico-vault-identity-"))
  const personal = join(root, "armonia-aaron-trowbridge")
  mkdirSync(join(personal, "amicode", "memory"), { recursive: true })
  writeFileSync(join(personal, ".amico-vault.toml"), 'kind = "personal"\nname = "aaron"\n')
  writeFileSync(
    join(personal, "amicode", "memory", "MEMORY.md"),
    "# Memory index\n\n- [piccolo-api-drift](feedback_piccolo_api_drift.md) — sandbox scripts break after upgrades\n",
  )
  const team = join(root, "meeting-vault")
  mkdirSync(team, { recursive: true })
  writeFileSync(join(team, ".amico-vault.toml"), 'kind = "team"\nname = "meeting-vault"\nbrowse = false\n')
  writeFileSync(join(team, "notes.md"), "meeting notes\n")
  return root
}

describe("mountDir — both mount identities (amicode#447)", () => {
  test("resolves the marker-name id (existing behavior, unchanged)", () => {
    const root = fixtureRoot()
    try {
      expect(mountDir("aaron", root)).toBe(join(root, "armonia-aaron-trowbridge"))
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("resolves the directory-basename identity — the one vault paths carry", () => {
    const root = fixtureRoot()
    try {
      expect(mountDir("armonia-aaron-trowbridge", root)).toBe(join(root, "armonia-aaron-trowbridge"))
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("still refuses unknown ids", () => {
    const root = fixtureRoot()
    try {
      expect(mountDir("not-a-vault", root)).toBeUndefined()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe("vaultFileBody — the drawer's fetch with the path-derived id (amicode#447)", () => {
  test("the click payload's mount id resolves and returns the markdown content", () => {
    const root = fixtureRoot()
    try {
      const body = JSON.parse(
        vaultFileBody("armonia-aaron-trowbridge", "amicode/memory/MEMORY.md", root),
      ) as { ok: boolean; content?: string; error?: string }
      expect(body.ok).toBe(true)
      expect(body.content).toContain("# Memory index")
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("fail-closed is intact: an opted-out mount refuses by either identity", () => {
    const root = fixtureRoot()
    try {
      for (const id of ["meeting-vault"]) {
        const body = JSON.parse(vaultFileBody(id, "notes.md", root)) as { ok: boolean; error?: string }
        expect(body.ok).toBe(false)
        expect(body.error).toContain("forbidden")
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe("annotateBrowsable — the wire carries the directory identity (amicode#447)", () => {
  test("each browsable mount is annotated with the directory its paths use", () => {
    const root = fixtureRoot()
    try {
      const wire = JSON.parse(
        annotateBrowsable(
          JSON.stringify({
            ok: true,
            mounts: [
              { id: "aaron", kind: "personal", writable: true, last_sync: "unknown" },
              { id: "meeting-vault", kind: "team", writable: false, last_sync: "unknown" },
            ],
          }),
          root,
        ),
      ) as { mounts: { id: string; browsable?: boolean; dirName?: string }[] }
      const personal = wire.mounts.find((m) => m.id === "aaron")
      const team = wire.mounts.find((m) => m.id === "meeting-vault")
      expect(personal?.browsable).toBe(true)
      expect(personal?.dirName).toBe("armonia-aaron-trowbridge")
      // fail-closed stays: team without opt-in is not browsable, and its
      // dirName is still emitted (the identity is not a secret; browsing is)
      expect(team?.browsable).toBe(false)
      expect(team?.dirName).toBe("meeting-vault")
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
