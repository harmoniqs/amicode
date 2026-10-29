// notturno_gates.test.ts — the night runner's pre-push gate (#1980,
// `.notturno/gates` at the repo root; harmoniqs/amicissimo
// automation/notturno/runner/night-run.sh executes it with cwd = repo root).
//
// Batch 1 (2026-10-28) pushed 6/8 red night PRs; 2 were app-bundle drift-gate
// reds — overlay edits committed without `refresh_manifest.mjs`. This suite
// proves the gate catches exactly that, against a FIXTURE repo (a throwaway
// git repo carrying the real gates script + the real drift/refresh scripts and
// a tiny overlay), so the proof never mutates this checkout:
//   - a fixture overlay edit WITHOUT a manifest refresh → gates exit non-zero,
//     the summary (last line, what the runner surfaces) names the drift step;
//   - after refresh_manifest → the drift step is green again;
//   - this repo's committed tree passes the drift step;
//   - the base / touched-package plan resolves NOTTURNO_BASE, else the nearest
//     origin/lane/* (or origin/main), and maps the diff to vitest packages.
import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const REPO = join(__dirname, "..", "..", "..");
const GATES = join(REPO, ".notturno", "gates");
const DRIFT = join(REPO, "packages", "app-bundle", "scripts", "drift_gate.mjs");
const REFRESH = join(REPO, "packages", "app-bundle", "scripts", "refresh_manifest.mjs");

type Run = { status: number | null; stdout: string; stderr: string; out: string };

function run(cmd: string, args: string[], cwd: string, env: Record<string, string> = {}): Run {
  const r = spawnSync(cmd, args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, NOTTURNO_BASE: "", ...env },
    timeout: 120_000,
  });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, out: `${r.stdout}\n${r.stderr}` };
}

const git = (cwd: string, ...args: string[]) => {
  const r = run("git", args, cwd);
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
  return r.stdout.trim();
};

const lastLine = (s: string) => s.trimEnd().split("\n").at(-1) ?? "";

function put(root: string, rel: string, content: string) {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), content);
}

/** A throwaway repo with the real gate scripts and a 2-file overlay whose manifest is in sync. */
function makeFixture(): string {
  const root = mkdtempSync(join(tmpdir(), "notturno-gates-fx-"));
  const up = join(root, "..", `${root.split("/").at(-1)}-upstream`);
  mkdirSync(up, { recursive: true });
  writeFileSync(join(up, "package.json"), "{}\n");
  mkdirSync(join(root, ".notturno"), { recursive: true });
  copyFileSync(GATES, join(root, ".notturno", "gates"));
  mkdirSync(join(root, "packages", "app-bundle", "scripts"), { recursive: true });
  copyFileSync(DRIFT, join(root, "packages", "app-bundle", "scripts", "drift_gate.mjs"));
  copyFileSync(REFRESH, join(root, "packages", "app-bundle", "scripts", "refresh_manifest.mjs"));
  put(root, "packages/app-bundle/overlay/packages/opencode/src/a.ts", "export const a = 1;\n");
  put(root, "packages/app-bundle/overlay/packages/session-ui/src/b.ts", "export const b = 2;\n");
  put(root, "packages/app-bundle/manifest.json", JSON.stringify({ upstream_base: "fixture", files: {} }) + "\n");
  put(root, "packages/foo/package.json", JSON.stringify({ name: "foo", scripts: { test: "vitest run" } }) + "\n");
  put(root, "packages/foo/src/x.ts", "export const x = 1;\n");
  put(root, "packages/bar/package.json", JSON.stringify({ name: "bar", scripts: { test: "vitest run" } }) + "\n");
  put(root, "packages/bar/src/y.ts", "export const y = 1;\n");
  const refreshed = run("node", ["packages/app-bundle/scripts/refresh_manifest.mjs", "--upstream", up], root);
  if (refreshed.status !== 0) throw new Error(`fixture refresh failed: ${refreshed.out}`);
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.email", "fx@example.invalid");
  git(root, "config", "user.name", "fx");
  git(root, "config", "commit.gpgsign", "false");
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "fixture base");
  return root;
}

const upstreamOf = (root: string) => join(root, "..", `${root.split("/").at(-1)}-upstream`);

