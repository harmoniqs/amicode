// Nightly role-parity pin cadence (amicode#806, obligation O8) — the
// orchestrator's contract, exercised on fixture pin records and fixture
// vault repos (hermetic: temp git repos, never the real amicissimo
// checkout, never the network).
//
// --dry-run is the testable seam for the drift/issue path: it runs the REAL
// check CLI (scripts/role_parity_check.mts) and prints WOULD-DO lines to
// stderr, but appends NO receipt and touches NO issues. The receipt-append
// behavior is covered by the REAL-run cells (fetch-failure unknown and the
// check-failed receipt — neither takes the issue path); the GitHub-issue
// path runs only on real drift outside --dry-run and is verified by the
// documented manual run on the vault-visible machine (the skill-freshness
// precedent).
//
// Review B1 (PR #811): the shipped pin record is pending-signature — the
// full-definition fixtures are deliberately absent, and the cells mirror
// that state; one published-mode pair exercises the post-signature fixture
// integrity path. Review B2: the wrapper fetches the ref's remote before
// the freshness compare — the fetch-discovery cell proves a remote drift is
// invisible without the fetch and caught with it, and a fetch failure is a
// named unknown receipt, never green.
//
// Gating: the orchestrator execs the .mts check through `node`, which needs
// native TS type-stripping (node >= 22.6, enableable via NODE_OPTIONS — the
// wrapper's internal `node` calls inherit it). Probed by capability, not by
// this process's own flags (vitest's node doesn't carry them); the suite
// skips cleanly on older node.
import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";

