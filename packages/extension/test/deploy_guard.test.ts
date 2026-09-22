import { describe, expect, test } from "vitest"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  buildDeployManifest,
  checkKnownFixes,
  evaluatePreflight,
  headRelation,
  resolveDefaultBranch,
} from "../scripts/deploy_guard.mjs"

// amicode#992 — the deploy guard. #1196: the ahead-of-trunk baseline is the
// repository's DEFAULT BRANCH, resolved dynamically from the remote (dev
// workflow: dev = integration target, main = tested trunk) — not the literal
// string "main". A tree merged into the default branch is recorded state and
// builds plain; a tree AHEAD of the default branch is the #992 race.
//
// The 2026-09-10 deploy race: a local-tree deploy (build_app_bundle.mjs from a
// tree predating #988) overwrote the recorded-main dist-app swap and the
// tool-count-label crash returned — an unrecorded local build served over a
// recorded fix. The guard's contract, tested here as pure functions (the
// script gathers git's observations; the DECISION lives in deploy_guard.mjs):
//
//   1. refuse when HEAD ≠ the default branch's remote ref (behind or diverged)
//      — named reason + remedy, naming the RESOLVED baseline
//   2. refuse when the tree is dirty — named reason + remedy
//   3. refuse an override with an empty/missing reason (no silent overrides)
//   4. a VALID override proceeds but is RECORDED (stamped into deploy.json)
//   5. a clean tree AT the default branch proceeds with no override (#1196)
//   6. the manifest shape: {commit, branch, dirty, override_reason, built_at, deployed_by}
//   7. the #964 known-fixes check: missing hunk → named-remedy refusal; full
//      overlay → clean
//   8. #1196: the default branch resolves from `git remote show origin`'s HEAD
//      branch first, then refs/remotes/origin/HEAD, then the "main" fallback

const HEAD = "aaaabbbbccccddddeeeeffff0000111122223333"
const BASELINE = "9999888877776666555544443333222211110000"
const BASELINE_REF = "origin/dev"

const proceed = (d: ReturnType<typeof evaluatePreflight>) => {
  expect(d.ok).toBe(true)
  return d as { ok: true; overrideReason: string | null; recorded: string[] }
}

describe("#992 pre-flight: HEAD vs the default branch (#1196 baseline)", () => {
  test("refuses a tree BEHIND the default branch with a named reason and remedy", () => {
    const d = evaluatePreflight({
      headSha: HEAD,
      baselineSha: BASELINE,
      baselineRef: BASELINE_REF,
      relation: "BEHIND",
      dirtyEntries: [],
      overrideReason: undefined,
    })
    expect(d.ok).toBe(false)
    if (d.ok) return
    expect(d.reasons[0]).toContain("BEHIND")
    expect(d.reasons[0]).toContain("pull/rebase")
  })

  test("refuses a DIVERGED tree with a named reason and remedy", () => {
    const d = evaluatePreflight({
      headSha: HEAD,
      baselineSha: BASELINE,
      baselineRef: BASELINE_REF,
      relation: "DIVERGED from",
      dirtyEntries: [],
      overrideReason: undefined,
    })
    expect(d.ok).toBe(false)
    if (d.ok) return
    expect(d.reasons[0]).toContain("DIVERGED")
    expect(d.reasons[0]).toContain("pull/rebase")
  })

  test("a tree AHEAD of the default branch still refuses — and the remedy names the RESOLVED baseline", () => {
    // The #1196 acceptance: dev-workflow trees are ahead of main by definition;
    // the guard must refuse against the DEFAULT branch (origin/dev here), and
    // the refusal must say WHICH baseline it compared against.
    const d = evaluatePreflight({
      headSha: HEAD,
      baselineSha: BASELINE,
      baselineRef: BASELINE_REF,
      relation: "AHEAD of",
      dirtyEntries: [],
      overrideReason: undefined,
    })
    expect(d.ok).toBe(false)
    if (d.ok) return
    expect(d.reasons[0]).toContain("AHEAD of")
    expect(d.reasons[0]).toContain(BASELINE_REF)
    expect(d.reasons[0]).not.toContain("origin/main")
    expect(d.reasons[0]).toContain("pull/rebase")
    expect(d.reasons[0]).toContain(BASELINE_REF)
  })

  test("a tree merged into the default branch (HEAD == baseline) builds without the override (#1196)", () => {
    const d = proceed(
      evaluatePreflight({
        headSha: HEAD,
        baselineSha: HEAD,
        baselineRef: BASELINE_REF,
        relation: "at",
        dirtyEntries: [],
        overrideReason: undefined,
      }),
    )
    expect(d.overrideReason).toBeNull()
    expect(d.recorded).toEqual([])
  })

  test("the stale-tree OVERRIDE record names the resolved baseline, not origin/main", () => {
    const d = proceed(
      evaluatePreflight({
        headSha: HEAD,
        baselineSha: BASELINE,
        baselineRef: BASELINE_REF,
        relation: "AHEAD of",
        dirtyEntries: [],
        overrideReason: "hotfix recorded",
      }),
    )
    expect(d.recorded[0]).toContain(BASELINE_REF)
    expect(d.recorded[0]).not.toContain("origin/main")
  })
})

