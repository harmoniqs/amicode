// upgrade-agents.test.ts — the `amico upgrade agents` verb (#526, spec D2):
// wraps deploy-agents.mjs against the two agent-card destinations and writes
// BOTH receipt stores — the contract-path .deploy-receipt.json (doctor's
// freshness input) and the upgrade-receipts JSONL. Hermetic: temp roots, the
// REAL deploy-agents.mjs copied into the fixture amicode checkout (so its
// SOURCE_DIR resolves inside the fixture, never the real repo).
import { describe, test, expect } from "vitest";
import { readFileSync, writeFileSync, rmSync, copyFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { surfaceInventory, dirDigest, fileSha, type SurfaceRecord } from "../src/surfaces.js";
import { upgradeVerb } from "../src/upgrade.js";
import { buildDoctorWorld, ctxForWorld, cleanupTracked, type DoctorWorld } from "./helpers.js";

const cleanup = cleanupTracked;

// the REAL script, copied into the fixture checkout — the verb runs the
// checkout's copy (that is the live contract: the script ships in the repo)
const REAL_SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "scripts", "deploy-agents.mjs");

function stageAgentsWorld(): DoctorWorld {
  const w = buildDoctorWorld();
  mkdirSync(join(w.repoAmicode, "scripts"), { recursive: true });
  copyFileSync(REAL_SCRIPT, join(w.repoAmicode, "scripts", "deploy-agents.mjs"));
  // stage stale: tamper one GLOBAL deployed card (per-card digest drift)
  writeFileSync(join(w.config, "agents", "autodev.md"), "---\nmode: autodev\n---\n# TAMPERED\n");
  return w;
}

function verbArgs(w: DoctorWorld, extra: string[] = []): string[] {
  return [
    "agents",
    "--root-server", w.server,
    "--root-vscext", w.vscext,
    "--root-config", w.config,
    "--root-repo-amicode", w.repoAmicode,
    "--root-repo-fork", w.repoFork,
    "--root-staging", w.staging,
    ...extra,
  ];
}

const receiptsDir = (w: DoctorWorld): string => join(w.server, "upgrade-receipts");
const lastReceipt = (w: DoctorWorld): Record<string, unknown> => {
  const lines = readFileSync(receiptsDir(w) + "/upgrade-receipts.jsonl", "utf8")
    .split("\n")
    .filter((l) => l.trim());
  expect(lines.length).toBeGreaterThan(0);
  return JSON.parse(lines[lines.length - 1]);
};
const bySurface = (records: SurfaceRecord[], name: string): SurfaceRecord =>
  records.find((r) => r.surface === name)!;

