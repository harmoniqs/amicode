// packages/amico-run/launcher/* — the pinned-source resolution order (#1666).
//
// The hazard (observed 2026-09-25): the ~/.local/bin/amico shims are symlinks
// into a MOVING checkout, and one served a stale side-checkout on an old branch
// for weeks — every ops job silently ran months-old code. The launchers now
// resolve a PINNED dist root FIRST; the checkout dist beside the launcher is
// the pre-pin fallback and the target of the EXPLICIT dev override
// (AMICO_CLI_FROM_CHECKOUT=1 — never implicit).
//
// Hermetic by construction: a stub `node` earlier on PATH prints the dist path
// it was exec'd with (the resolution IS the unit under test — no real bundle,
// no build, no network). Table: pin present/absent × override on/off.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const REPO = resolve(import.meta.dirname, "..", "..", "..");
const LAUNCHER_DIR = join(REPO, "packages", "amico-run", "launcher");
// every declared bin (package.json "bin" + the gh shadowBin) shares one body —
// the resolution contract must hold for all of them, not just the named pair.
const LAUNCHERS = ["amico", "amico-pasqal", "amico-git-credential", "gh"];

let work: string;

beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), "launcher-res-"));
  mkdirSync(join(work, "bin"));
  // the stub node: prints the dist path the launcher exec'd ($1), ignores argv.
  writeFileSync(join(work, "bin", "node"), "#!/bin/sh\nprintf '%s\\n' \"$1\"\n");
  chmodSync(join(work, "bin", "node"), 0o755);
});
afterEach(() => rmSync(work, { recursive: true, force: true }));

function pin(name: string, root = join(work, "pin")): string {
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, `${name}.js`), `stub ${name} bundle\n`);
  return root;
}

function runLauncher(name: string, opts: { pinRoot?: string; fromCheckout?: boolean; noPinEnv?: boolean } = {}): {
  code: number;
  stdout: string;
  stderr: string;
} {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: work, // hermetic: the default ~/.amico/server/cli resolves under the tmp HOME
    PATH: `${join(work, "bin")}:${process.env.PATH}`,
  };
  if (!opts.noPinEnv) env.AMICO_CLI_PIN_ROOT = opts.pinRoot ?? join(work, "pin");
  if (opts.fromCheckout) env.AMICO_CLI_FROM_CHECKOUT = "1";
  const r = spawnSync("bash", [join(LAUNCHER_DIR, name)], { encoding: "utf8", timeout: 30_000, env });
  return { code: r.status ?? -1, stdout: (r.stdout ?? "").trim(), stderr: r.stderr ?? "" };
}

const checkoutDist = (name: string) => join(REPO, "packages", "amico-run", "dist", `${name}.js`);

// ── #1667: the amico-run bin deletion — the launcher dir's exact set ─────────
// The bin's consumers moved to `amico run` (the documented ≡ delegation); the
// launcher dir must hold exactly the sanctioned remainder — a resurrected or
// leftover amico-run shim on the PATH would silently serve stale physics.
describe("the launcher set (#1667 — the amico-run bin is deleted)", () => {
  it("launcher/ holds exactly the sanctioned bins — no amico-run", () => {
    expect(readdirSync(LAUNCHER_DIR).sort()).toEqual([
      "amico",
      "amico-git-credential",
      "amico-pasqal",
      "gh",
    ]);
  });
});

describe("launcher source resolution (#1666)", () => {
  it("resolves the PINNED dist root before the checkout (pin present, override off) — the checkout's state cannot change what runs", () => {
    const root = pin("amico");
    const r = runLauncher("amico", { pinRoot: root });
    expect(r.code).toBe(0);
    expect(r.stdout).toBe(join(root, "amico.js"));
  });

  it("AMICO_CLI_FROM_CHECKOUT=1 is the explicit dev override: flips to the checkout dist even with the pin present (never implicit)", () => {
    const root = pin("amico");
    const r = runLauncher("amico", { pinRoot: root, fromCheckout: true });
    expect(r.code).toBe(0);
    expect(r.stdout).toBe(`${LAUNCHER_DIR}/../dist/amico.js`);
  });

  it("pin ABSENT + override off: falls back to the checkout dist (the pre-pin legacy behavior)", () => {
    const r = runLauncher("amico", { pinRoot: join(work, "pin") });
    expect(r.code).toBe(0);
    expect(r.stdout).toBe(`${LAUNCHER_DIR}/../dist/amico.js`);
  });

  it("pin ABSENT + override on: the checkout dist (the override is a no-op when there is no pin)", () => {
    const r = runLauncher("amico", { pinRoot: join(work, "pin"), fromCheckout: true });
    expect(r.code).toBe(0);
    expect(r.stdout).toBe(`${LAUNCHER_DIR}/../dist/amico.js`);
  });

  it("the default pin root is ~/.amico/server/cli (no AMICO_CLI_PIN_ROOT env set)", () => {
    const root = pin("amico", join(work, ".amico", "server", "cli"));
    const r = runLauncher("amico", { noPinEnv: true });
    expect(r.code).toBe(0);
    expect(r.stdout).toBe(join(root, "amico.js"));
  });

  it("every declared bin launcher resolves its pinned bundle first (one body, four shims — gh, pasqal, git-credential included)", () => {
    for (const name of LAUNCHERS) {
      const root = pin(name);
      const r = runLauncher(name, { pinRoot: root });
      expect(r.code, name).toBe(0);
      expect(r.stdout, name).toBe(join(root, `${name}.js`));
    }
  });

  it("an INCOMPLETE pin (root present, this bin's bundle missing) degrades to the checkout, not to a dead shim", () => {
    const root = pin("amico-pasqal"); // pin holds amico-pasqal.js but not amico.js
    const r = runLauncher("amico", { pinRoot: root });
    expect(r.code).toBe(0);
    expect(r.stdout).toBe(`${LAUNCHER_DIR}/../dist/amico.js`);
  });
});
