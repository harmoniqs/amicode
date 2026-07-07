import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  resolvePersonalVault,
  readProfileMd,
  readKnowledgeLines,
  hasOnboardingCompleted,
} from "../../src/substrate/vault_store";

function mkTmp(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}
function mkVault(root: string, name: string, kind: string): string {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, ".amico-vault.toml"), `kind = "${kind}"\nname = "${name}"\n`);
  return dir;
}

describe("resolvePersonalVault (spec §2)", () => {
  it("explicit override wins even when a personal mount exists", () => {
    const root = mkTmp("vaults-");
    mkVault(root, "armonia-someone", "personal");
    expect(resolvePersonalVault(root, "/explicit/override")).toBe("/explicit/override");
  });
  it("finds the first kind=personal mount; ignores team/restricted", () => {
    const root = mkTmp("vaults-");
    mkVault(root, "armonissima", "team");
    const personal = mkVault(root, "armonia-someone", "personal");
    mkVault(root, "armonia-partitura", "restricted");
    expect(resolvePersonalVault(root, "")).toBe(personal);
  });
  it("no personal mount / missing root → empty string (session proceeds unpersonalized)", () => {
    const root = mkTmp("vaults-");
    mkVault(root, "armonissima", "team");
    expect(resolvePersonalVault(root, "")).toBe("");
    expect(resolvePersonalVault("/nonexistent-vaults-root", "")).toBe("");
  });
  it("dir without marker file is skipped, not an error", () => {
    const root = mkTmp("vaults-");
    fs.mkdirSync(path.join(root, "not-a-vault"));
    const personal = mkVault(root, "zz-personal", "personal");
    expect(resolvePersonalVault(root, "")).toBe(personal);
  });
});

describe("readProfileMd (spec §3 routing predicate: non-empty check)", () => {
  it("missing file → ''", () => {
    expect(readProfileMd(mkTmp("vault-"))).toBe("");
  });
  it("whitespace-only file counts as absent (§3: corrupt/empty PROFILE.md)", () => {
    const v = mkTmp("vault-");
    fs.mkdirSync(path.join(v, "amicode"), { recursive: true });
    fs.writeFileSync(path.join(v, "amicode", "PROFILE.md"), "  \n\t\n");
    expect(readProfileMd(v)).toBe("");
  });
  it("real content returned verbatim", () => {
    const v = mkTmp("vault-");
    fs.mkdirSync(path.join(v, "amicode"), { recursive: true });
    fs.writeFileSync(path.join(v, "amicode", "PROFILE.md"), "# Profile — A\n- Role: CEO\n");
    expect(readProfileMd(v)).toContain("Role: CEO");
  });
});

describe("readKnowledgeLines (spec §2.3: list lines, cap 50)", () => {
  it("missing → []", () => {
    expect(readKnowledgeLines(mkTmp("vault-"))).toEqual([]);
  });
  it("returns only list-item lines, capped", () => {
    const v = mkTmp("vault-");
    fs.mkdirSync(path.join(v, "amicode"), { recursive: true });
    const items = Array.from({ length: 60 }, (_, i) => `- [p${i}](problems/p${i}.md) — thing ${i}`);
    fs.writeFileSync(
      path.join(v, "amicode", "KNOWLEDGE.md"),
      "# heading ignored\n" + items.join("\n") + "\nprose ignored\n",
    );
    const lines = readKnowledgeLines(v);
    expect(lines.length).toBe(50);
    expect(lines[0]).toContain("p0");
    expect(lines.every((l) => l.startsWith("- "))).toBe(true);
  });
});

describe("hasOnboardingCompleted (spec §3 routing predicate, second disjunct)", () => {
  it("missing stream → false", () => {
    expect(hasOnboardingCompleted(path.join(mkTmp("ops-"), "onboarding"))).toBe(false);
  });
  it("stream with only partial entities → false; with marker → true", () => {
    const dir = path.join(mkTmp("ops-"), "onboarding");
    fs.mkdirSync(dir, { recursive: true });
    const f = path.join(dir, "events.jsonl");
    fs.writeFileSync(f, JSON.stringify({ seq: 1, entity: "profile", action: "created" }) + "\n");
    expect(hasOnboardingCompleted(dir)).toBe(false);
    fs.appendFileSync(f, JSON.stringify({ seq: 2, entity: "onboarding_completed", action: "created" }) + "\n");
    expect(hasOnboardingCompleted(dir)).toBe(true);
  });
  it("malformed lines are skipped, not fatal", () => {
    const dir = path.join(mkTmp("ops-"), "onboarding");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "events.jsonl"),
      "not json\n" + JSON.stringify({ entity: "onboarding_completed" }) + "\n",
    );
    expect(hasOnboardingCompleted(dir)).toBe(true);
  });
});
