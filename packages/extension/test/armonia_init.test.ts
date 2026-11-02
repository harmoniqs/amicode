// armonia_init.test.ts — #2100: the executable spec for scripts/armonia-init,
// the vault day-one provisioning contract (naming rule, root-state rules,
// degraded no-remote mint, idempotent resume).
//
// SAFETY: armonia-init can create real private repos in the harmoniqs org and
// push to them. This suite can NEVER do that, by construction:
//   - the child PATH is  <stand-in dir>:/usr/bin:/bin  — the stand-in dir
//     holds recording `gh`, `git` and `systemctl`; the real gh is not on PATH;
//   - the stand-in `gh` records argv and exits non-zero (or zero where a test
//     is characterizing the credentialed path — still no network, it is a
//     stand-in);
//   - the stand-in `git` records everything, passes local operations through
//     to the real git (absolute path), and REFUSES clone/push/fetch/pull/
//     ls-remote (a clone of a harmoniqs vault can be simulated locally);
//   - HOME and --root are temp dirs; AMICO_NO_TIMER=1; GIT_SSH_COMMAND=false;
//   - a guard asserts `command -v gh` resolves to the stand-in before any run.
// The script runs as a subprocess; nothing of it is mocked.
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { execFileSync, spawnSync } from "node:child_process"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, symlinkSync, writeFileSync, lstatSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const SCRIPT = join(__dirname, "..", "..", "..", "scripts", "armonia-init")
const REAL_GIT = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim()
const FOLDERS = ["hopper", "specs", "plans", "notes", "briefs", "experiments", "insights", "sessions"]
const NETWORK_SUBCOMMANDS = "clone|push|fetch|pull|ls-remote"

type Fixture = { tmp: string; stub: string; home: string; root: string; canon: string }
let fx: Fixture

function makeFixture(): Fixture {
  const tmp = mkdtempSync(join(tmpdir(), "armonia-init-"))
  const stub = join(tmp, "stub")
  const home = join(tmp, "home")
  mkdirSync(stub)
  mkdirSync(home)
  const tool = (name: string, body: string) => {
    writeFileSync(join(stub, name), `#!/bin/bash\n${body}\n`)
    chmodSync(join(stub, name), 0o755)
  }
  tool("gh", `echo "gh $*" >> "$STUB_DIR/gh.log"\nexit "\${STUB_GH_EXIT:-1}"`)
  tool("systemctl", `echo "systemctl $*" >> "$STUB_DIR/systemctl.log"\nexit 1`)
  tool(
    "git",
    `echo "git $*" >> "$STUB_DIR/git.log"
args=("$@"); i=0; sub=""
while [ $i -lt \${#args[@]} ]; do
  case "\${args[$i]}" in -C|-c) i=$((i+2));; -*) i=$((i+1));; *) sub="\${args[$i]}"; break;; esac
done
case "$sub" in
  ${NETWORK_SUBCOMMANDS})
    echo "$sub $*" >> "$STUB_DIR/net.log"
    # a simulated LOCAL clone of a harmoniqs vault repo, when a test asks for one
    if [ "$sub" = clone ] && [ "\${STUB_CLONE_SIM:-0}" = 1 ]; then
      n=\${#args[@]}; url="\${args[$((n-2))]}"; dest="\${args[$((n-1))]}"
      case "$url" in *harmoniqs/vault-*) ${REAL_GIT} init -q "$dest"; exit 0;; esac
    fi
    exit 128;;
esac
exec ${REAL_GIT} "$@"`,
  )
  return { tmp, stub, home, root: join(tmp, "vaults"), canon: join(tmp, "canonical") }
}

function childEnv(extra: Record<string, string> = {}): Record<string, string> {
  return {
    PATH: `${fx.stub}:/usr/bin:/bin`,
    HOME: fx.home,
    STUB_DIR: fx.stub,
    AMICO_NO_TIMER: "1",
    GIT_SSH_COMMAND: "false",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "t",
    GIT_AUTHOR_EMAIL: "t@example.invalid",
    GIT_COMMITTER_NAME: "t",
    GIT_COMMITTER_EMAIL: "t@example.invalid",
    ...extra,
  }
}