describe(".notturno/gates — the night runner's pre-push gate (#1980)", () => {
  let fx: string;
  beforeEach(() => {
    fx = makeFixture();
  });
  afterEach(() => {
    rmSync(fx, { recursive: true, force: true });
    rmSync(upstreamOf(fx), { recursive: true, force: true });
  });

  test("exists at the repo root and is executable (the runner checks `-x`)", () => {
    expect(existsSync(GATES)).toBe(true);
    expect(statSync(GATES).mode & 0o111).not.toBe(0);
  });

  test("an in-sync fixture overlay passes the drift step", () => {
    const r = run("./.notturno/gates", [], fx, { NOTTURNO_GATES_STEPS: "drift" });
    expect(r.status, r.out).toBe(0);
    expect(lastLine(r.stdout)).toMatch(/GREEN/);
  });

  test("a fixture overlay edit WITHOUT a manifest refresh fails the gates at the drift step", () => {
    appendFileSync(join(fx, "packages/app-bundle/overlay/packages/opencode/src/a.ts"), "export const hand = 'edit';\n");
    git(fx, "commit", "-q", "-am", "overlay edit, no refresh");
    const r = run("./.notturno/gates", [], fx, { NOTTURNO_GATES_STEPS: "drift" });
    expect(r.status, r.out).not.toBe(0);
    expect(r.out).toMatch(/hash mismatch/);
    const summary = lastLine(r.stdout);
    expect(summary).toMatch(/RED/);
    expect(summary).toMatch(/drift/);
    expect(summary).toMatch(/refresh_manifest/); // tells the implementer the fix
  });

  test("a stray (unmanifested) overlay file also fails; refresh_manifest then turns the drift step green", () => {
    put(fx, "packages/app-bundle/overlay/packages/opencode/src/new.ts", "export const n = 1;\n");
    const red = run("./.notturno/gates", [], fx, { NOTTURNO_GATES_STEPS: "drift" });
    expect(red.status, red.out).not.toBe(0);
    expect(red.out).toMatch(/stray files/);
    const refreshed = run("node", ["packages/app-bundle/scripts/refresh_manifest.mjs", "--upstream", upstreamOf(fx)], fx);
    expect(refreshed.status, refreshed.out).toBe(0);
    const green = run("./.notturno/gates", [], fx, { NOTTURNO_GATES_STEPS: "drift" });
    expect(green.status, green.out).toBe(0);
  });

  test("an unknown step name is a hard failure, never a silent green", () => {
    const r = run("./.notturno/gates", [], fx, { NOTTURNO_GATES_STEPS: "drfit" });
    expect(r.status, r.out).not.toBe(0);
  });

  describe("--plan: base resolution + touched packages", () => {
    beforeEach(() => {
      // origin/main = the fixture base; origin/lane/0.0.2 one commit ahead (touches bar);
      // origin/lane/0.0.1 = an older, unrelated train cut from main.
      const base = git(fx, "rev-parse", "HEAD");
      git(fx, "update-ref", "refs/remotes/origin/main", base);
      git(fx, "update-ref", "refs/remotes/origin/lane/0.0.1", base);
      put(fx, "packages/bar/src/y.ts", "export const y = 2;\n");
      git(fx, "commit", "-q", "-am", "lane commit touching bar");
      git(fx, "update-ref", "refs/remotes/origin/lane/0.0.2", git(fx, "rev-parse", "HEAD"));
      git(fx, "checkout", "-q", "-b", "night/fx-1");
      put(fx, "packages/foo/src/x.ts", "export const x = 2;\n");
      git(fx, "commit", "-q", "-am", "night commit touching foo");
    });

    test("no NOTTURNO_BASE → the nearest origin/lane/* wins; only the diff's packages are selected", () => {
      const r = run("./.notturno/gates", ["--plan"], fx);
      expect(r.status, r.out).toBe(0);
      expect(r.stdout).toMatch(/base: origin\/lane\/0\.0\.2\b/);
      expect(r.stdout).toMatch(/vitest packages: foo$/m);
    });

    test("NOTTURNO_BASE overrides (bare branch name resolves via origin/)", () => {
      const r = run("./.notturno/gates", ["--plan"], fx, { NOTTURNO_BASE: "main" });
      expect(r.status, r.out).toBe(0);
      expect(r.stdout).toMatch(/base: origin\/main\b/);
      expect(r.stdout).toMatch(/vitest packages: bar foo$/m);
    });

    test("uncommitted + untracked changes count as touched", () => {
      put(fx, "packages/bar/src/z.ts", "export const z = 1;\n");
      const r = run("./.notturno/gates", ["--plan"], fx);
      expect(r.status, r.out).toBe(0);
      expect(r.stdout).toMatch(/vitest packages: bar foo$/m);
    });

    test("an unresolvable base falls back to every package (never a silent empty selection)", () => {
      for (const ref of ["origin/main", "origin/lane/0.0.1", "origin/lane/0.0.2"]) git(fx, "update-ref", "-d", `refs/remotes/${ref}`);
      const r = run("./.notturno/gates", ["--plan"], fx, { NOTTURNO_BASE: "nope/nothing" });
      expect(r.status, r.out).toBe(0);
      expect(r.stdout).toMatch(/vitest packages: bar foo$/m);
    });
  });
});