describe("upgrade agents — stale deployment", () => {
  test("tampered global card → upgraded: BOTH receipt stores written, both surfaces converged", async () => {
    const w = stageAgentsWorld();
    const r = await upgradeVerb(verbArgs(w, ["--root-receipts", receiptsDir(w)]));
    expect(r.code).toBe(0);
    const receipt = r.json as Record<string, unknown>;
    expect(receipt.outcome).toBe("upgraded");
    expect(receipt.verification).toBe(true);
    expect(receipt.verb).toBe("agents");

    // pre: global stale (tampered), staging current — post: BOTH current
    const pre = receipt.pre as SurfaceRecord[];
    expect(bySurface(pre, "agent-cards-global").verdict).toBe("stale");
    expect(bySurface(pre, "agent-cards-staging").verdict).toBe("current");
    const post = receipt.post as SurfaceRecord[];
    expect(bySurface(post, "agent-cards-global").verdict).toBe("current");
    expect(bySurface(post, "agent-cards-staging").verdict).toBe("current");

    // BOTH receipt stores: the contract-path receipt (fresh, digests match sources)…
    const contractPath = join(w.repoAmicode, "packages", "extension", "agents", ".deploy-receipt.json");
    expect(existsSync(contractPath)).toBe(true);
    const contract = JSON.parse(readFileSync(contractPath, "utf8")) as {
      deployed_at: string;
      sources: { card: string; sha256: string }[];
    };
    expect(contract.deployed_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    for (const s of contract.sources) {
      expect(s.sha256).toBe(`sha256:${await fileSha(join(w.repoAmicode, "packages", "extension", "agents", s.card))}`);
    }
    // …and the JSONL store (same outcome)
    expect(lastReceipt(w).outcome).toBe("upgraded");

    // the tampered card was actually repaired from source
    const repaired = readFileSync(join(w.config, "agents", "autodev.md"), "utf8");
    const source = readFileSync(join(w.repoAmicode, "packages", "extension", "agents", "autodev.md"), "utf8");
    expect(repaired).toBe(source);
    cleanup();
  });

  test("verification independence: receipt.post equals an independent doctor re-run (both records)", async () => {
    const w = stageAgentsWorld();
    await upgradeVerb(verbArgs(w, ["--root-receipts", receiptsDir(w)]));
    const receipt = lastReceipt(w) as { post: SurfaceRecord[] };
    const independent = await surfaceInventory(ctxForWorld(w));
    expect(receipt.post).toEqual([
      bySurface(independent.surfaces, "agent-cards-global"),
      bySurface(independent.surfaces, "agent-cards-staging"),
    ]);
    cleanup();
  });
});

describe("upgrade agents — idempotence (the AC fixture)", () => {
  test("run 2: exit 0 no-op; both agent dirs + the .deploy-receipt.json byte-unchanged", async () => {
    const w = stageAgentsWorld();
    const args = verbArgs(w, ["--root-receipts", receiptsDir(w)]);

    const run1 = await upgradeVerb(args);
    expect(run1.code).toBe(0);
    expect((run1.json as Record<string, unknown>).outcome).toBe("upgraded");

    // the ENUMERATED digest set: both agent dirs + the contract receipt
    const digestSet = async (): Promise<string> => {
      const g = await dirDigest(join(w.config, "agents"));
      const s = await dirDigest(join(w.staging, ".opencode", "agents"));
      const rc = await fileSha(join(w.repoAmicode, "packages", "extension", "agents", ".deploy-receipt.json"));
      return `${g}/${s}/${rc}`;
    };
    const after1 = await digestSet();

    const run2 = await upgradeVerb(args);
    expect(run2.code).toBe(0);
    const receipt2 = run2.json as Record<string, unknown>;
    expect(receipt2.outcome).toBe("no-op");
    expect(receipt2.verification).toBe(true);

    // run 2 did NOT re-run deploy-agents.mjs (its receipt timestamp would move)
    expect(await digestSet()).toBe(after1);
    expect(lastReceipt(w).outcome).toBe("no-op");
    cleanup();
  });
});

describe("upgrade agents — mode-bundle convergence (#804)", () => {
  test("a tampered deployed bundle component → pre-flight stale (component named) → verb converges BOTH roots → post current", async () => {
    const w = buildDoctorWorld();
    mkdirSync(join(w.repoAmicode, "scripts"), { recursive: true });
    copyFileSync(REAL_SCRIPT, join(w.repoAmicode, "scripts", "deploy-agents.mjs"));
    // stage stale: tamper the GLOBAL deployed bundle pack (component drift —
    // the doctor names the component; the card digests alone stay clean)
    writeFileSync(join(w.config, "modes", "autodev", "pack.toml"), "# TAMPERED PACK\n");

    const pre = await surfaceInventory(ctxForWorld(w));
    const preGlobal = pre.surfaces.find((r) => r.surface === "agent-cards-global")!;
    expect(preGlobal.verdict).toBe("stale");
    const named = (preGlobal.components ?? []).find(
      (c) => c.mode === "autodev" && c.component === "pack.toml",
    );
    expect(named, "the offending component is named in the pre-flight record").toBeDefined();

    const r = await upgradeVerb(verbArgs(w, ["--root-receipts", receiptsDir(w)]));
    expect(r.code).toBe(0);
    expect((r.json as Record<string, unknown>).outcome).toBe("upgraded");
    expect((r.json as Record<string, unknown>).verification).toBe(true);
    // the tampered component was repaired from the registry source
    expect(readFileSync(join(w.config, "modes", "autodev", "pack.toml"), "utf8")).toBe(
      readFileSync(join(w.repoAmicode, "packages", "extension", "modes", "autodev", "pack.toml"), "utf8"),
    );
    // an independent doctor re-run agrees: both records current
    const independent = await surfaceInventory(ctxForWorld(w));
    for (const name of ["agent-cards-global", "agent-cards-staging"]) {
      expect(bySurface(independent.surfaces, name).verdict).toBe("current");
    }
    cleanup();
  });
});

describe("upgrade agents — pre-flight gates + aborts", () => {
  test("both deployments current → no-op, deploy script NOT run (receipt untouched)", async () => {
    const w = stageAgentsWorld();
    const args = verbArgs(w, ["--root-receipts", receiptsDir(w)]);
    await upgradeVerb(args); // converge
    const contractPath = join(w.repoAmicode, "packages", "extension", "agents", ".deploy-receipt.json");
    const before = readFileSync(contractPath, "utf8");
    const r = await upgradeVerb(args);
    expect(r.code).toBe(0);
    expect((r.json as Record<string, unknown>).outcome).toBe("no-op");
    expect(readFileSync(contractPath, "utf8")).toBe(before); // not rewritten
    cleanup();
  });

  test("missing source dir → aborted-unknown (missing-local-source is unknown)", async () => {
    const w = stageAgentsWorld();
    rmSync(join(w.repoAmicode, "packages", "extension", "agents"), { recursive: true, force: true });
    const r = await upgradeVerb(verbArgs(w, ["--root-receipts", receiptsDir(w)]));
    expect(r.code).toBe(1);
    const receipt = r.json as Record<string, unknown>;
    expect(receipt.outcome).toBe("aborted-unknown");
    expect(receipt.post).toBeNull();
    cleanup();
  });

  test("deploy-agents.mjs absent from the checkout → aborted-environment, nothing deployed", async () => {
    const w = buildDoctorWorld();
    writeFileSync(join(w.config, "agents", "autodev.md"), "---\nmode: autodev\n---\n# TAMPERED\n");
    const tampered = readFileSync(join(w.config, "agents", "autodev.md"), "utf8");
    const r = await upgradeVerb(verbArgs(w, ["--root-receipts", receiptsDir(w)]));
    expect(r.code).toBe(1);
    const receipt = r.json as Record<string, unknown>;
    expect(receipt.outcome).toBe("aborted-environment");
    // nothing was deployed
    expect(readFileSync(join(w.config, "agents", "autodev.md"), "utf8")).toBe(tampered);
    cleanup();
  });
});

// ── #806 (D3): role-card convergence — a machine on a post-seed release ──────
//
// The fixture world's release tag carries the REAL D3-seeded role cards
// (helpers' realAgents) — a post-seed release. A machine whose deployed
// roots still carry the OLD deployed-only artifacts (drifted bytes from
// before the cards had a repo source) reads STALE with the role cards
// named — the honest pre-upgrade state, not a regression — and reads
// CURRENT once UPGRADED, on both agent-cards records and every bundle
// component row.
describe("upgrade agents — role-card convergence (#806)", () => {
  const ROLE_CARD_NAMES = ["hypothesizer", "experimenter", "analyzer", "implementer"] as const;

  test("old deployed-only role artifacts read stale (named) → verb converges BOTH roots → post current", async () => {
    const w = buildDoctorWorld({ realAgents: true });
    mkdirSync(join(w.repoAmicode, "scripts"), { recursive: true });
    copyFileSync(REAL_SCRIPT, join(w.repoAmicode, "scripts", "deploy-agents.mjs"));
    // the machine still carries the OLD deployed-only artifacts — the
    // pre-seed live copies, drifted bytes on both deployment roots AND the
    // deployed bundles' role components
    const oldArtifact = (role: string): string =>
      `---\ndescription: the old deployed-only ${role} artifact\ntemperature: 0.3\n---\n# ${role} (pre-seed live copy)\n`;
    for (const role of ROLE_CARD_NAMES) {
      writeFileSync(join(w.config, "agents", `${role}.md`), oldArtifact(role));
      writeFileSync(join(w.staging, ".opencode", "agents", `${role}.md`), oldArtifact(role));
      const bundle = role === "implementer" ? "autodev" : "autoresearch";
      writeFileSync(join(w.config, "modes", bundle, "roles", `${role}.md`), oldArtifact(role));
      writeFileSync(join(w.staging, ".opencode", "modes", bundle, "roles", `${role}.md`), oldArtifact(role));
    }

    // PRE: both agent-cards records stale, the role cards named in evidence
    // (the flat per-card digest diff governs — the honest pre-upgrade state)
    const pre = await surfaceInventory(ctxForWorld(w));
    for (const name of ["agent-cards-global", "agent-cards-staging"]) {
      const rec = pre.surfaces.find((r) => r.surface === name)!;
      expect(rec.verdict).toBe("stale");
      for (const role of ROLE_CARD_NAMES) {
        expect(rec.evidence.some((e) => e.includes(`${role}.md`)), `${name} names ${role}.md`).toBe(true);
      }
    }

    // the verb converges BOTH roots
    const r = await upgradeVerb(verbArgs(w, ["--root-receipts", receiptsDir(w)]));
    expect(r.code).toBe(0);
    expect((r.json as Record<string, unknown>).outcome).toBe("upgraded");

    // POST: both records current, every role component current — the old
    // deployed-only artifacts read current once UPGRADED (the stale-by-
    // construction verdict resolves, D3)
    const post = await surfaceInventory(ctxForWorld(w));
    for (const name of ["agent-cards-global", "agent-cards-staging"]) {
      const rec = post.surfaces.find((r2) => r2.surface === name)!;
      expect(rec.verdict, `${name} post-upgrade`).toBe("current");
      for (const comp of rec.components ?? []) {
        if (comp.component.startsWith("roles/")) {
          expect(comp.verdict, `${name} component ${comp.component}`).toBe("current");
        }
      }
    }
    // the deployed role cards are byte-identical to the repo's seeded sources
    for (const role of ROLE_CARD_NAMES) {
      const src = readFileSync(join(w.repoAmicode, "packages", "extension", "agents", `${role}.md`), "utf8");
      expect(readFileSync(join(w.config, "agents", `${role}.md`), "utf8")).toBe(src);
      expect(readFileSync(join(w.staging, ".opencode", "agents", `${role}.md`), "utf8")).toBe(src);
    }
    cleanup();
  });

  test("a converged post-seed machine reads CURRENT across both records and all role components (the resolved state)", async () => {
    const w = buildDoctorWorld({ realAgents: true });
    const report = await surfaceInventory(ctxForWorld(w));
    for (const name of ["agent-cards-global", "agent-cards-staging"]) {
      const rec = report.surfaces.find((r) => r.surface === name)!;
      expect(rec.verdict, `${name} starts current on a fresh post-seed world`).toBe("current");
      for (const comp of rec.components ?? []) {
        if (comp.component.startsWith("roles/")) expect(comp.verdict).toBe("current");
      }
      // the doctor's source set includes the four role cards — the record's
      // evidence counts the full shipped set
      const counted = rec.evidence.find((e) => /cards byte-match/.test(e));
      expect(counted, `${name} evidence counts the card set`).toBeDefined();
    }
    cleanup();
  });
});

// ── the record-name alias (spec D3: the panel passes doctor's record names verbatim) ──

test("doctor record names agent-cards-global / agent-cards-staging alias the agents verb", async () => {
  const w = buildDoctorWorld();
  const cleanup = () => cleanupTracked();
  try {
    // stage drift so the aliased run has something to do
    writeFileSync(join(w.config, "agents", "autodev.md"), "---\nmode: autodev\n---\n# TAMPERED\n");
    for (const alias of ["agent-cards-global", "agent-cards-staging"]) {
      const argv = [...verbArgs(w), "--root-receipts", receiptsDir(w)];
      argv[0] = alias; // the panel sends the doctor record name as the surface
      const r = await upgradeVerb(argv);
      expect(r.code, `alias ${alias} must route to the agents verb, not "unknown surface"`).not.toBe(64);
      expect((r.json as Record<string, unknown>).verb).toBe("agents");
    }
  } finally {
    cleanup();
  }
});
