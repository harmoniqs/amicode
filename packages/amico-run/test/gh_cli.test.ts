// The `gh` shim bundle (issue #399) — end-to-end through dist/gh.js with a
// STUB real-gh on PATH (records argv + GH_TOKEN, exits with a marker code).
// Hermetic: the GitHub App config/token-cache files point into temp dirs, and
// the configured cases use a PREFILLED fresh cache so no network is touched.
import { describe, it, expect, beforeAll } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { testKeyPair } from "../src/github_app.js";
import { tmpRoot } from "./helpers.js";

const ROOT = join(__dirname, "..");
const BUNDLE = join(ROOT, "dist", "gh.js");
beforeAll(() => {
  execFileSync("node", [join(ROOT, "esbuild.config.mjs")], { cwd: ROOT });
});

/** A fake "real gh": dumps {argv, ghToken} as JSON, exits 7 (marker passthrough). */
function stubGh(dir: string): string {
  const bin = join(dir, "gh");
  // node -e: process.argv is [node, ...args] — argv[1] is the FIRST real arg.
  writeFileSync(
    bin,
    `#!/bin/sh\nnode -e 'console.log(JSON.stringify({argv: process.argv.slice(1), ghToken: process.env.GH_TOKEN ?? null}))' "$@"\nexit 7\n`,
  );
  chmodSync(bin, 0o755);
  return bin;
}

function runShim(argv: string[], env: Record<string, string>): { code: number; stdout: string; stderr: string } {
  const r = spawnSync("node", [BUNDLE, ...argv], { encoding: "utf8", env: { ...process.env, ...env } });
  return { code: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

function stubOut(r: { stdout: string }): { argv: string[]; ghToken: string | null } {
  return JSON.parse(r.stdout.split("\n").filter((l) => l.startsWith("{"))[0]);
}

function setup() {
  const root = tmpRoot();
  const binDir = join(root, "bin");
  mkdirSync(binDir, { recursive: true });
  stubGh(binDir);
  const { privateKeyPem } = testKeyPair();
  const pemFile = join(root, "k.pem");
  writeFileSync(pemFile, privateKeyPem);
  const configFile = join(root, "github.json");
  const cacheFile = join(root, "tok.json");
  // The stub dir leads PATH but the real PATH follows: the stub's own `node`
  // invocation (and libuv's child-binary lookup) must still resolve.
  const baseEnv = {
    PATH: `${binDir}:${process.env.PATH ?? ""}`,
    AMICO_GITHUB_FILE: configFile,
    AMICO_GITHUB_TOKEN_FILE: cacheFile,
  };
  return { root, binDir, pemFile, configFile, cacheFile, baseEnv };
}

describe("gh shim (bundle)", () => {
  it("unconfigured → transparent passthrough: argv verbatim, NO GH_TOKEN, exit code kept", () => {
    const { configFile, baseEnv } = setup();
    // configFile intentionally never written — the not-connected state.
    const r = runShim(["pr", "view", "123"], baseEnv);
    const out = stubOut(r);
    expect(out.argv).toEqual(["pr", "view", "123"]);
    expect(out.ghToken).toBeNull();
    expect(r.code).toBe(7);
  });

  it("configured + fresh cached token → child env carries GH_TOKEN, argv verbatim", () => {
    const { pemFile, configFile, cacheFile, baseEnv } = setup();
    writeFileSync(configFile, JSON.stringify({ app_id: "1", installation_id: "2", pem_path: pemFile }));
    writeFileSync(cacheFile, JSON.stringify({ token: "ghs_test_bundle", expiresAt: new Date(Date.now() + 3600_000).toISOString() }));
    const r = runShim(["issue", "list"], baseEnv);
    const out = stubOut(r);
    expect(out.argv).toEqual(["issue", "list"]);
    expect(out.ghToken).toBe("ghs_test_bundle");
    expect(r.code).toBe(7);
  });

  it("configured but garbage PEM → exit 64, one token-free stderr line", () => {
    const { root, configFile, baseEnv } = setup();
    const badPem = join(root, "bad.pem");
    writeFileSync(badPem, "-----BEGIN RSA PRIVATE KEY-----\ngarbage\n-----END RSA PRIVATE KEY-----\n");
    writeFileSync(configFile, JSON.stringify({ app_id: "1", installation_id: "2", pem_path: badPem }));
    // No cache file → mint path → PEM parse fails before any network.
    const r = runShim(["pr", "list"], baseEnv);
    expect(r.code).toBe(64);
    expect(r.stderr).toMatch(/PEM/);
    expect(r.stderr).not.toContain("ghs_");
    expect(r.stdout).toBe("");
  });

  it("configured + malformed config JSON → exit 64, actionable stderr", () => {
    const { configFile, baseEnv } = setup();
    writeFileSync(configFile, "{nope");
    const r = runShim(["pr", "list"], baseEnv);
    expect(r.code).toBe(64);
    expect(r.stderr).toMatch(/malformed/);
  });

  it("recursion guard: a gh sitting in the shim's own launcher dir is never picked", () => {
    // PATH = the launcher dir + ONLY the node bin dir (so the bundle itself and
    // its child lookups resolve, but no real gh exists) → 127. The file vars
    // stay pointed at a nonexistent tmp path so this is the passthrough lane
    // regardless of the developer's real ~/.amico state.
    const root = tmpRoot();
    const r = runShim(["pr", "list"], {
      PATH: `${join(ROOT, "launcher")}:${dirname(process.execPath)}`,
      AMICO_GITHUB_FILE: join(root, "github.json"),
      AMICO_GITHUB_TOKEN_FILE: join(root, "tok.json"),
    });
    expect(r.code).toBe(127);
    expect(r.stderr).toMatch(/not found/i);
  });
});
