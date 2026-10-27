// `amico gh whoami` (#1928, A15): the effective identity — the person's gh
// login, or the agent App slug + the principal it would bind — never a token.
// Plus the bundle-level wiring: the `gh` / `review` routes in dist/amico.js
// and the dist/gh.js shim's person/agent lanes.
import { describe, it, expect, beforeAll } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ghVerb } from "../src/gh_verb.js";
import { fakeGithub, sandbox, sha8, PLANTED_HUMAN_TOKEN } from "./gh_identity_helpers.js";

const AGENT_TOKEN = "ghs_test_AGENT_cached_bundle_42";
const ROOT = join(__dirname, "..");

describe("gh whoami (in-process)", () => {
  it("person (default) → the human's gh login, captured as person", async () => {
    const sb = sandbox();
    const r = await ghVerb(["whoami"], { env: sb.env });
    expect(r.code).toBe(0);
    expect(r.json).toEqual({ identity: "person", login: "planted-human" });
  });
  it("agent → App slug (verified live with the App JWT — no installation token minted) + principal", async () => {
    const sb = sandbox();
    const fake = fakeGithub({ "2001": AGENT_TOKEN });
    const env = { ...sb.env, AMICO_GH_IDENTITY: "agent", AMICO_CAMPAIGN: "camp", AMICO_SESSION_ID: "ses_9" };
    const r = await ghVerb(["whoami"], { env, fetchImpl: fake.impl });
    expect(r.code).toBe(0);
    expect(r.json).toEqual({
      identity: "agent",
      app: { slug: "test-amico-agent", app_id: "1001", installation_id: "2001", verified: true },
      principal: { kind: "agent", on_behalf_of: "planted-human", campaign: "camp", session: "ses_9" },
    });
    expect(fake.calls.map((c) => c.url)).toEqual(["https://api.github.com/app"]);
    expect(fake.calls[0].headers.Authorization.startsWith("Bearer ")).toBe(true);
    expect(existsSync(join(sb.appsDir, "mints.jsonl"))).toBe(false); // whoami never mints
  });
  it("agent with no on_behalf_of → exit 1, writes reported refused", async () => {
    const sb = sandbox();
    const fake = fakeGithub({});
    const r = await ghVerb(["whoami"], { env: { ...sb.env, AMICO_GH_IDENTITY: "agent", STUB_LOGIN: "" }, fetchImpl: fake.impl });
    expect(r.code).toBe(1);
    expect(r.json).toMatchObject({ identity: "agent", principal: { on_behalf_of: null }, writes: expect.stringMatching(/refused.*on_behalf_of/) });
  });
  it("--offline skips the live check (verified:false)", async () => {
    const sb = sandbox();
    const fake = fakeGithub({});
    const r = await ghVerb(["whoami", "--offline"], { env: { ...sb.env, AMICO_GH_IDENTITY: "agent" }, fetchImpl: fake.impl });
    expect(r.json).toMatchObject({ app: { slug: "test-amico-agent", verified: false } });
    expect(fake.calls).toHaveLength(0);
  });
  it("unknown subcommand → 64", async () => {
    expect((await ghVerb(["pr"], { env: {} })).code).toBe(64);
  });
});

describe("bundles: dist/amico.js routes + dist/gh.js lanes", () => {
  beforeAll(() => {
    execFileSync("node", [join(ROOT, "esbuild.config.mjs")], { cwd: ROOT });
  });
  /** A spawn env with every engine-session / identity marker removed, so the
   *  suite behaves the same inside or outside an engine session. */
  function cleanEnv(extra: Record<string, string>): Record<string, string> {
    const e: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env))
      // …and every developer *TOKEN* var (e.g. a provider key), so the
      // tokenish assertion sees only what the shim itself injects.
      if (v !== undefined && !/^(OPENCODE|AMICO_GH_IDENTITY|AMICO_SESSION_ID|AMICO_GITHUB|GH_|GITHUB_)/.test(k) && !/TOKEN/.test(k)) e[k] = v;
    return { ...e, AMICO_CLI_FROM_CHECKOUT: "1", ...extra };
  }
  it("`amico gh whoami` routes (person lane) and prints no token", () => {
    const sb = sandbox();
    const r = spawnSync("node", [join(ROOT, "dist", "amico.js"), "gh", "whoami"], { encoding: "utf8", env: cleanEnv(sb.env) });
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual({ identity: "person", login: "planted-human" });
    expect((r.stdout + r.stderr).includes(PLANTED_HUMAN_TOKEN)).toBe(false);
  });
  it("`amico review post-check` routes and refuses inside an engine session", () => {
    const sb = sandbox();
    const vf = join(sb.root, "v.json");
    writeFileSync(vf, JSON.stringify({ verdict: "neutral", receipt_id: "p" }));
    const r = spawnSync(
      "node",
      [join(ROOT, "dist", "amico.js"), "review", "post-check", "--repo", "o/r", "--sha", "0".repeat(40), "--name", "reviewer-pass", "--verdict", vf],
      { encoding: "utf8", env: cleanEnv({ ...sb.env, OPENCODE: "1" }) },
    );
    expect(r.status).toBe(64);
    expect(r.stdout).toMatch(/engine session/);
  });
  it("dist/gh.js: config present + identity unset → person passthrough; agent + fresh cache → scrubbed child with the App token", () => {
    const sb = sandbox();
    writeFileSync(
      join(sb.appsDir, "agent-token.json"),
      JSON.stringify({ token: AGENT_TOKEN, expiresAt: new Date(Date.now() + 3600_000).toISOString(), appId: "1001", installationId: "2001" }),
    );
    writeFileSync(join(sb.appsDir, "principal.json"), JSON.stringify({ on_behalf_of: "planted-human", captured_at: new Date().toISOString(), source: "gh api user" }));
    const person = spawnSync("node", [join(ROOT, "dist", "gh.js"), "pr", "list"], { encoding: "utf8", env: cleanEnv(sb.env) });
    expect(person.status).toBe(7);
    const p = JSON.parse(readFileSync(sb.stubOut, "utf8"));
    expect(p.ghConfigDir).toBe(sb.humanGhDir);
    expect(p.ghTokenFp).toBeNull();
    const agent = spawnSync("node", [join(ROOT, "dist", "gh.js"), "pr", "list"], { encoding: "utf8", env: cleanEnv({ ...sb.env, AMICO_GH_IDENTITY: "agent" }) });
    expect(agent.status).toBe(7);
    const a = JSON.parse(readFileSync(sb.stubOut, "utf8"));
    expect(a.ghTokenFp).toBe(sha8(AGENT_TOKEN));
    expect(a.tokenish).toEqual(["GH_TOKEN"]);
    expect(a.hostsYml).toBeNull();
    expect((agent.stdout + agent.stderr).includes(AGENT_TOKEN)).toBe(false);
  });
});
