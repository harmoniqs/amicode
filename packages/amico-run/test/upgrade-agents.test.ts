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
