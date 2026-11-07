// A15 agent identity (#1928) — principal-by-env identity resolution, the
// principal-bound mint record, the scrubbed gh config, and the git
// credential lane. Hermetic: fake fetch, throwaway keys, sandboxed apps dir,
// a stub "real gh" that records what it saw into a file (never stdout).
import { describe, it, expect } from "vitest";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import {
  resolveGhIdentity,
  agentConfigFile,
  resolveOnBehalfOf,
  ensureAgentToken,
  scrubbedGhEnv,
  withAgentGitConfig,
  tokenFingerprint,
  mintsFile,
  principalCacheFile,
} from "../src/gh_identity.js";
import { ghShimMain } from "../src/gh_shim.js";
import { credentialMain } from "../src/git_credential.js";
import { ConfigError } from "../src/types.js";
import { tmpRoot } from "./helpers.js";
import { fakeGithub, sandbox, sha8, PLANTED_HUMAN_TOKEN } from "./gh_identity_helpers.js";

const AGENT_TOKEN = "ghs_test_AGENT_minted_abcdef123456";

function readStub(path: string) {
  return JSON.parse(readFileSync(path, "utf8")) as {
    argv: string[];
    ghTokenFp: string | null;
    tokenish: string[];
    ghConfigDir: string | null;
    configEntries: string[] | null;
    configMode: number | null;
    hostsYml: string | null;
    identity: string | null;
    envValues: string[];
  };
}