function init(args: string[], extra: Record<string, string> = {}) {
  // the guard, before EVERY run: gh/git/systemctl must resolve to the stand-ins
  const env = childEnv(extra)
  for (const t of ["gh", "git", "systemctl"]) {
    const resolved = execFileSync("sh", ["-c", `command -v ${t}`], { env, encoding: "utf8" }).trim()
    if (resolved !== join(fx.stub, t)) throw new Error(`SAFETY: ${t} resolves to ${resolved}, not the stand-in`)
  }
  const r = spawnSync("bash", [SCRIPT, ...args], { env, encoding: "utf8", timeout: 60_000 })
  return { status: r.status, stdout: r.stdout, stderr: r.stderr }
}

const log = (name: string) => (existsSync(join(fx.stub, name)) ? readFileSync(join(fx.stub, name), "utf8") : "")
const ghCalls = () => log("gh.log")
const netCalls = () => log("net.log")
const commitCount = (dir: string) => Number(execFileSync(REAL_GIT, ["-C", dir, "rev-list", "--count", "HEAD"], { encoding: "utf8" }).trim())
const marker = (dir: string) => readFileSync(join(dir, ".amico-vault.toml"), "utf8")

/** A throwaway template dir for the local-template mint branch. */
function makeTemplate(): string {
  const tmpl = join(fx.tmp, "template")
  for (const d of ["hopper", "specs", "scripts", "systemd"]) {
    mkdirSync(join(tmpl, d), { recursive: true })
    writeFileSync(join(tmpl, d, ".gitkeep"), "")
  }
  writeFileSync(join(tmpl, "README.md"), "# template\n")
  return tmpl
}

beforeEach(() => {
  fx = makeFixture()
})
afterEach(() => rmSync(fx.tmp, { recursive: true, force: true }))

describe("stand-in guard", () => {
  it("puts the recording stand-ins first on PATH — the real gh is unreachable", () => {
    const env = childEnv()
    for (const t of ["gh", "git", "systemctl"]) {
      expect(execFileSync("sh", ["-c", `command -v ${t}`], { env, encoding: "utf8" }).trim()).toBe(join(fx.stub, t))
    }
  })
})

// ── AC1 + AC4: the gate is closed in EVERY branch (mint, resume, mounts) ────
const CLOSERS: Array<{ name: string; env: Record<string, string>; flags: string[] }> = [
  { name: "AMICO_FORCE_DEGRADED=1", env: { AMICO_FORCE_DEGRADED: "1" }, flags: [] },
  { name: "AMICO_NO_NETWORK=1", env: { AMICO_NO_NETWORK: "1" }, flags: [] },
  { name: "--no-github", env: {}, flags: ["--no-github"] },
]

describe.each(CLOSERS)("outward gate closed by $name", ({ env, flags }) => {
  it("mint: never invokes gh, never clones/pushes, mounts no shared vault", () => {
    const r = init(["jane", "--root", fx.root, ...flags], env)
    expect(r.status).toBe(0)
    expect(ghCalls()).toBe("")
    expect(netCalls()).toBe("")
    expect(existsSync(join(fx.root, "vault-jane"))).toBe(true)
    expect(existsSync(join(fx.root, "armonissima"))).toBe(false)
    expect(existsSync(join(fx.root, "armonia-issimo"))).toBe(false)
  })

  it("resume of a local-only vault: exit 0, still local-only, no gh, no remote created", () => {
    expect(init(["jane", "--root", fx.root, ...flags], env).status).toBe(0)
    const before = commitCount(join(fx.root, "vault-jane"))
    const r = init(["jane", "--root", fx.root, ...flags], env)
    expect(r.status).toBe(0)
    expect(r.stderr).toContain("still local-only")
    expect(ghCalls()).toBe("")
    expect(netCalls()).toBe("")
    const dir = join(fx.root, "vault-jane")
    expect(marker(dir)).toContain('provision_state = "local-only"')
    expect(commitCount(dir)).toBe(before)
    expect(execFileSync(REAL_GIT, ["-C", dir, "remote"], { encoding: "utf8" }).trim()).toBe("")
  })

  it("resume ignores even an explicit remote seam while the gate is closed", () => {
    execFileSync(REAL_GIT, ["init", "-q", "--bare", join(fx.tmp, "bare.git")])
    expect(init(["jane", "--root", fx.root, ...flags], env).status).toBe(0)
    const r = init(["jane", "--root", fx.root, ...flags], { ...env, AMICO_RESUME_REMOTE: join(fx.tmp, "bare.git") })
    expect(r.status).toBe(0)
    expect(marker(join(fx.root, "vault-jane"))).toContain('provision_state = "local-only"')
    expect(execFileSync(REAL_GIT, ["-C", join(fx.root, "vault-jane"), "remote"], { encoding: "utf8" }).trim()).toBe("")
    expect(ghCalls()).toBe("")
    expect(netCalls()).toBe("")
  })
})

