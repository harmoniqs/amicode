import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  createLocalPersonalVault,
  sanitizeVaultName,
  suggestVaultName,
} from "../../src/substrate/vault_setup";
import { resolveMountStack, personalMount } from "../../src/substrate/mount_store";

const mkTmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "vault-setup-"));

describe("sanitizeVaultName", () => {
  it("folds to lowercase kebab and strips junk", () => {
    expect(sanitizeVaultName("Jack Champagne")).toBe("jack-champagne");
    expect(sanitizeVaultName("  My Lab!! ")).toBe("my-lab");
    expect(sanitizeVaultName("--a__b--")).toBe("a__b");
  });
  it("falls back to 'personal' when empty", () => {
    expect(sanitizeVaultName("")).toBe("personal");
    expect(sanitizeVaultName("///")).toBe("personal");
  });
});

describe("suggestVaultName", () => {
  it("uses an explicit hint when given", () => {
    expect(suggestVaultName("Quantum Lab")).toBe("quantum-lab");
  });
  it("returns a non-empty sanitized name with no hint", () => {
    expect(suggestVaultName()).toMatch(/^[a-z0-9._-]+$/);
  });
});

describe("createLocalPersonalVault", () => {
  it("creates a local personal vault that resolveMountStack picks up", () => {
    const root = mkTmp();
    const created = createLocalPersonalVault(root, "Jack Champagne");
    expect(created.name).toBe("jack-champagne");
    expect(created.path).toBe(path.join(root, "jack-champagne"));

    const marker = fs.readFileSync(path.join(created.path, ".amico-vault.toml"), "utf8");
    expect(marker).toContain('kind = "personal"');
    expect(marker).toContain('name = "jack-champagne"');

    // resolves as the personal mount
    const stack = resolveMountStack(root);
    const personal = personalMount(stack);
    expect(personal?.name).toBe("jack-champagne");
    expect(personal?.kind).toBe("personal");
    expect(personal?.writable).toBe(true);
  });

  it("git-inits by default (best-effort) and can be disabled", () => {
    const root = mkTmp();
    const withGit = createLocalPersonalVault(root, "with-git");
    // git is best-effort; if it ran, the repo dir exists
    if (withGit.gitInit) expect(fs.existsSync(path.join(withGit.path, ".git"))).toBe(true);

    const noGit = createLocalPersonalVault(root, "no-git", { gitInit: false });
    expect(noGit.gitInit).toBe(false);
    expect(fs.existsSync(path.join(noGit.path, ".git"))).toBe(false);
  });

  it("refuses to clobber an existing vault", () => {
    const root = mkTmp();
    createLocalPersonalVault(root, "dup");
    expect(() => createLocalPersonalVault(root, "dup")).toThrow(/already exists/);
  });

  it("does NOT seed the amicode/ substrate (the distiller owns it)", () => {
    const root = mkTmp();
    const created = createLocalPersonalVault(root, "clean");
    expect(fs.existsSync(path.join(created.path, "amicode"))).toBe(false);
  });
});