function mintLines(appsDir: string): Record<string, unknown>[] {
  const f = join(appsDir, "mints.jsonl");
  if (!existsSync(f)) return [];
  return readFileSync(f, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

describe("resolveGhIdentity", () => {
  it("unset / empty / person → person (the default); agent → agent", () => {
    expect(resolveGhIdentity({})).toBe("person");
    expect(resolveGhIdentity({ AMICO_GH_IDENTITY: "" })).toBe("person");
    expect(resolveGhIdentity({ AMICO_GH_IDENTITY: "person" })).toBe("person");
    expect(resolveGhIdentity({ AMICO_GH_IDENTITY: "agent" })).toBe("agent");
  });
  it("anything else (incl. reviewer — never env-selectable) → ConfigError, fail closed", () => {
    expect(() => resolveGhIdentity({ AMICO_GH_IDENTITY: "reviewer" })).toThrow(ConfigError);
    expect(() => resolveGhIdentity({ AMICO_GH_IDENTITY: "Agent " })).toThrow(/person.*agent/);
  });
});

describe("agent config file resolution", () => {
  it("github-apps/agent.json first; ~/.amico/github.json stays a back-compat alias; $AMICO_GITHUB_FILE overrides", () => {
    const sb = sandbox();
    expect(agentConfigFile({ AMICO_GITHUB_APPS_DIR: sb.appsDir })).toBe(join(sb.appsDir, "agent.json"));
    expect(agentConfigFile({ AMICO_GITHUB_APPS_DIR: sb.appsDir, AMICO_GITHUB_FILE: "/x/github.json" })).toBe("/x/github.json");
    // no apps-dir override, neither file → the canonical agent.json (named in "not connected")
    const home = tmpRoot();
    expect(agentConfigFile({}, home)).toBe(join(home, ".amico", "github-apps", "agent.json"));
    // only the legacy github.json present → the back-compat alias
    mkdirSync(join(home, ".amico"), { recursive: true });
    writeFileSync(join(home, ".amico", "github.json"), "{}");
    expect(agentConfigFile({}, home)).toBe(join(home, ".amico", "github.json"));
    // both present → agent.json wins
    mkdirSync(join(home, ".amico", "github-apps"), { recursive: true });
    writeFileSync(join(home, ".amico", "github-apps", "agent.json"), "{}");
    expect(agentConfigFile({}, home)).toBe(join(home, ".amico", "github-apps", "agent.json"));
  });
});

describe("person identity passes through untouched", () => {
  it("agent.json present but AMICO_GH_IDENTITY unset → real gh sees the parent env verbatim, no mint, no fetch", async () => {
    const sb = sandbox();
    const fake = fakeGithub({ "2001": AGENT_TOKEN });
    const env = { ...sb.env };
    const code = await ghShimMain(["pr", "view", "123"], env, undefined, { fetchImpl: fake.impl });
    expect(code).toBe(7);
    const out = readStub(sb.stubOut);
    expect(out.argv).toEqual(["pr", "view", "123"]);
    expect(out.ghConfigDir).toBe(sb.humanGhDir); // the human's own config, untouched
    expect(out.hostsYml).toContain("planted-human"); // the human's login still works
    expect(out.ghTokenFp).toBeNull(); // no GH_TOKEN injected
    expect(out.identity).toBeNull();
    expect(fake.calls).toHaveLength(0);
    expect(mintLines(sb.appsDir)).toHaveLength(0);
  });
  it("explicit person behaves the same", async () => {
    const sb = sandbox();
    const fake = fakeGithub({ "2001": AGENT_TOKEN });
    const code = await ghShimMain(["issue", "list"], { ...sb.env, AMICO_GH_IDENTITY: "person" }, undefined, { fetchImpl: fake.impl });
    expect(code).toBe(7);
    expect(readStub(sb.stubOut).ghConfigDir).toBe(sb.humanGhDir);
    expect(fake.calls).toHaveLength(0);
  });
  it("git credential helper under person → silent (git falls through to the human's helpers), no fetch", async () => {
    const sb = sandbox();
    const fake = fakeGithub({ "2001": AGENT_TOKEN });
    expect(await credentialMain("protocol=https\nhost=github.com\n\n", sb.env, "get", { fetchImpl: fake.impl })).toEqual({ stdout: "", code: 0 });
    expect(fake.calls).toHaveLength(0);
  });
  it("unknown identity value → gh shim exits 64 without running gh", async () => {
    const sb = sandbox();
    const code = await ghShimMain(["pr", "list"], { ...sb.env, AMICO_GH_IDENTITY: "reviewer" }, undefined, {});
    expect(code).toBe(64);
    expect(existsSync(sb.stubOut)).toBe(false);
  });
});

describe("agent identity: mint from agent.json, one mint record, scrubbed gh config", () => {
  it("mints from agent.json, writes exactly one principal-bound record, runs gh with a private empty GH_CONFIG_DIR + only the App GH_TOKEN", async () => {
    const sb = sandbox();
    const fake = fakeGithub({ "2001": AGENT_TOKEN });
    const env = { ...sb.env, AMICO_GH_IDENTITY: "agent", AMICO_CAMPAIGN: "camp-slug", AMICO_SESSION_ID: "ses_test1" };
    const code = await ghShimMain(["issue", "comment", "5", "--body", "hi"], env, undefined, { fetchImpl: fake.impl });
    expect(code).toBe(7);
    // minted from agent.json's installation, with a JWT bearer
    const mints = fake.calls.filter((c) => c.url.includes("/access_tokens"));
    expect(mints).toHaveLength(1);
    expect(mints[0].url).toBe("https://api.github.com/app/installations/2001/access_tokens");
    // one mint record, principal bound
    const recs = mintLines(sb.appsDir);
    expect(recs).toHaveLength(1);
    expect(recs[0]).toMatchObject({
      app_id: "1001",
      installation_id: "2001",
      principal: { kind: "agent", on_behalf_of: "planted-human", campaign: "camp-slug", session: "ses_test1" },
      token_fp: sha8(AGENT_TOKEN),
    });
    expect(typeof recs[0].ts).toBe("string");
    expect(typeof recs[0].expires_at).toBe("string");
    expect(Object.keys(recs[0]).sort()).toEqual(["app_id", "expires_at", "installation_id", "principal", "token_fp", "ts"]);
    expect(statSync(join(sb.appsDir, "mints.jsonl")).mode & 0o777).toBe(0o600);
    // the child: App token only, private EMPTY config dir
    const out = readStub(sb.stubOut);
    expect(out.argv).toEqual(["issue", "comment", "5", "--body", "hi"]);
    expect(out.ghTokenFp).toBe(sha8(AGENT_TOKEN));
    expect(out.tokenish).toEqual(["GH_TOKEN"]); // GITHUB_TOKEN & co. stripped
    expect(out.ghConfigDir).not.toBeNull();
    expect(out.ghConfigDir).not.toBe(sb.humanGhDir);
    expect(out.configEntries).toEqual([]);
    expect(out.configMode).toBe(0o700);
    // the private dir does not outlive the call
    expect(existsSync(out.ghConfigDir!)).toBe(false);
  });

  it("the planted human hosts.yml is not readable from the child env", async () => {
    const sb = sandbox();
    // Also plant it via XDG_CONFIG_HOME — gh's second resolution rung.
    const fake = fakeGithub({ "2001": AGENT_TOKEN });
    const env = { ...sb.env, XDG_CONFIG_HOME: join(sb.humanHome, ".config"), AMICO_GH_IDENTITY: "agent" };
    await ghShimMain(["api", "repos/o/r"], env, undefined, { fetchImpl: fake.impl });
    const out = readStub(sb.stubOut);
    expect(out.hostsYml).toBeNull(); // gh's own resolution finds no hosts.yml
    expect(out.envValues).not.toContain(sb.humanGhDir); // no var points the child at the human config
    expect(out.envValues.some((v) => v.includes(PLANTED_HUMAN_TOKEN))).toBe(false); // no human token in any non-token var
    expect(out.tokenish).toEqual(["GH_TOKEN"]);
    expect(out.ghTokenFp).toBe(sha8(AGENT_TOKEN)); // …and the one token var is the App's
  });

  it("a second call within freshness reuses the cached token — no second mint, no second record", async () => {
    const sb = sandbox();
    const fake = fakeGithub({ "2001": AGENT_TOKEN });
    const env = { ...sb.env, AMICO_GH_IDENTITY: "agent" };
    await ghShimMain(["pr", "list"], env, undefined, { fetchImpl: fake.impl });
    await ghShimMain(["pr", "list"], env, undefined, { fetchImpl: fake.impl });
    expect(fake.calls.filter((c) => c.url.includes("/access_tokens"))).toHaveLength(1);
    expect(mintLines(sb.appsDir)).toHaveLength(1);
  });

  it("legacy ~/.amico/github.json alias still mints under agent identity (via $AMICO_GITHUB_FILE)", async () => {
    const sb = sandbox({ agentJson: false });
    const legacy = join(sb.root, "github.json");
    writeFileSync(legacy, JSON.stringify({ app_id: "1001", installation_id: "2001", pem_path: sb.agentPem }));
    const fake = fakeGithub({ "2001": AGENT_TOKEN });
    const code = await ghShimMain(["pr", "list"], { ...sb.env, AMICO_GITHUB_FILE: legacy, AMICO_GH_IDENTITY: "agent" }, undefined, {
      fetchImpl: fake.impl,
    });
    expect(code).toBe(7);
    expect(mintLines(sb.appsDir)).toHaveLength(1);
  });

  it("git credential helper under agent → the App token over the protocol, and a mint record", async () => {
    const sb = sandbox();
    const fake = fakeGithub({ "2001": AGENT_TOKEN });
    const r = await credentialMain("protocol=https\nhost=github.com\n\n", { ...sb.env, AMICO_GH_IDENTITY: "agent" }, "get", {
      fetchImpl: fake.impl,
    });
    expect(r).toEqual({ stdout: `username=x-access-token\npassword=${AGENT_TOKEN}\n`, code: 0 });
    expect(mintLines(sb.appsDir)).toHaveLength(1);
  });
});

describe("on_behalf_of: the human's gh login, captured once and cached", () => {
  it("captured from the human's gh (as person, never with an App token), cached; later calls never re-capture", async () => {
    const sb = sandbox();
    const log = join(sb.root, "login.log");
    const env = { ...sb.env, AMICO_GH_IDENTITY: "agent", STUB_LOGIN_LOG: log };
    expect(await resolveOnBehalfOf(env)).toBe("planted-human");
    const calls = readFileSync(log, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
    expect(calls).toEqual([{ identity: "person", ghTokenFp: null }]);
    expect(statSync(principalCacheFile(env)).mode & 0o777).toBe(0o600);
    // the cache serves the next call even if the human logs out
    expect(await resolveOnBehalfOf({ ...env, STUB_LOGIN: "" })).toBe("planted-human");
    expect(readFileSync(log, "utf8").split("\n").filter(Boolean)).toHaveLength(1);
  });

  it("a missing on_behalf_of is refused: ConfigError before any mint, no record, no token", async () => {
    const sb = sandbox();
    const fake = fakeGithub({ "2001": AGENT_TOKEN });
    const env = { ...sb.env, AMICO_GH_IDENTITY: "agent", STUB_LOGIN: "" }; // human gh not logged in
    await expect(ensureAgentToken({ env, fetchImpl: fake.impl })).rejects.toThrow(/on_behalf_of/);
    await expect(ensureAgentToken({ env, fetchImpl: fake.impl })).rejects.toBeInstanceOf(ConfigError);
    expect(fake.calls).toHaveLength(0);
    expect(mintLines(sb.appsDir)).toHaveLength(0);
    // and through the shim: exit 64, gh never runs
    expect(await ghShimMain(["pr", "list"], env, undefined, { fetchImpl: fake.impl })).toBe(64);
    expect(existsSync(sb.stubOut)).toBe(false);
    // and the credential helper: silent (never blocks), no token
    expect((await credentialMain("protocol=https\nhost=github.com\n\n", env, "get", { fetchImpl: fake.impl })).stdout).toBe("");
  });

  it("a non-login capture (garbage stdout) is refused too", async () => {
    const sb = sandbox();
    const env = { ...sb.env, AMICO_GH_IDENTITY: "agent", STUB_LOGIN: "not a login; rm -rf" };
    expect(await resolveOnBehalfOf(env)).toBeUndefined();
    expect(existsSync(principalCacheFile(env))).toBe(false);
  });

  it("a cached token is still refused when no principal can be bound", async () => {
    const sb = sandbox();
    writeFileSync(join(sb.appsDir, "agent-token.json"), JSON.stringify({ token: AGENT_TOKEN, expiresAt: new Date(Date.now() + 3600_000).toISOString(), appId: "1001", installationId: "2001" }));
    await expect(ensureAgentToken({ env: { ...sb.env, AMICO_GH_IDENTITY: "agent", STUB_LOGIN: "" } })).rejects.toThrow(/on_behalf_of/);
  });
});

describe("no token bytes in any output, record, or error (planted-token grep)", () => {
  it("mint record, principal cache, stderr/stdout of failure lanes, and error messages never carry the App or human token", async () => {
    const sb = sandbox();
    const fake = fakeGithub({ "2001": AGENT_TOKEN });
    const env = { ...sb.env, AMICO_GH_IDENTITY: "agent" };
    const errs: string[] = [];
    const origErr = console.error;
    const origLog = console.log;
    console.error = (...a: unknown[]) => void errs.push(a.join(" "));
    console.log = (...a: unknown[]) => void errs.push(a.join(" "));
    try {
      await ghShimMain(["pr", "list"], env, undefined, { fetchImpl: fake.impl });
      // failure lanes: a broken PEM after a cache miss, a rejected mint
      writeFileSync(join(sb.appsDir, "agent-token.json"), "{corrupt");
      writeFileSync(sb.agentPem, "-----BEGIN RSA PRIVATE KEY-----\ngarbage\n-----END RSA PRIVATE KEY-----\n");
      await ghShimMain(["pr", "list"], env, undefined, { fetchImpl: fake.impl });
      await credentialMain("protocol=https\nhost=github.com\n\n", env, "get", { fetchImpl: fake.impl });
      try {
        await ensureAgentToken({ env, fetchImpl: fake.impl });
      } catch (e) {
        errs.push(String((e as Error).message), String((e as Error).stack));
      }
    } finally {
      console.error = origErr;
      console.log = origLog;
    }
    const haystacks = [
      ...errs,
      readFileSync(mintsFile(env), "utf8"),
      readFileSync(principalCacheFile(env), "utf8"),
      readFileSync(sb.stubOut, "utf8"),
    ];
    for (const h of haystacks) {
      expect(h.includes(AGENT_TOKEN)).toBe(false); // boolean: a failure never echoes the haystack
      expect(h.includes(PLANTED_HUMAN_TOKEN)).toBe(false);
    }
    // the only App-token-at-rest is the 0600 cache file, by design
    expect(readdirSync(sb.appsDir).sort()).toEqual(["agent-token.json", "agent.json", "agent.pem", "mints.jsonl", "principal.json", "reviewer.json", "reviewer.pem"]);
  });
  it("tokenFingerprint is an 8-hex sha256 prefix", () => {
    expect(tokenFingerprint(AGENT_TOKEN)).toBe(sha8(AGENT_TOKEN));
    expect(tokenFingerprint(AGENT_TOKEN)).toMatch(/^[0-9a-f]{8}$/);
  });
});

describe("scrubbedGhEnv / withAgentGitConfig (pure)", () => {
  it("strips every human token var + GH_CONFIG_DIR/GH_HOST, sets only GH_TOKEN + the private dir", () => {
    const out = scrubbedGhEnv(
      { PATH: "/bin", HOME: "/h", GH_TOKEN: "a", GITHUB_TOKEN: "b", GH_ENTERPRISE_TOKEN: "c", GITHUB_ENTERPRISE_TOKEN: "d", GH_CONFIG_DIR: "/h/.config/gh", GH_HOST: "ghe.example" },
      "ghs_test_x",
      "/tmp/priv",
    );
    expect(out).toEqual({ PATH: "/bin", HOME: "/h", GH_TOKEN: "ghs_test_x", GH_CONFIG_DIR: "/tmp/priv" });
  });
  it("git config env: resets inherited github.com helpers, then registers ours; appends after existing GIT_CONFIG entries", () => {
    expect(withAgentGitConfig({}, "/b/amico-git-credential")).toEqual({
      AMICO_GH_IDENTITY: "agent",
      GIT_CONFIG_COUNT: "2",
      GIT_CONFIG_KEY_0: "credential.https://github.com.helper",
      GIT_CONFIG_VALUE_0: "",
      GIT_CONFIG_KEY_1: "credential.https://github.com.helper",
      GIT_CONFIG_VALUE_1: '!"/b/amico-git-credential"',
    });
    const e = withAgentGitConfig({ GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "core.x", GIT_CONFIG_VALUE_0: "y" }, "/b/h");
    expect(e.GIT_CONFIG_COUNT).toBe("3");
    expect(e.GIT_CONFIG_KEY_0).toBe("core.x");
    expect(e.GIT_CONFIG_VALUE_1).toBe("");
    expect(e.GIT_CONFIG_VALUE_2).toBe('!"/b/h"');
  });
  it("real git: under the agent git env, a planted human credential helper is never consulted", () => {
    // `git credential fill` with a planted "human" global helper that would
    // answer with the human token; the agent env's reset must drop it, so
    // the only helper left is ours (here a stub that answers the App token).
    const sb = sandbox();
    const human = join(sb.root, "human-helper");
    writeFileSync(human, `#!/bin/sh\necho username=planted-human\necho password=${PLANTED_HUMAN_TOKEN}\n`, { mode: 0o755 });
    const ours = join(sb.root, "our-helper");
    writeFileSync(ours, `#!/bin/sh\necho username=x-access-token\necho password=${AGENT_TOKEN}\n`, { mode: 0o755 });
    const gitconfig = join(sb.root, "gitconfig");
    writeFileSync(gitconfig, `[credential]\n\thelper = !${human}\n`);
    const base = { PATH: process.env.PATH ?? "", HOME: sb.humanHome, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: gitconfig, GIT_TERMINAL_PROMPT: "0" };
    const fill = (env: Record<string, string>) =>
      spawnSync("git", ["credential", "fill"], { input: "protocol=https\nhost=github.com\n\n", encoding: "utf8", env }).stdout;
    // Boolean assertions only: a failure must never print credential bytes.
    expect(fill(base).includes(PLANTED_HUMAN_TOKEN)).toBe(true); // control: the human helper answers by default
    const agentOut = fill({ ...base, ...withAgentGitConfig(base, ours) });
    expect(agentOut.includes(`password=${AGENT_TOKEN}`)).toBe(true);
    expect(agentOut.includes(PLANTED_HUMAN_TOKEN)).toBe(false);
  });
});
