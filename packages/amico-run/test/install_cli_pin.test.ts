// ops/install-cli-pin.sh — the CLI pin-installer (#1666), exercised end to end
// with hermetic dist + root dirs (no HOME writes, no network). The contract is
// the papers-digest frozen-bundle convention (ops/README.md) applied to the
// CLI itself: copy the built dist bundles to the pinned root the launchers
// resolve first, and write a shasum-format sha256 sidecar beside each — the
// sidecar is what `amico doctor` compares for freshness.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const REPO = resolve(import.meta.dirname, "..", "..", "..");
const INSTALLER = join(REPO, "ops", "install-cli-pin.sh");

let work: string;
let dist: string;
let root: string;

beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), "cli-pin-"));
  dist = join(work, "dist");
  root = join(work, "pin");
  mkdirSync(dist);
});
afterEach(() => rmSync(work, { recursive: true, force: true }));

function writeDist(name: string, content: string): void {
  writeFileSync(join(dist, name), content);
}

function runInstaller(args: string[], env: Record<string, string> = {}): { code: number; stdout: string; stderr: string } {
  const r = spawnSync("bash", [INSTALLER, ...args], {
    encoding: "utf8",
    timeout: 30_000,
    env: { ...process.env, HOME: work, ...env },
  });
  return { code: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

const sha256hex = (content: string) => createHash("sha256").update(content, "utf8").digest("hex");

describe("ops/install-cli-pin.sh — the frozen-bundle pin-installer (#1666)", () => {
  it("copies every dist bundle to the pinned root and writes a shasum-format sha256 sidecar beside each", () => {
    writeDist("amico.js", "stub router bundle A\n");
    writeDist("amico-pasqal.js", "stub runner bundle B\n");
    const r = runInstaller(["--dist", dist, "--root", root]);
    expect(r.code).toBe(0);
    expect(readFileSync(join(root, "amico.js"), "utf8")).toBe("stub router bundle A\n");
    expect(readFileSync(join(root, "amico-pasqal.js"), "utf8")).toBe("stub runner bundle B\n");
    // the papers-digest convention: `shasum -a 256 amico.js > amico.js.sha256`
    // → "<hex>  <name>\n" (two spaces), hex == the copied file's sha256.
    expect(readFileSync(join(root, "amico.js.sha256"), "utf8")).toBe(`${sha256hex("stub router bundle A\n")}  amico.js\n`);
    expect(readFileSync(join(root, "amico-pasqal.js.sha256"), "utf8")).toBe(
      `${sha256hex("stub runner bundle B\n")}  amico-pasqal.js\n`,
    );
  });

  it("copies ONLY the *.js bundles — sourcemaps and other dist artifacts never ride the pin", () => {
    writeDist("amico.js", "router\n");
    writeDist("amico.js.map", '{"sourcemap": true}\n');
    writeDist("notes.txt", "not a bundle\n");
    const r = runInstaller(["--dist", dist, "--root", root]);
    expect(r.code).toBe(0);
    expect(existsSync(join(root, "amico.js.map"))).toBe(false);
    expect(existsSync(join(root, "notes.txt"))).toBe(false);
    expect(existsSync(join(root, "amico.js.sha256"))).toBe(true);
  });

  it("installs the bundles executable (node needs no +x on the script, but the frozen-bundle convention ships them 0755)", () => {
    writeDist("amico.js", "router\n");
    expect(runInstaller(["--dist", dist, "--root", root]).code).toBe(0);
    const st = statSync(join(root, "amico.js"));
    expect(st.mode & 0o111).toBe(0o111);
  });

  it("refuses an empty dist (never pins a hollow root) and a missing dist dir", () => {
    const empty = runInstaller(["--dist", dist, "--root", root]);
    expect(empty.code).not.toBe(0);
    expect(empty.stderr).toMatch(/no \*\.js bundles/);
    const missing = runInstaller(["--dist", join(work, "no-such-dist"), "--root", root]);
    expect(missing.code).not.toBe(0);
  });

  it("requires --dist explicitly (never builds, never guesses a checkout)", () => {
    const r = runInstaller(["--root", root]);
    expect(r.code).not.toBe(0);
    expect(r.stderr).toMatch(/--dist is required/);
  });

  it("re-running refreshes bundle + sidecar in place (idempotent, the upgrade path)", () => {
    writeDist("amico.js", "router v1\n");
    expect(runInstaller(["--dist", dist, "--root", root]).code).toBe(0);
    writeDist("amico.js", "router v2\n");
    expect(runInstaller(["--dist", dist, "--root", root]).code).toBe(0);
    expect(readFileSync(join(root, "amico.js"), "utf8")).toBe("router v2\n");
    expect(readFileSync(join(root, "amico.js.sha256"), "utf8")).toBe(`${sha256hex("router v2\n")}  amico.js\n`);
  });

  it("--root defaults to AMICO_CLI_PIN_ROOT (the launcher's own root env — installer and launchers never diverge)", () => {
    writeDist("amico.js", "router\n");
    const envRoot = join(work, "env-pin");
    const r = runInstaller(["--dist", dist], { AMICO_CLI_PIN_ROOT: envRoot });
    expect(r.code).toBe(0);
    expect(readFileSync(join(envRoot, "amico.js"), "utf8")).toBe("router\n");
  });
});