describe("#992 pre-flight: dirty tree", () => {
  test("refuses a dirty tree with a named reason and remedy", () => {
    const d = evaluatePreflight({
      headSha: HEAD,
      baselineSha: HEAD,
      baselineRef: BASELINE_REF,
      relation: "at",
      dirtyEntries: [" M packages/app/src/foo.ts", "?? scratch.md"],
      overrideReason: undefined,
    })
    expect(d.ok).toBe(false)
    if (d.ok) return
    expect(d.reasons[0]).toContain("dirty")
    expect(d.reasons[0]).toContain("stash")
    expect(d.reasons[0]).toContain("commit via a PR")
    expect(d.reasons[0]).toContain("foo.ts")
  })
})

describe("#992 pre-flight: the override gate", () => {
  test("refuses an override whose reason is EMPTY (flag set, no silent overrides)", () => {
    const d = evaluatePreflight({
      headSha: HEAD,
      baselineSha: BASELINE,
      baselineRef: BASELINE_REF,
      relation: "BEHIND",
      dirtyEntries: [],
      overrideReason: "",
    })
    expect(d.ok).toBe(false)
    if (d.ok) return
    expect(d.reasons.some((r) => r.includes("AMICODE_DEPLOY_OVERRIDE") && r.includes("empty"))).toBe(true)
  })

  test("refuses an override whose reason is WHITESPACE only", () => {
    const d = evaluatePreflight({
      headSha: HEAD,
      baselineSha: BASELINE,
      baselineRef: BASELINE_REF,
      relation: "BEHIND",
      dirtyEntries: [],
      overrideReason: "   ",
    })
    expect(d.ok).toBe(false)
  })

  test("a valid override PROCEEDS but is recorded", () => {
    const d = proceed(
      evaluatePreflight({
        headSha: HEAD,
        baselineSha: BASELINE,
        baselineRef: BASELINE_REF,
        relation: "BEHIND",
        dirtyEntries: [],
        overrideReason: "hotfix: rollback dist to last known good while #1000 is debugged",
      }),
    )
    expect(d.overrideReason).toBe("hotfix: rollback dist to last known good while #1000 is debugged")
    expect(d.recorded.at(-1)).toContain("OVERRIDE RECORDED")
    expect(d.recorded.at(-1)).toContain("deploy.json")
    expect(d.recorded[0]).toContain("stale tree")
  })

  test("a valid override on a clean at-baseline tree also proceeds, recorded", () => {
    const d = proceed(
      evaluatePreflight({
        headSha: HEAD,
        baselineSha: HEAD,
        baselineRef: BASELINE_REF,
        relation: "at",
        dirtyEntries: [],
        overrideReason: "not needed but stated",
      }),
    )
    expect(d.overrideReason).toBe("not needed but stated")
  })
})