// #2007: in the Modal sandbox the extension/amico-run vitest steps went red
// whatever the diff, and the summary hid which tests. The vitest steps must run
// the way CI's `fast` job does (CI=true, GITHUB_ACTIONS=true, an empty runner
// HOME, no ambient secrets/dev-shell env), and a red suite must name its
// failing files in the RESULT line (the runner surfaces only the last lines).
describe(".notturno/gates — vitest steps mirror CI and name failing files (#2007)", () => {
  let fx: string;
  const VITEST_PKG = join(REPO, "packages", "amico-run", "node_modules", "vitest");

  /** give a fixture package a real vitest (symlinked from this checkout) */
  function linkVitest(pkg: string) {
    const nm = join(fx, "packages", pkg, "node_modules");
    mkdirSync(join(nm, ".bin"), { recursive: true });
    symlinkSync(VITEST_PKG, join(nm, "vitest"));
    symlinkSync(join(VITEST_PKG, "vitest.mjs"), join(nm, ".bin", "vitest"));
  }

  beforeEach(() => {
    fx = makeFixture();
    linkVitest("foo");
    linkVitest("bar");
  });
  afterEach(() => {
    rmSync(fx, { recursive: true, force: true });
    rmSync(upstreamOf(fx), { recursive: true, force: true });
  });

  test("the vitest step runs under CI's env: CI=true, GITHUB_ACTIONS=true, a scratch empty HOME, ambient secrets scrubbed", () => {
    const outerHome = process.env.HOME ?? "";
    put(fx, "packages/foo/test/env.test.ts", [
      `import { test, expect } from "vitest";`,
      `import { existsSync, readdirSync } from "node:fs";`,
      `import { join } from "node:path";`,
      `test("ci env", () => {`,
      `  expect(process.env.CI).toBe("true");`,
      `  expect(process.env.GITHUB_ACTIONS).toBe("true");`,
      `  const home = process.env.HOME ?? "";`,
      `  expect(home).not.toBe(${JSON.stringify(outerHome)});`,
      `  expect(home).not.toBe("");`,
      `  expect(existsSync(join(home, ".amico"))).toBe(false);`,
      `  expect(existsSync(join(home, ".config", "opencode"))).toBe(false);`,
      `  expect(readdirSync(home)).toEqual([]);`,
      `  expect(process.env.AWS_SECRET_ACCESS_KEY).toBeUndefined();`,
      `  expect(process.env.GH_TOKEN).toBeUndefined();`,
      `  expect(process.env.AMICO_LEAK).toBeUndefined();`,
      `  expect(process.env.NOTTURNO_ISSUE).toBeUndefined();`,
      `});`,
      ``,
    ].join("\n"));
    const r = run("./.notturno/gates", [], fx, {
      NOTTURNO_GATES_STEPS: "vitest",
      AWS_SECRET_ACCESS_KEY: "leak",
      GH_TOKEN: "ghp_leak",
      AMICO_LEAK: "1",
      NOTTURNO_ISSUE: "2007",
    });
    expect(r.status, r.out).toBe(0);
    expect(r.out).toMatch(/1 passed/);
    expect(lastLine(r.stdout)).toMatch(/GREEN/);
  });

  test("a red suite names its failing test files (first 5) in the RESULT line", () => {
    for (const n of ["a", "b", "c", "d", "e", "f", "g"]) {
      put(fx, `packages/foo/test/${n}.test.ts`, `import { test, expect } from "vitest";\ntest("${n}", () => { expect(1).toBe(2); });\n`);
    }
    put(fx, "packages/foo/test/ok.test.ts", `import { test, expect } from "vitest";\ntest("ok", () => { expect(1).toBe(1); });\n`);
    put(fx, "packages/bar/test/bad.test.ts", `import { test, expect } from "vitest";\ntest("bad", () => { expect(1).toBe(2); });\n`);
    const r = run("./.notturno/gates", [], fx, { NOTTURNO_GATES_STEPS: "vitest" });
    expect(r.status, r.out).not.toBe(0);
    const summary = lastLine(r.stdout);
    expect(summary).toMatch(/RED/);
    expect(summary).toContain("vitest:foo [test/a.test.ts, test/b.test.ts, test/c.test.ts, test/d.test.ts, test/e.test.ts, +2 more]");
    expect(summary).toContain("vitest:bar [test/bad.test.ts]");
    expect(summary).not.toContain("ok.test.ts");
  });
});

describe("this repo's committed tree", () => {
  test("AGENTS.md's verification-gates section teaches the overlay rule: refresh_manifest, then drift_gate, before commit", () => {
    const agents = readFileSync(join(REPO, "AGENTS.md"), "utf8");
    const section = agents.split(/^## Verification gates/m)[1]?.split(/^## /m)[0] ?? "";
    expect(section).toMatch(/packages\/app-bundle\/overlay\/\*\*/);
    expect(section).toMatch(/node packages\/app-bundle\/scripts\/refresh_manifest\.mjs/);
    expect(section).toMatch(/node packages\/app-bundle\/scripts\/drift_gate\.mjs/);
    expect(section).toMatch(/\.notturno\/gates/);
  });

  test("passes the gates' drift step", () => {
    const r = run(GATES, [], REPO, { NOTTURNO_GATES_STEPS: "drift" });
    expect(r.status, r.out).toBe(0);
    expect(lastLine(r.stdout)).toMatch(/GREEN/);
  });
});
