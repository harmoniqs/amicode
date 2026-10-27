// Shared fixtures for the A15 identity tests (#1928). Everything is throwaway:
// RSA keys are generated in-process (testKeyPair), tokens are obvious fakes,
// and every path lives under a fresh tmp dir — the developer's real
// ~/.amico/github-apps is never read (AMICO_GITHUB_APPS_DIR always points
// into the sandbox).
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { testKeyPair, type FetchImpl } from "../src/github_app.js";
import { tmpRoot } from "./helpers.js";

export const sha8 = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 8);

/** A fake "real gh": answers `api user` with $STUB_LOGIN (the human's login
 *  capture), otherwise records what it SAW — emulating gh's own config-dir
 *  resolution (GH_CONFIG_DIR → $XDG_CONFIG_HOME/gh → ~/.config/gh) and trying
 *  to read hosts.yml there — into $STUB_OUT. Tokens are recorded only as
 *  8-hex fingerprints, so the observation file itself carries no token bytes. */
export function stubGh(dir: string): string {
  const bin = join(dir, "gh");
  writeFileSync(
    bin,
    `#!/usr/bin/env node
const fs = require("fs"), path = require("path"), crypto = require("crypto");
const e = process.env;
const fp = (s) => crypto.createHash("sha256").update(s).digest("hex").slice(0, 8);
const a = process.argv.slice(2);
if (a[0] === "api" && a[1] === "user") {
  if (e.STUB_LOGIN_LOG) fs.appendFileSync(e.STUB_LOGIN_LOG, JSON.stringify({ identity: e.AMICO_GH_IDENTITY ?? null, ghTokenFp: e.GH_TOKEN ? fp(e.GH_TOKEN) : null }) + "\\n");
  if (e.STUB_LOGIN) { console.log(e.STUB_LOGIN); process.exit(0); }
  console.error("gh: not logged in"); process.exit(4);
}
const cfg = e.GH_CONFIG_DIR || (e.XDG_CONFIG_HOME ? path.join(e.XDG_CONFIG_HOME, "gh") : path.join(e.HOME || "/nonexistent", ".config", "gh"));
let hostsYml = null; try { hostsYml = fs.readFileSync(path.join(cfg, "hosts.yml"), "utf8"); } catch {}
let configEntries = null; try { configEntries = fs.readdirSync(cfg); } catch {}
let configMode = null; try { configMode = fs.statSync(cfg).mode & 0o777; } catch {}
const tokenish = Object.keys(e).filter((k) => /TOKEN/.test(k));
if (e.STUB_OUT) fs.writeFileSync(e.STUB_OUT, JSON.stringify({
  argv: a, ghTokenFp: e.GH_TOKEN ? fp(e.GH_TOKEN) : null, tokenish,
  ghConfigDir: e.GH_CONFIG_DIR ?? null, configEntries, configMode, hostsYml,
  identity: e.AMICO_GH_IDENTITY ?? null,
  envValues: Object.entries(e).filter(([k]) => !/TOKEN/.test(k)).map(([, v]) => v),
}));
process.exit(7);
`,
  );
  chmodSync(bin, 0o755);
  return bin;
}

export interface Sandbox {
  root: string;
  appsDir: string;
  binDir: string;
  stubOut: string;
  humanHome: string;
  humanGhDir: string;
  agentPem: string;
  reviewerPem: string;
  /** Env for the agent lane: apps dir in the sandbox, stub gh first on PATH. */
  env: Record<string, string>;
}

/** The planted human gh login token — only ever inside the planted hosts.yml
 *  / parent env; any appearance in a child, record, or output is a leak. */
export const PLANTED_HUMAN_TOKEN = "gho_test_PLANTED_HUMAN_0123456789";

export function sandbox(opts: { agentJson?: boolean; reviewerJson?: boolean } = {}): Sandbox {
  const root = tmpRoot();
  const appsDir = join(root, "github-apps");
  mkdirSync(appsDir, { recursive: true, mode: 0o700 });
  const binDir = join(root, "bin");
  mkdirSync(binDir, { recursive: true });
  stubGh(binDir);
  const agentPem = join(appsDir, "agent.pem");
  const reviewerPem = join(appsDir, "reviewer.pem");
  writeFileSync(agentPem, testKeyPair().privateKeyPem, { mode: 0o600 });
  writeFileSync(reviewerPem, testKeyPair().privateKeyPem, { mode: 0o600 });
  if (opts.agentJson !== false)
    writeFileSync(
      join(appsDir, "agent.json"),
      JSON.stringify({ app_id: "1001", slug: "test-amico-agent", installation_id: "2001", pem_path: agentPem }),
    );
  if (opts.reviewerJson !== false)
    writeFileSync(
      join(appsDir, "reviewer.json"),
      JSON.stringify({ app_id: "1002", slug: "test-amico-reviewer", installation_id: "2002", pem_path: reviewerPem }),
    );
  // The planted HUMAN gh login: a hosts.yml in the human's config dir.
  const humanHome = join(root, "home");
  const humanGhDir = join(humanHome, ".config", "gh");
  mkdirSync(humanGhDir, { recursive: true });
  writeFileSync(join(humanGhDir, "hosts.yml"), `github.com:\n    user: planted-human\n    oauth_token: ${PLANTED_HUMAN_TOKEN}\n`);
  const stubOut = join(root, "stub-out.json");
  const env: Record<string, string> = {
    PATH: `${binDir}:${process.env.PATH ?? ""}`,
    HOME: humanHome,
    GH_CONFIG_DIR: humanGhDir,
    GITHUB_TOKEN: PLANTED_HUMAN_TOKEN,
    AMICO_GITHUB_APPS_DIR: appsDir,
    STUB_OUT: stubOut,
    STUB_LOGIN: "planted-human",
  };
  return { root, appsDir, binDir, stubOut, humanHome, humanGhDir, agentPem, reviewerPem, env };
}

export interface FakeFetch {
  calls: { url: string; method: string; headers: Record<string, string>; body?: string }[];
  impl: FetchImpl;
}

/** Fake GitHub: access_tokens → 201 {token}; check-runs → 201; /app → slug. */
export function fakeGithub(tokens: Record<string, string>, opts: { checkRunStatus?: number; errorBody?: unknown } = {}): FakeFetch {
  const calls: FakeFetch["calls"] = [];
  const impl: FetchImpl = async (url, init) => {
    calls.push({ url, method: init.method, headers: init.headers, body: init.body });
    const m = url.match(/\/app\/installations\/(\d+)\/access_tokens$/);
    if (m) {
      const token = tokens[m[1]];
      if (!token) return { status: 404, json: async () => ({ message: "Not Found" }) };
      return { status: 201, json: async () => ({ token, expires_at: new Date(Date.now() + 3600_000).toISOString() }) };
    }
    if (url.endsWith("/check-runs")) {
      const st = opts.checkRunStatus ?? 201;
      if (st !== 201) return { status: st, json: async () => opts.errorBody ?? { message: "nope" } };
      return { status: 201, json: async () => ({ id: 4242, html_url: "https://github.com/o/r/runs/4242" }) };
    }
    if (url === "https://api.github.com/app") return { status: 200, json: async () => ({ slug: "test-amico-agent" }) };
    return { status: 500, json: async () => ({}) };
  };
  return { calls, impl };
}