const STRIP_PROBE = spawnSync(
  process.execPath,
  ["-e", 'process.stdout.write(process.features.typescript === "strip" ? "yes" : "no")'],
  { encoding: "utf8", env: { ...process.env, NODE_OPTIONS: "--experimental-strip-types" } },
);
const NODE_STRIPS_TYPES = STRIP_PROBE.status === 0 && STRIP_PROBE.stdout.trim() === "yes";
(NODE_STRIPS_TYPES ? describe : describe.skip)("role-parity orchestrator (fixtures)", () => {
  const EXT_ROOT = path.resolve(__dirname, "..", "..");
  const OPS_SCRIPT = path.resolve(EXT_ROOT, "..", "..", "ops", "role-parity", "run-role-parity-check.sh");
  const CHECK_CLI = path.join(EXT_ROOT, "scripts", "role_parity_check.mts");
  const REAL_PIN = path.join(EXT_ROOT, "test", "fixtures", "vault-agents", "pin.json");

  const tmpDirs: string[] = [];
  function tmpRoot(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "role-parity-"));
    tmpDirs.push(dir);
    return dir;
  }
  afterEach(() => {
    for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  const sha256 = (p: string): string =>
    "sha256:" + createHash("sha256").update(fs.readFileSync(p)).digest("hex");

  /** git with a stable identity (fixture repos never need real config). */
  function git(dir: string, args: string[], env: Record<string, string> = {}): string {
    const r = spawnSync("git", ["-C", dir, ...args], { encoding: "utf8", env: { ...process.env, ...env } });
    if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
    return String(r.stdout ?? "");
  }
  const GIT_ID = {
    GIT_AUTHOR_NAME: "fixture",
    GIT_AUTHOR_EMAIL: "fixture@example.test",
    GIT_COMMITTER_NAME: "fixture",
    GIT_COMMITTER_EMAIL: "fixture@example.test",
  };

  const DEFINITION_AT_PIN = [
    "# Engineer Agent (fixture definition)",
    "",
    "The engine-neutral engineer: works on branches, never deletes tests,",
    "delegates to the implement-issue leaf in develop mode.",
    "",
  ].join("\n");

  interface WorldOpts {
    /** "pending-signature" (the shipped B1 hold: NO fixture files) or
     *  "published" (the post-signature shape: fixture files + paths). */
    publication?: "published" | "pending-signature";
  }

  /** A fixture world: a v2 pin record + a vault git repo whose main
   *  carries the definitions at the pinned revision. */
  function fixtureWorld(over: WorldOpts = {}): {
    root: string;
    pinPath: string;
    vault: string;
    definitionPath: string;
    pinnedRevision: string;
  } {
    const publication = over.publication ?? "pending-signature";
    const root = tmpRoot();
    const vault = path.join(root, "amicissimo");
    const definitionPath = path.join(vault, "vault", "agents", "engineer.md");
    fs.mkdirSync(path.join(vault, "vault", "agents"), { recursive: true });
    fs.writeFileSync(definitionPath, DEFINITION_AT_PIN);
    if (publication === "published") {
      fs.mkdirSync(path.join(root, "fixtures"), { recursive: true });
      fs.writeFileSync(path.join(root, "fixtures", "engineer.md"), DEFINITION_AT_PIN);
    }
    git(vault, ["init", "-b", "main"]);
    git(vault, ["add", "-A"]);
    git(vault, ["-c", "user.name=fixture", "-c", "user.email=fixture@example.test", "commit", "-m", "definitions"], GIT_ID);
    const pinnedRevision = git(vault, ["rev-parse", "HEAD"]).trim();
    // the v2 pin record: the revision + digests AT the revision (provenance
    // without content); fixture paths only when published
    fs.writeFileSync(
      path.join(root, "pin.json"),
      JSON.stringify(
        {
          record_version: 2,
          vault_repo: "harmoniqs/amicissimo",
          vault_revision: pinnedRevision,
          fixture_publication: publication,
          pinned: [
            publication === "published"
              ? {
                  role_card: "implementer",
                  vault_path: "vault/agents/engineer.md",
                  fixture: "fixtures/engineer.md",
                  sha256: sha256(path.join(root, "fixtures", "engineer.md")),
                }
              : {
                  role_card: "implementer",
                  vault_path: "vault/agents/engineer.md",
                  sha256: sha256(definitionPath),
                },
          ],
        },
        null,
        2,
      ) + "\n",
    );
    return { root, pinPath: path.join(root, "pin.json"), vault, definitionPath, pinnedRevision };
  }

  function runWrapper(
    args: string[],
    root: string,
    pinPath: string,
    vault: string,
    extra: Record<string, string> = {},
  ) {
    return spawnSync("/bin/bash", [OPS_SCRIPT, ...args], {
      encoding: "utf8",
      env: {
        ...process.env,
        ROLE_PARITY_CHECK: CHECK_CLI,
        ROLE_PARITY_PIN: pinPath,
        ROLE_PARITY_VAULT: vault,
        ROLE_PARITY_REF: "main", // fixture repos have no origin (local ref)
        ROLE_PARITY_RECEIPTS: path.join(root, "receipts", "upgrade-receipts.jsonl"),
        ROLE_PARITY_TRACKING_REPO: "harmoniqs/amicode",
        ...extra,
      },
    });
  }

  const runDryRun = (root: string, pinPath: string, vault: string, extra: Record<string, string> = {}) =>
    runWrapper(["--dry-run"], root, pinPath, vault, extra);
  const runReal = (root: string, pinPath: string, vault: string, extra: Record<string, string> = {}) =>
    runWrapper([], root, pinPath, vault, extra);

  const receipts = (root: string): Array<Record<string, unknown>> =>
    fs
      .readFileSync(path.join(root, "receipts", "upgrade-receipts.jsonl"), "utf8")
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l) as Record<string, unknown>);

  it("current (pending-signature hold): status current, the B1 hold named in evidence, WOULD-DO nothing, no receipt", () => {
    const w = fixtureWorld();
    const r = runDryRun(w.root, w.pinPath, w.vault);
    expect(r.status).toBe(0);
    expect(r.stderr).toMatch(/status=current/);
    expect(r.stderr).toMatch(/publication=pending-signature/);
    expect(r.stderr).toMatch(/fixture publications held pending the seed-gate signature/);
    expect(r.stderr).toMatch(/WOULD-DO: no issue action/);
    expect(fs.existsSync(path.join(w.root, "receipts"))).toBe(false);
  });

  it("drift: a pinned definition changed past the pin → exit 1, behind-head, the file named, WOULD-DO the chore issue", () => {
    const w = fixtureWorld();
    fs.writeFileSync(w.definitionPath, DEFINITION_AT_PIN + "\n(Amended engine-neutral semantics.)\n");
    git(w.vault, ["add", "-A"]);
    git(w.vault, ["-c", "user.name=fixture", "-c", "user.email=fixture@example.test", "commit", "-m", "amend definitions"], GIT_ID);
    const r = runDryRun(w.root, w.pinPath, w.vault);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/status=behind-head/);
    expect(r.stderr).toContain("vault/agents/engineer.md");
    expect(r.stderr).toMatch(/WOULD-DO: open-or-update chore issue 'Role-card parity pin behind the vault \(nightly\)'/);
    expect(fs.existsSync(path.join(w.root, "receipts"))).toBe(false);
  });

  it("revision churn WITHOUT touching a pinned definition → exit 0 (low-noise: the pin's content is what drift means)", () => {
    const w = fixtureWorld();
    fs.writeFileSync(path.join(w.vault, "vault", "unrelated.md"), "churn\n");
    git(w.vault, ["add", "-A"]);
    git(w.vault, ["-c", "user.name=fixture", "-c", "user.email=fixture@example.test", "commit", "-m", "unrelated churn"], GIT_ID);
    const r = runDryRun(w.root, w.pinPath, w.vault);
    expect(r.status).toBe(0);
    expect(r.stderr).toMatch(/no pinned definition changed/);
  });

  it("pin orphaned: the pinned revision absent from the vault's history → exit 1, pin-orphaned named", () => {
    const w = fixtureWorld();
    // a DIFFERENT vault repo that never carried the pinned revision
    const otherVault = path.join(w.root, "other-amicissimo");
    fs.mkdirSync(path.join(otherVault, "vault", "agents"), { recursive: true });
    fs.writeFileSync(path.join(otherVault, "vault", "agents", "engineer.md"), "different history\n");
    git(otherVault, ["init", "-b", "main"]);
    git(otherVault, ["add", "-A"]);
    git(otherVault, ["-c", "user.name=fixture", "-c", "user.email=fixture@example.test", "commit", "-m", "other"], GIT_ID);
    const r = runDryRun(w.root, w.pinPath, otherVault);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/status=pin-orphaned/);
  });

  it("vault absent: an honest named skip → exit 0 (a pin is only loud where something can run)", () => {
    const w = fixtureWorld();
    const r = runDryRun(w.root, w.pinPath, path.join(w.root, "no-such-vault"));
    expect(r.status).toBe(0);
    expect(r.stderr).toMatch(/status=vault-absent/);
    expect(r.stderr).toMatch(/cannot be checked on this machine/);
  });

  it("published mode (post-signature shape): fixtures byte-match → integrity green; a tampered fixture → exit 1 fixture-mismatch named", () => {
    const w = fixtureWorld({ publication: "published" });
    const clean = runDryRun(w.root, w.pinPath, w.vault);
    expect(clean.status).toBe(0);
    expect(clean.stderr).toMatch(/publication=published/);
    expect(clean.stderr).toMatch(/fixture fixtures\/engineer\.md byte-matches its recorded digest/);

    fs.writeFileSync(path.join(w.root, "fixtures", "engineer.md"), DEFINITION_AT_PIN + "\n(drifted fixture bytes)\n");
    const r = runDryRun(w.root, w.pinPath, w.vault);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/status=fixture-mismatch/);
    expect(r.stderr).toMatch(/drifted from its recorded digest/);
  });

  it("the REAL committed pin record: pending-signature pre-flight green, the B1 hold named, honest vault-absent skip (hermetic)", () => {
    const root = tmpRoot();
    const r = spawnSync("/bin/bash", [OPS_SCRIPT, "--dry-run"], {
      encoding: "utf8",
      env: {
        ...process.env,
        ROLE_PARITY_CHECK: CHECK_CLI,
        ROLE_PARITY_PIN: REAL_PIN,
        ROLE_PARITY_VAULT: path.join(root, "no-such-vault"),
        ROLE_PARITY_REF: "origin/main",
        ROLE_PARITY_RECEIPTS: path.join(root, "receipts", "upgrade-receipts.jsonl"),
        ROLE_PARITY_TRACKING_REPO: "harmoniqs/amicode",
      },
    });
    expect(r.status).toBe(0);
    expect(r.stderr).toMatch(/status=vault-absent/);
    // the real record is the shipped pending-signature state: the hold is
    // named, nothing published-verbatim
    expect(r.stderr).toMatch(/publication=pending-signature/);
    expect(r.stderr).toMatch(/fixture publications held pending the seed-gate signature/);
  });

  // B2 — the fetch: a remote drift is INVISIBLE without the fetch and CAUGHT
  // with it (the wrapper passes --fetch; the stale-local control proves the
  // fetch is load-bearing, not decorative)
  it("B2 fetch discovery: a drifted vault REMOTE reads behind-head through the wrapper's --fetch; without the fetch the stale local ref would lie current", () => {
    const w = fixtureWorld();
    // give the vault an origin: a bare remote, with the drift landing ONLY
    // on the remote (the local checkout stays at the pinned revision)
    const bare = path.join(w.root, "amicissimo.git");
    spawnSync("git", ["init", "--bare", "-b", "main", bare], { encoding: "utf8" });
    git(w.vault, ["remote", "add", "origin", bare]);
    git(w.vault, ["push", "-u", "origin", "main"]);
    const clone = path.join(w.root, "drift-clone");
    spawnSync("git", ["clone", "--branch", "main", bare, clone], { encoding: "utf8" });
    fs.writeFileSync(path.join(clone, "vault", "agents", "engineer.md"), DEFINITION_AT_PIN + "\n(Remote-only amendment.)\n");
    git(clone, ["add", "-A"]);
    git(clone, ["-c", "user.name=fixture", "-c", "user.email=fixture@example.test", "commit", "-m", "remote drift"], GIT_ID);
    git(clone, ["push", "origin", "main"]);

    // control: the CLI WITHOUT --fetch compares against the stale local
    // origin/main and reads current — the lie the fetch exists to prevent
    const noFetch = spawnSync(process.execPath, [
      "--experimental-strip-types", CHECK_CLI,
      "--pin", w.pinPath, "--vault", w.vault, "--ref", "origin/main",
    ], { encoding: "utf8" });
    expect(noFetch.status).toBe(0);
    expect(JSON.parse(noFetch.stdout).status).toBe("current");

    // the wrapper (--fetch wired): the remote drift is discovered
    const r = runDryRun(w.root, w.pinPath, w.vault, { ROLE_PARITY_REF: "origin/main" });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/status=behind-head/);
    expect(r.stderr).toMatch(/fetched origin before the freshness compare/);
  });

  // B2 — a fetch failure is a named unknown receipt, never green
  it("B2 fetch failure: an unreachable remote → status vault-unfetchable, exit 0, and the REAL receipt carries the named unknown (never green)", () => {
    const w = fixtureWorld();
    // a remote that cannot be fetched: a bogus URL
    git(w.vault, ["remote", "add", "origin", "https://no-such-host.example.invalid/amicissimo.git"]);
    const r = runReal(w.root, w.pinPath, w.vault, { ROLE_PARITY_REF: "origin/main" });
    expect(r.status).toBe(0);
    expect(r.stderr).toMatch(/status=vault-unfetchable/);
    expect(r.stderr).toMatch(/never a green verdict/);
    const lines = receipts(w.root);
    expect(lines).toHaveLength(1);
    expect(lines[0]!.status).toBe("vault-unfetchable");
    expect(lines[0]!.fixture_publication).toBe("pending-signature");
  });

  // B2 nit — a CLI exit 2 (pre-flight/runtime failure) appends a NAMED
  // check-failed receipt, never a malformed `"status":""` line
  it("B2 check-failed receipt: a broken pin record → exit 2, the receipt names check-failed (no empty status, no issue action)", () => {
    const w = fixtureWorld();
    fs.writeFileSync(w.pinPath, "{ not json");
    const r = runReal(w.root, w.pinPath, w.vault);
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/check FAILED/);
    const lines = receipts(w.root);
    expect(lines).toHaveLength(1);
    expect(lines[0]!.status).toBe("check-failed");
    expect(String(lines[0]!.status).length).toBeGreaterThan(0);
    expect(lines[0]!.check_exit).toBe(2);
    expect(lines[0]!.tracking_issue).toBeUndefined();
  });
});
