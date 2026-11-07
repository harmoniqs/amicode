// The git credential helper bundle (issue #399) — end-to-end through
// dist/amico-git-credential.js over the git-credential stdin protocol.
// Hermetic: config/token-cache files live in temp dirs and the configured
// cases use a PREFILLED fresh cache, so nothing touches the network.
import { describe, it, expect, beforeAll } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { testKeyPair } from "../src/github_app.js";
import { tmpRoot } from "./helpers.js";
import { credentialMain, parseCredentialRequest } from "../src/git_credential.js";

const ROOT = join(__dirname, "..");
const BUNDLE = join(ROOT, "dist", "amico-git-credential.js");
beforeAll(() => {
  execFileSync("node", [join(ROOT, "esbuild.config.mjs")], { cwd: ROOT });
});

function runHelper(input: string, env: Record<string, string>): { code: number; stdout: string; stderr: string } {
  const r = spawnSync("node", [BUNDLE], { input, encoding: "utf8", env: { ...process.env, ...env } });
  return { code: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

function setup() {
  const root = tmpRoot();
  const { privateKeyPem } = testKeyPair();
  const pemFile = join(root, "k.pem");
  writeFileSync(pemFile, privateKeyPem);
  const configFile = join(root, "github.json");
  const cacheFile = join(root, "tok.json");
  // #1928: identity by AMICO_GH_IDENTITY ("" = the person default, pinned
  // against the developer's env); the principal cache lives in the sandbox.
  const appsDir = join(root, "github-apps");
  mkdirSync(appsDir, { recursive: true });
  writeFileSync(join(appsDir, "principal.json"), JSON.stringify({ on_behalf_of: "test-human", captured_at: new Date().toISOString(), source: "gh api user" }));
  const baseEnv = { AMICO_GITHUB_FILE: configFile, AMICO_GITHUB_TOKEN_FILE: cacheFile, AMICO_GITHUB_APPS_DIR: appsDir, AMICO_GH_IDENTITY: "" };
  return { root, pemFile, configFile, cacheFile, baseEnv };
}

describe("parseCredentialRequest", () => {
  it("reads protocol/host and stops at the blank line", () => {
    expect(parseCredentialRequest("protocol=https\nhost=github.com\n\npath=x\n")).toEqual({
      protocol: "https",
      host: "github.com",
    });
    expect(parseCredentialRequest("protocol=https\nhost=github.com")).toEqual({ protocol: "https", host: "github.com" });
    expect(parseCredentialRequest("")).toEqual({});
  });
});

describe("git credential helper (unit)", () => {
  it("non-https or non-github → silent no-op", async () => {
    const { baseEnv } = setup();
    const agentEnv = { ...baseEnv, AMICO_GH_IDENTITY: "agent" };
    expect(await credentialMain("protocol=http\nhost=github.com\n\n", agentEnv)).toEqual({ stdout: "", code: 0 });
    expect(await credentialMain("protocol=https\nhost=gitlab.com\n\n", agentEnv)).toEqual({ stdout: "", code: 0 });
  });
  it("unconfigured → silent no-op (git falls through)", async () => {
    const { baseEnv } = setup(); // neither file is ever written
    expect(await credentialMain("protocol=https\nhost=github.com\n\n", baseEnv)).toEqual({ stdout: "", code: 0 });
    expect(await credentialMain("protocol=https\nhost=github.com\n\n", { ...baseEnv, AMICO_GH_IDENTITY: "agent" })).toEqual({ stdout: "", code: 0 });
  });
});

describe("git credential helper (bundle)", () => {
  it("configured but identity unset (person, the default) → silence, git falls through (#1928)", () => {
    const { pemFile, configFile, cacheFile, baseEnv } = setup();
    writeFileSync(configFile, JSON.stringify({ app_id: "1", installation_id: "2", pem_path: pemFile }));
    writeFileSync(cacheFile, JSON.stringify({ token: "ghs_test_cred", expiresAt: new Date(Date.now() + 3600_000).toISOString() }));
    const r = runHelper("protocol=https\nhost=github.com\n\n", baseEnv);
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("");
  });

  it("configured + agent identity + fresh cached token → protocol answer with the token", () => {
    const { pemFile, configFile, cacheFile, baseEnv } = setup();
    writeFileSync(configFile, JSON.stringify({ app_id: "1", installation_id: "2", pem_path: pemFile }));
    writeFileSync(cacheFile, JSON.stringify({ token: "ghs_test_cred", expiresAt: new Date(Date.now() + 3600_000).toISOString() }));
    const r = runHelper("protocol=https\nhost=github.com\n\n", { ...baseEnv, AMICO_GH_IDENTITY: "agent" });
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("username=x-access-token\npassword=ghs_test_cred\n");
  });

  it("other hosts / plain http → empty stdout, exit 0", () => {
    const { pemFile, configFile, cacheFile, baseEnv } = setup();
    writeFileSync(configFile, JSON.stringify({ app_id: "1", installation_id: "2", pem_path: pemFile }));
    writeFileSync(cacheFile, JSON.stringify({ token: "ghs_test_cred", expiresAt: new Date(Date.now() + 3600_000).toISOString() }));
    const agentEnv = { ...baseEnv, AMICO_GH_IDENTITY: "agent" };
    expect(runHelper("protocol=https\nhost=example.com\n\n", agentEnv).stdout).toBe("");
    expect(runHelper("protocol=http\nhost=github.com\n\n", agentEnv).stdout).toBe("");
  });

  it("malformed config → token-free stderr note, stdout stays protocol-clean, exit 0 (never blocks auth)", () => {
    const { configFile, baseEnv } = setup();
    writeFileSync(configFile, "{nope");
    const r = runHelper("protocol=https\nhost=github.com\n\n", { ...baseEnv, AMICO_GH_IDENTITY: "agent" });
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("");
    expect(r.stderr).toMatch(/malformed/);
    expect(r.stderr).not.toContain("ghs_");
  });

  it("unconfigured → silence", () => {
    const { baseEnv } = setup();
    const r = runHelper("protocol=https\nhost=github.com\n\n", baseEnv);
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("");
  });
});
