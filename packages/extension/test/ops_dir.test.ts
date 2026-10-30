// ops_dir.test.ts — #1998: ONE ops dir. `amicodeOpsDir()` has a single
// definition; the reachability cache, the routing snapshot, and the picker
// config all resolve beside each other (env override AND default); a cache
// left at the legacy ~/.amico path is still read and migrates on first write.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelReachability, reachabilityCacheFile } from "../src/amicode_service/model_reachability";
import { modelPickerConfigFile } from "../src/amicode_service/model_picker_config";
import { amicodeOpsDir as vaultStoreOpsDir } from "../src/substrate/vault_store";
import { amicodeOpsDir as connectionsOpsDir } from "../src/amicode_service/connections";
import { routingSnapshotFile, readLiveProviders } from "../opencode-plugin/model_routing";

const ROOT = join(__dirname, "..");

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx|mjs)$/.test(name)) out.push(p);
  }
  return out;
}

describe("#1998 one amicodeOpsDir()", () => {
  it("has exactly one `function amicodeOpsDir` definition in the extension (src + opencode-plugin)", () => {
    const hits: string[] = [];
    for (const f of [...walk(join(ROOT, "src")), ...walk(join(ROOT, "opencode-plugin"))]) {
      if (/function\s+amicodeOpsDir\b/.test(readFileSync(f, "utf8"))) hits.push(f.slice(ROOT.length + 1));
    }
    expect(hits).toEqual(["src/ops_dir.ts"]);
  });

  it("the re-exports are the SAME function", () => {
    expect(vaultStoreOpsDir).toBe(connectionsOpsDir);
  });
});

describe("#1998 sibling files share one dir", () => {
  const saved = { ops: process.env.AMICODE_OPS_DIR, home: process.env.HOME };
  let home = "";
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "amc-1998-home-"));
    process.env.HOME = home;
    delete process.env.AMICODE_OPS_DIR;
  });
  afterEach(() => {
    if (saved.ops === undefined) delete process.env.AMICODE_OPS_DIR;
    else process.env.AMICODE_OPS_DIR = saved.ops;
    if (saved.home === undefined) delete process.env.HOME;
    else process.env.HOME = saved.home;
  });

  it("under an env override: cache, snapshot and picker config sit in the override dir", () => {
    const ops = mkdtempSync(join(tmpdir(), "amc-1998-ops-"));
    process.env.AMICODE_OPS_DIR = ops;
    expect(reachabilityCacheFile()).toBe(join(ops, "model-reachability.json"));
    expect(routingSnapshotFile()).toBe(join(ops, "model-routing-providers.json"));
    expect(modelPickerConfigFile()).toBe(join(ops, "model-picker.json"));
  });

  it("by default: cache, snapshot and picker config sit in ~/.amico/amicode", () => {
    const ops = join(home, ".amico", "amicode");
    expect(reachabilityCacheFile()).toBe(join(ops, "model-reachability.json"));
    expect(routingSnapshotFile()).toBe(join(ops, "model-routing-providers.json"));
    expect(modelPickerConfigFile()).toBe(join(ops, "model-picker.json"));
  });

  it("a legacy ~/.amico/model-reachability.json cache is still read, and the next write lands in the new dir", async () => {
    mkdirSync(join(home, ".amico"), { recursive: true });
    const legacy = join(home, ".amico", "model-reachability.json");
    writeFileSync(
      legacy,
      JSON.stringify({
        version: 1,
        providers: {
          openai: {
            credential_fp: "aaaaaaaaaaaaaaaa",
            last_probe_at: 1_800_000_000_000,
            last_attempt_at: 1_800_000_000_000,
            last_error: null,
            models: { "gpt-x": { status: "denied", reason: "legacy row", latency_ms: 3, credential_fp: "aaaaaaaaaaaaaaaa", checked_at: 1_800_000_000_000 } },
          },
        },
      }),
    );
    const mr = new ModelReachability({
      now: () => 1_800_000_000_000,
      listModels: async () => ({ openai: ["gpt-x"] }),
    });
    expect(mr.file).toBe(join(home, ".amico", "amicode", "model-reachability.json"));
    const snap = await mr.snapshot();
    const r = snap.models.find((m) => m.provider === "openai" && m.model === "gpt-x");
    expect(r?.status).toBe("denied");
    expect(r?.reason).toBe("legacy row");

    // a write migrates: the new file exists and carries the legacy row forward
    await mr.demote({ provider: "openai", model: "gpt-y", status: "denied", reason: "new" });
    expect(existsSync(mr.file)).toBe(true);
    const doc = JSON.parse(readFileSync(mr.file, "utf8"));
    expect(doc.providers.openai.models["gpt-x"].reason).toBe("legacy row");
    // once the new file exists it wins over the legacy one
    expect(existsSync(legacy)).toBe(true);
  });

  it("a legacy ~/.amico/model-routing-providers.json snapshot is still read when the new one is missing", () => {
    mkdirSync(join(home, ".amico"), { recursive: true });
    writeFileSync(
      join(home, ".amico", "model-routing-providers.json"),
      JSON.stringify({ snapshot_version: 1, providers: ["anthropic", "zai"] }),
    );
    expect(readLiveProviders()).toEqual(["anthropic", "zai"]);
    // the new location wins once it exists
    mkdirSync(join(home, ".amico", "amicode"), { recursive: true });
    writeFileSync(join(home, ".amico", "amicode", "model-routing-providers.json"), JSON.stringify({ snapshot_version: 1, providers: ["openai"] }));
    expect(readLiveProviders()).toEqual(["openai"]);
  });
});