describe("#1196 the default-branch baseline resolution", () => {
  test("prefers `git remote show origin`'s HEAD branch — the remote's own answer (a stale local origin/HEAD loses)", () => {
    // The observed failure mode on the fleet macbook (#1195 ref-build): local
    // refs/remotes/origin/HEAD still said main while the remote's HEAD is dev.
    const resolved = resolveDefaultBranch({
      remoteShowOutput: "* remote origin\n  Fetch URL: git@github.com:harmoniqs/amicode.git\n  HEAD branch: dev\n",
      symbolicRefOutput: "origin/main",
    })
    expect(resolved).toEqual({ branch: "dev", source: "remote-show" })
  })

  test("falls back to refs/remotes/origin/HEAD when the remote show carries no HEAD branch", () => {
    const resolved = resolveDefaultBranch({
      remoteShowOutput: "",
      symbolicRefOutput: "origin/dev",
    })
    expect(resolved).toEqual({ branch: "dev", source: "symbolic-ref" })
  })

  test("accepts the full ref form refs/remotes/origin/<branch> as the symbolic-ref output", () => {
    const resolved = resolveDefaultBranch({
      remoteShowOutput: "",
      symbolicRefOutput: "refs/remotes/origin/dev",
    })
    expect(resolved).toEqual({ branch: "dev", source: "symbolic-ref" })
  })

  test("falls back to main when neither probe yields a branch — the sane fallback", () => {
    const resolved = resolveDefaultBranch({
      remoteShowOutput: "",
      symbolicRefOutput: "",
    })
    expect(resolved).toEqual({ branch: "main", source: "fallback" })
  })

  test("a remote show whose HEAD branch line is absent (detached/unborn) falls through to the symbolic ref, then main", () => {
    const unresolvedRemote = "  Push URL: git@github.com:harmoniqs/amicode.git\n"
    expect(
      resolveDefaultBranch({ remoteShowOutput: unresolvedRemote, symbolicRefOutput: "origin/trunk" }),
    ).toEqual({ branch: "trunk", source: "symbolic-ref" })
    expect(
      resolveDefaultBranch({ remoteShowOutput: unresolvedRemote, symbolicRefOutput: "" }),
    ).toEqual({ branch: "main", source: "fallback" })
  })
})

describe("#992 the deploy manifest", () => {
  test("stamps the full contract shape", () => {
    const m = buildDeployManifest({
      commit: HEAD,
      branch: "main",
      dirty: false,
      overrideReason: null,
      builtAt: "2026-09-10T15:06:00.000Z",
      deployedBy: "aaron@erlich",
    })
    expect(m).toEqual({
      commit: HEAD,
      branch: "main",
      dirty: false,
      override_reason: null,
      built_at: "2026-09-10T15:06:00.000Z",
      deployed_by: "aaron@erlich",
    })
  })

  test("an undefined override_reason serializes as null, not undefined", () => {
    const m = buildDeployManifest({
      commit: HEAD,
      branch: "main",
      dirty: true,
      overrideReason: undefined,
      builtAt: "2026-09-10T15:06:00.000Z",
      deployedBy: "aaron@erlich",
    })
    expect(m.override_reason).toBeNull()
    expect(JSON.parse(JSON.stringify(m))).toHaveProperty("override_reason", null)
  })
})