// ── AC2: the naming rule ────────────────────────────────────────────────────
describe("naming rule", () => {
  it("refuses a minted name containing 'armonia' — names the minted vault, exits non-zero, creates nothing", () => {
    const r = init(["armonia-brad", "--root", fx.root], { AMICO_FORCE_DEGRADED: "1" })
    expect(r.status).not.toBe(0)
    expect(r.stderr).toContain("REFUSED")
    expect(r.stderr).toContain("vault-armonia-brad")
    expect(r.stderr).toContain("names the workspace")
    expect(existsSync(join(fx.root, "vault-armonia-brad"))).toBe(false)
    expect(existsSync(fx.root)).toBe(false)
    expect(ghCalls()).toBe("")
    expect(netCalls()).toBe("")
  })

  it("refuses 'armonia' in embedded position too", () => {
    const r = init(["jane-armonia-doe", "--root", fx.root], { AMICO_FORCE_DEGRADED: "1" })
    expect(r.status).not.toBe(0)
    expect(r.stderr).toContain("vault-jane-armonia-doe")
    expect(existsSync(join(fx.root, "vault-jane-armonia-doe"))).toBe(false)
  })
})

// ── AC3: the degraded mint ──────────────────────────────────────────────────
describe("degraded mint (no template)", () => {
  it("creates the standard folders, a readme, a local-only marker, and exactly one commit", () => {
    const r = init(["jane", "--root", fx.root], { AMICO_FORCE_DEGRADED: "1" })
    expect(r.status).toBe(0)
    const dir = join(fx.root, "vault-jane")
    for (const f of FOLDERS) expect(existsSync(join(dir, f, ".gitkeep"))).toBe(true)
    expect(existsSync(join(dir, "README.md"))).toBe(true)
    expect(marker(dir)).toContain('provision_state = "local-only"')
    expect(marker(dir)).toContain('name = "vault-jane"')
    expect(marker(dir)).toContain('kind = "personal"')
    expect(commitCount(dir)).toBe(1)
    expect(r.stdout).toContain("armonia-init jane --root") // the printed resume command
  })
})

// ── AC5: root-state contract ────────────────────────────────────────────────
describe("root-state contract", () => {
  const enforce = () => ({ AMICO_ENFORCE_ROOT_CONTRACT: "1", AMICO_CANONICAL_VAULTS_DATA: fx.canon, AMICO_FORCE_DEGRADED: "1" })

  it("refuses a non-empty real-directory root with the migration pointer, creating nothing", () => {
    mkdirSync(fx.root)
    writeFileSync(join(fx.root, "stray"), "x")
    const r = init(["carol", "--root", fx.root], enforce())
    expect(r.status).not.toBe(0)
    expect(r.stderr.toLowerCase()).toContain("migration")
    expect(readdirSync(fx.root)).toEqual(["stray"])
    expect(existsSync(fx.canon)).toBe(false)
  })

  it("refuses a symlink to the wrong target, never re-pointing it", () => {
    const elsewhere = join(fx.tmp, "elsewhere")
    mkdirSync(elsewhere)
    symlinkSync(elsewhere, fx.root)
    const r = init(["dana", "--root", fx.root], enforce())
    expect(r.status).not.toBe(0)
    expect(r.stderr.toLowerCase()).toContain("migration")
    expect(readlinkSync(fx.root)).toBe(elsewhere)
    expect(readdirSync(elsewhere)).toEqual([])
  })

  it("adopts an empty real directory: replaced by a symlink to the canonical storage", () => {
    mkdirSync(fx.root)
    const r = init(["barbara", "--root", fx.root], enforce())
    expect(r.status).toBe(0)
    expect(lstatSync(fx.root).isSymbolicLink()).toBe(true)
    expect(readlinkSync(fx.root)).toBe(fx.canon)
    expect(existsSync(join(fx.canon, "vault-barbara", ".amico-vault.toml"))).toBe(true)
    expect(ghCalls()).toBe("")
  })
})

