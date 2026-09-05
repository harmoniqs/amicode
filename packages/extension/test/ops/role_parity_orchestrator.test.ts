// Nightly role-parity pin cadence (amicode#806, obligation O8) — the
// orchestrator's DRY-RUN contract, exercised on fixture pin records and
// fixture vault repos (hermetic: temp git repos, never the real amicissimo
// checkout, never the network).
//
// --dry-run is the testable seam by design: it runs the REAL check CLI
// (scripts/role_parity_check.mts) and prints WOULD-DO lines to stderr, but
// appends NO receipt and touches NO issues. The receipt-append and
// GitHub-issue paths run only outside --dry-run and are verified by the
// documented manual run on the vault-visible machine (the skill-freshness
// precedent).
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
(NODE_STRIPS_TYPES ? describe : describe.skip)("role-parity orchestrator (--dry-run, fixtures)", () => {
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
  function git(dir: string, args: string[]): void {
    const r = spawnSync("git", ["-C", dir, ...args], { encoding: "utf8" });
    if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
  }

  const DEFINITION_AT_PIN = [
    "# Engineer Agent (fixture definition)",
    "",
    "The engine-neutral engineer: works on branches, never deletes tests,",
    "delegates to the implement-issue leaf in develop mode.",
    "",
  ].join("\n");

  /** A fixture world: a pin record + fixtures dir + a vault git repo whose
   *  main carries the definitions at the pinned revision. */
  function fixtureWorld(over: { definitionAtPin?: string } = {}): {
    root: string;
    pinPath: string;
    vault: string;
    pinnedRevision: string;
  } {
    const root = tmpRoot();
    const vault = path.join(root, "amicissimo");
    fs.mkdirSync(path.join(vault, "vault", "agents"), { recursive: true });
    const definition = over.definitionAtPin ?? DEFINITION_AT_PIN;
    fs.writeFileSync(path.join(vault, "vault", "agents", "engineer.md"), definition);
    fs.mkdirSync(path.join(root, "fixtures"), { recursive: true });
    fs.writeFileSync(path.join(root, "fixtures", "engineer.md"), definition);
    git(vault, ["init", "-b", "main"]);
    git(vault, ["add", "-A"]);
    git(vault, ["-c", "user.name=fixture", "-c", "user.email=fixture@example.test", "commit", "-m", "definitions"]);
    const rev = spawnSync("git", ["-C", vault, "rev-parse", "HEAD"], { encoding: "utf8" });
    const pinnedRevision = rev.stdout.trim();
    // the pin record: the fixture carries the vault revision it pinned
    fs.writeFileSync(
      path.join(root, "pin.json"),
      JSON.stringify(
        {
          record_version: 1,
          vault_repo: "harmoniqs/amicissimo",
          vault_revision: pinnedRevision,
          pinned: [
            {
              role_card: "implementer",
              vault_path: "vault/agents/engineer.md",
              fixture: "fixtures/engineer.md",
              sha256: sha256(path.join(root, "fixtures", "engineer.md")),
            },
          ],
        },
        null,
        2,
      ) + "\n",
    );
    return { root, pinPath: path.join(root, "pin.json"), vault, pinnedRevision };
  }

  function runDryRun(env: Record<string, string>) {
    return spawnSync("/bin/bash", [OPS_SCRIPT, "--dry-run"], {
      encoding: "utf8",
      env: { ...process.env, ...env },
    });
  }

  function wrapperEnv(root: string, pinPath: string, vault: string, extra: Record<string, string> = {}): Record<string, string> {
    return {
      ROLE_PARITY_CHECK: CHECK_CLI,
      ROLE_PARITY_PIN: pinPath,
      ROLE_PARITY_VAULT: vault,
      ROLE_PARITY_REF: "main", // fixture repos have no origin
      ROLE_PARITY_RECEIPTS: path.join(root, "receipts", "upgrade-receipts.jsonl"),
      ROLE_PARITY_TRACKING_REPO: "harmoniqs/amicode",
      ...extra,
    };
  }

  it("current: pinned definitions unchanged → exit 0, status current, WOULD-DO no issue action, no receipt", () => {
    const w = fixtureWorld();
    const r = runDryRun(wrapperEnv(w.root, w.pinPath, w.vault));
    expect(r.status).toBe(0);
    expect(r.stderr).toMatch(/status=current/);
    expect(r.stderr).toMatch(/WOULD-DO: no issue action/);
    expect(r.stderr).toMatch(/the pinned CONTENT is still current|pin is current/);
    expect(fs.existsSync(path.join(w.root, "receipts"))).toBe(false);
  });

  it("drift: a pinned definition changed past the pin → exit 1, behind-head, the file named, WOULD-DO the chore issue", () => {
    const w = fixtureWorld();
    fs.writeFileSync(
      path.join(w.vault, "vault", "agents", "engineer.md"),
      DEFINITION_AT_PIN + "\n(Amended engine-neutral semantics.)\n",
    );
    git(w.vault, ["add", "-A"]);
    git(w.vault, ["-c", "user.name=fixture", "-c", "user.email=fixture@example.test", "commit", "-m", "amend definitions"]);
    const r = runDryRun(wrapperEnv(w.root, w.pinPath, w.vault));
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
    git(w.vault, ["-c", "user.name=fixture", "-c", "user.email=fixture@example.test", "commit", "-m", "unrelated churn"]);
    const r = runDryRun(wrapperEnv(w.root, w.pinPath, w.vault));
    expect(r.status).toBe(0);
    expect(r.stderr).toMatch(/no pinned definition changed/);
  });

  it("fixture mismatch: a committed fixture no longer matches its record → exit 1, fixture-mismatch named", () => {
    const w = fixtureWorld();
    fs.writeFileSync(path.join(w.root, "fixtures", "engineer.md"), DEFINITION_AT_PIN + "\n(drifted fixture bytes)\n");
    const r = runDryRun(wrapperEnv(w.root, w.pinPath, w.vault));
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/status=fixture-mismatch/);
    expect(r.stderr).toMatch(/drifted from its recorded digest/);
  });

  it("pin orphaned: the pinned revision absent from the vault's history → exit 1, pin-orphaned named", () => {
    const w = fixtureWorld();
    // a DIFFERENT vault repo that never carried the pinned revision
    const otherVault = path.join(w.root, "other-amicissimo");
    fs.mkdirSync(path.join(otherVault, "vault", "agents"), { recursive: true });
    fs.writeFileSync(path.join(otherVault, "vault", "agents", "engineer.md"), "different history\n");
    git(otherVault, ["init", "-b", "main"]);
    git(otherVault, ["add", "-A"]);
    git(otherVault, ["-c", "user.name=fixture", "-c", "user.email=fixture@example.test", "commit", "-m", "other"]);
    const r = runDryRun(wrapperEnv(w.root, w.pinPath, otherVault));
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/status=pin-orphaned/);
  });

  it("vault absent: an honest named skip → exit 0 (a pin is only loud where something can run)", () => {
    const w = fixtureWorld();
    const r = runDryRun(wrapperEnv(w.root, w.pinPath, path.join(w.root, "no-such-vault")));
    expect(r.status).toBe(0);
    expect(r.stderr).toMatch(/status=vault-absent/);
    expect(r.stderr).toMatch(/cannot be checked on this machine/);
  });

  it("the REAL committed pin record passes pre-flight + fixture integrity through the CLI (vault absent → honest skip)", () => {
    // the real pin.json + committed fixtures (test/fixtures/vault-agents)
    // must be well-formed for the cadence to even run — this cell runs the
    // actual record, hermetically (no vault checkout needed for integrity).
    const root = tmpRoot();
    const r = runDryRun({
      ROLE_PARITY_CHECK: CHECK_CLI,
      ROLE_PARITY_PIN: REAL_PIN,
      ROLE_PARITY_VAULT: path.join(root, "no-such-vault"),
      ROLE_PARITY_RECEIPTS: path.join(root, "receipts", "upgrade-receipts.jsonl"),
    });
    expect(r.status).toBe(0);
    expect(r.stderr).toMatch(/status=vault-absent/);
    // fixture integrity over the real fixtures: every line green
    expect(r.stderr).toMatch(/fixture engineer\.md byte-matches its recorded digest/);
    expect(r.stderr).toMatch(/fixture experimenter\.md byte-matches its recorded digest/);
  });
});