describe("#992 the #964 known-fixes check at deploy time", () => {
  const writeOverlay = (files: Record<string, string>) => {
    const dir = mkdtempSync(join(tmpdir(), "deploy-guard-overlay-"))
    for (const [rel, content] of Object.entries(files)) {
      const abs = join(dir, rel)
      mkdirSync(join(abs, ".."), { recursive: true })
      writeFileSync(abs, content)
    }
    return dir
  }

  const HEALTHY = {
    "components/prompt-input-v2.tsx": "export const x = promptDesignPlaceholder(\n  mode(),\n  placeholder(),\n)",
    "context/global-sync/session-cache.ts":
      "const diff_version: Record<string, number | undefined> = {}\ndelete store.diff_version[sessionID]",
    "i18n/en.ts": 'export const dict = { "session.exportTrace": "Export trace" }',
    "i18n/de.ts": 'export const dict = { "session.exportTrace": "Trace exportieren" }',
  }

  test("a full overlay with every known hunk passes clean", () => {
    const dir = writeOverlay(HEALTHY)
    try {
      expect(checkKnownFixes(dir)).toEqual([])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("a missing #929 3-arg translate call refuses with the named remedy", () => {
    const dir = writeOverlay({ ...HEALTHY, "components/prompt-input-v2.tsx": "promptDesignPlaceholder(mode())" })
    try {
      const regressed = checkKnownFixes(dir)
      expect(regressed).toHaveLength(1)
      expect(regressed[0]).toContain("#929")
      expect(regressed[0]).toContain("prompt-input-v2.tsx")
      expect(regressed[0]).toContain("REFUSED")
      expect(regressed[0]).toContain("#964")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("a missing #832 exportTrace locale entry refuses per locale", () => {
    const dir = writeOverlay({
      ...HEALTHY,
      "i18n/de.ts": 'export const dict = { "session.other": "x" }',
      "i18n/ar.ts": 'export const dict = { "session.exportTrace": "…" }',
    })
    try {
      const regressed = checkKnownFixes(dir)
      expect(regressed).toHaveLength(1)
      expect(regressed[0]).toContain("i18n/de.ts")
      expect(regressed[0]).toContain("#832")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("the shared fixture list matches the #964 guard's source of record", () => {
    // The shared module (packages/app-bundle/scripts/known_fixes.mjs) is the
    // single machine-usable copy both deploy_guard.mjs and overlay-sync.mjs
    // consume; overlay_known_fixes_964.test.ts is the source of record. This
    // cross-checks the two lists can't drift silently: same file set.
    const guardSource = readFileSync(
      join(__dirname, "overlay_known_fixes_964.test.ts"),
      "utf8",
    )
    const guardFiles = [...guardSource.matchAll(/file: "([^"]+)"/g)].map((m) => m[1])
    const guardSig = [...guardSource.matchAll(/signature: (\/.+\/[a-z]*)/g)].map((m) => m[1])
    const sharedSource = readFileSync(
      join(__dirname, "..", "..", "app-bundle", "scripts", "known_fixes.mjs"),
      "utf8",
    )
    const sharedFiles = [...sharedSource.matchAll(/file: "([^"]+)"/g)].map((m) => m[1])
    const sharedSig = [...sharedSource.matchAll(/signature: (\/.+\/[a-z]*)/g)].map((m) => m[1])
    expect(sharedFiles).toEqual(guardFiles)
    expect(sharedSig).toEqual(guardSig)
  })

  test("the deploy guard does not fork a third copy of the fixture list", () => {
    // #842: the list lives in the shared module only. If someone re-forks it
    // into deploy_guard.mjs, this fails (drift would then be possible again).
    const deploySource = readFileSync(
      join(__dirname, "..", "scripts", "deploy_guard.mjs"),
      "utf8",
    )
    expect(deploySource).toContain("known_fixes.mjs")
    expect(deploySource).not.toMatch(/signature: \//)
  })
})

describe("#992 headRelation (the git probe → label mapping)", () => {
  test("equal shas → at", () => {
    expect(headRelation(HEAD, HEAD, true, true)).toBe("at")
  })
  test("HEAD behind the baseline → BEHIND", () => {
    expect(headRelation(HEAD, BASELINE, true, false)).toBe("BEHIND")
  })
  test("HEAD ahead of the baseline → AHEAD of", () => {
    expect(headRelation(HEAD, BASELINE, false, true)).toBe("AHEAD of")
  })
  test("diverged → DIVERGED from", () => {
    expect(headRelation(HEAD, BASELINE, false, false)).toBe("DIVERGED from")
  })
})