// ── AC6: re-run against a fully provisioned vault ───────────────────────────
describe("fully provisioned vault", () => {
  it("re-run exits non-zero with the documented message and changes nothing", () => {
    const template = makeTemplate()
    // --no-github + a local template mints a "provisioned" vault, offline
    expect(init(["jane", "--no-github", "--root", fx.root], { AMICO_TEMPLATE_PATH: template }).status).toBe(0)
    const dir = join(fx.root, "vault-jane")
    expect(marker(dir)).toContain('provision_state = "provisioned"')
    const head = execFileSync(REAL_GIT, ["-C", dir, "rev-parse", "HEAD"], { encoding: "utf8" })
    const status = execFileSync(REAL_GIT, ["-C", dir, "status", "--porcelain"], { encoding: "utf8" })

    const r = init(["jane", "--no-github", "--root", fx.root], { AMICO_TEMPLATE_PATH: template })
    expect(r.status).toBe(64)
    expect(r.stderr).toContain(`${dir} already exists`)
    expect(execFileSync(REAL_GIT, ["-C", dir, "rev-parse", "HEAD"], { encoding: "utf8" })).toBe(head)
    expect(execFileSync(REAL_GIT, ["-C", dir, "status", "--porcelain"], { encoding: "utf8" })).toBe(status)
    expect(marker(dir)).toContain('provision_state = "provisioned"')
    expect(ghCalls()).toBe("")
    expect(netCalls()).toBe("")
  })
})

// ── AC7: the fallback hint for an un-cloneable shared vault ─────────────────
describe("shared-vault fallback message", () => {
  it("prints a well-formed clone address when armonissima cannot be cloned", () => {
    // gate OPEN against a stand-in gh that says yes to everything; the stand-in
    // git simulates the member vault clone locally and refuses the shared ones
    const r = init(["jane", "--root", fx.root], { STUB_GH_EXIT: "0", STUB_CLONE_SIM: "1" })
    expect(r.status).toBe(0)
    const hint = r.stdout.split("\n").find((l) => l.includes("could not clone armonissima"))
    expect(hint).toBeDefined()
    expect(hint).toContain(`git clone git@github.com:harmoniqs/armonissima.git ${join(fx.root, "armonissima")}`)
    expect(hint).not.toContain("git@github.com:harmonissima")
  })
})

// ── AC8: --override ─────────────────────────────────────────────────────────
describe("--override", () => {
  it("proceeds past the lint and stamps the sanctioned-exception note exactly once", () => {
    const env = { AMICO_FORCE_DEGRADED: "1" }
    const r = init(["armonia-legacy", "--override", "--root", fx.root], env)
    expect(r.status).toBe(0)
    const readme = readFileSync(join(fx.root, "vault-armonia-legacy", "README.md"), "utf8")
    expect(readme.match(/sanctioned exception/gi)).toHaveLength(2) // heading + body sentence
    expect(readme.match(/## Naming note — sanctioned exception/g)).toHaveLength(1)
    expect(readme.toLowerCase()).not.toContain("deviation")

    // a resume re-run must not stamp a second time
    expect(init(["armonia-legacy", "--override", "--root", fx.root], env).status).toBe(0)
    const again = readFileSync(join(fx.root, "vault-armonia-legacy", "README.md"), "utf8")
    expect(again.match(/## Naming note — sanctioned exception/g)).toHaveLength(1)
  })
})

// ── Credentialed behavior is unchanged where the gate is open ───────────────
describe("gate open (credentials present)", () => {
  it("fresh mint: consults gh, clones the member vault, then tries the shared vaults", () => {
    const r = init(["jane", "--root", fx.root], { STUB_GH_EXIT: "0", STUB_CLONE_SIM: "1" })
    expect(r.status).toBe(0)
    expect(ghCalls()).toContain("auth status")
    expect(ghCalls()).toContain("repo view harmoniqs/vault-jane")
    const net = netCalls()
    expect(net).toContain("clone git@github.com:harmoniqs/vault-jane.git")
    expect(net).toContain("clone git@github.com:harmoniqs/armonissima.git")
    expect(net).toContain("clone -q git@github.com:harmoniqs/armonia-issimo.git")
  })

  it("resume of a local-only vault consults gh and attempts the push", () => {
    expect(init(["jane", "--root", fx.root], { AMICO_FORCE_DEGRADED: "1" }).status).toBe(0)
    const r = init(["jane", "--root", fx.root], { STUB_GH_EXIT: "0" })
    expect(r.status).toBe(0)
    expect(ghCalls()).toContain("repo view harmoniqs/vault-jane")
    expect(netCalls()).toContain("push")
    // the stand-in refused the push → honestly reverted to local-only
    expect(r.stderr).toContain("push failed")
    expect(marker(join(fx.root, "vault-jane"))).toContain('provision_state = "local-only"')
  })
})
